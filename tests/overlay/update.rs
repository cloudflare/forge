//! Tests for the `update` action (rules B1-B5 and C1-C2):
//! deep merge on object targets, append on array targets, scalar overwrite,
//! and preservation of untouched siblings.

use crate::common::apply;

/// B1. `update` on an object target adds new properties that were not there.
#[test]
fn update_on_object_adds_new_property() {
    let doc = apply(
        "b1-add-new-property",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    assert_eq!(doc["info"]["description"], "d");
    assert_eq!(doc["info"]["title"], "t", "existing properties are untouched");
    assert_eq!(doc["info"]["version"], "1");
}

/// B2. `update` on an object target overwrites existing scalar properties.
#[test]
fn update_overwrites_existing_scalar() {
    let doc = apply(
        "b2-overwrite-scalar",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"version": "2"}}]
}"#,
    );

    assert_eq!(doc["info"]["version"], "2");
    assert_eq!(doc["info"]["title"], "t");
}

/// B3. `update` is recursive: nested objects deep-merge, not replace.
#[test]
fn update_is_recursive_for_nested_objects() {
    let doc = apply(
        "b3-recursive-merge",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.paths[\"/a\"].get",
    "update": {"responses": {"404": {"description": "not found"}}}
  }]
}"#,
    );

    let responses = &doc["paths"]["/a"]["get"]["responses"];
    assert_eq!(responses["200"]["description"], "ok", "the 200 response is still there");
    assert_eq!(
        responses["404"]["description"], "not found",
        "the 404 response was added"
    );
}

/// B4. Sibling keys on the target that were not named in `update` are
/// preserved exactly.
#[test]
fn update_preserves_sibling_keys() {
    let doc = apply(
        "b4-sibling-keys",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.paths[\"/a\"].get",
    "update": {"summary": "s"}
  }]
}"#,
    );

    let op = &doc["paths"]["/a"]["get"];
    assert_eq!(op["summary"], "s");
    assert_eq!(op["operationId"], "aGet", "operationId stayed");
    assert!(op.get("responses").is_some(), "responses stayed");
}

/// B5. When `update` names a key whose current value is an array, the value
/// REPLACES the array (per spec: arrays are merged only when the TARGET is
/// an array; properties of objects follow the recursive-merge rule, which
/// does not define element-wise array merge, so a whole value replaces).
#[test]
fn update_on_object_property_replaces_array_whole() {
    let doc = apply(
        "b5-replace-array-property",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.paths[\"/a\"].get",
    "update": {"tags": ["new"]}
  }]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["new"]));
}

/// C1. When the target selects an array, `update` appends its value as a new
/// entry (per section 5: "the value of this field MUST be an entry to
/// append to the array").
#[test]
fn update_on_array_appends_entry() {
    let doc = apply(
        "c1-append-parameter",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"parameters": []}
    },
    {
      "target": "$.paths[\"/a\"].get.parameters",
      "update": {"name": "x", "in": "query", "schema": {"type": "string"}}
    }
  ]
}"#,
    );

    let params = &doc["paths"]["/a"]["get"]["parameters"];
    assert_eq!(params.as_array().unwrap().len(), 1);
    assert_eq!(params[0]["name"], "x");
    assert_eq!(params[0]["in"], "query");
}

/// C2. Appending to an existing non-empty array keeps existing elements in
/// order and adds the new entry at the end.
#[test]
fn update_on_non_empty_array_keeps_order() {
    let doc = apply(
        "c2-append-keeps-order",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"tags": ["a", "b"]}
    },
    {
      "target": "$.paths[\"/a\"].get.tags",
      "update": "c"
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a", "b", "c"]));
}
