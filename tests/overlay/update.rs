//! Tests for the `update` action (rules B1-B5 and C1-C2):
//! deep merge on object targets, append/concat on array targets, scalar
//! overwrite, and preservation of untouched siblings.
//!
//! Array-under-object-property semantics are version-dispatched: 1.0 is
//! silent and we replace; 1.1+ (§5) says concatenate. Array-target update
//! is also richer in 1.1+ (an array value is concatenated, an object or
//! primitive is appended); 1.0 always appends the value as a single entry.

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

/// B5 (1.0). When `update` names a key whose current value is an array, 1.0
/// spec is silent on the merge rule; we **replace** the whole array. This
/// locks in that choice for the 1.0 dispatch path.
#[test]
fn v10_update_on_object_property_replaces_array_whole() {
    let doc = apply(
        "v10-b5-replace-array-property",
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

/// B5 (1.1+). The 1.1 spec explicitly defines array-under-property merge:
/// "An array value of the `update` property is concatenated with an array
/// value of the target property." (§5 of 1.1 and 1.2.)
#[test]
fn v11_update_on_object_property_concatenates_array() {
    let doc = apply(
        "v11-b5-concat-array-property",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b"]}},
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["c"]}}
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["tags"],
        serde_json::json!(["a", "b", "c"]),
        "second action's array concatenated with first"
    );
}

/// C1 (1.0). When the target selects an array, `update` appends its value as
/// a new entry (1.0 §5: "the value of this field MUST be an entry to append
/// to the array"). Under 1.0 an array value is appended whole, as one entry.
#[test]
fn v10_update_on_array_appends_entry() {
    let doc = apply(
        "v10-c1-append-parameter",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"parameters": []}},
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

/// C1 (1.1+). The 1.1 spec says an array `update` value against an array
/// target is **concatenated** (not appended whole). An object or primitive
/// value is still appended as a single entry.
#[test]
fn v11_update_on_array_concatenates_array_values() {
    let doc = apply(
        "v11-c1-concat-array",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a"]}},
    {"target": "$.paths[\"/a\"].get.tags", "update": ["b", "c"]}
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["tags"],
        serde_json::json!(["a", "b", "c"]),
        "array update was concatenated element-wise, not appended as a nested array"
    );
}

/// C1 (1.1+). A non-array primitive update against an array target is
/// still appended as a single entry.
#[test]
fn v11_update_on_array_appends_primitive() {
    let doc = apply(
        "v11-c1-append-primitive",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a"]}},
    {"target": "$.paths[\"/a\"].get.tags", "update": "b"}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a", "b"]));
}

/// C2. Appending to an existing non-empty array keeps existing elements in
/// order and adds the new entry at the end (unchanged across versions).
#[test]
fn update_on_non_empty_array_keeps_order() {
    let doc = apply(
        "c2-append-keeps-order",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b"]}},
    {"target": "$.paths[\"/a\"].get.tags", "update": "c"}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a", "b", "c"]));
}
