//! Tests for the `copy` action, added in Overlay 1.1 and refined in 1.2.
//!
//! Section 5 of the 1.1 spec: "A JSONPath expression selecting a single
//! node to copy into the `target` nodes. ... This field has no impact if
//! the `remove` field of this action object is `true` or if the `update`
//! field contains a value."
//!
//! The 1.1 §Copy Examples cover the canonical patterns:
//! - Simple copy: `copy` source replaces the target node (merged into it if
//!   both are objects).
//! - Move: a `remove` action followed by a `copy` from the removed source
//!   location. Our sequential-apply semantics already cover this once copy
//!   is implemented.

use crate::common::{apply, failed_with, files, overlay};

/// 1.1 Copy. Copy a whole path item into another path item.
#[test]
fn v11_copy_path_item() {
    let doc = apply(
        "v11-copy-path-item",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {"/b": {"get": {"responses": {"200": {"description": "b"}}}}}
    },
    {"target": "$.paths[\"/c\"]", "copy": "$.paths[\"/b\"]"}
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/c"]["get"]["responses"]["200"]["description"], "b",
        "/c now mirrors /b"
    );
    assert!(
        doc["paths"]["/b"].get("get").is_some(),
        "source /b is still there (copy, not move)"
    );
}

/// 1.1 Copy. Copy from a primitive source onto a primitive target.
#[test]
fn v11_copy_primitive_from_source() {
    let doc = apply(
        "v11-copy-primitive",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "the-source"}},
    {"target": "$.info.title", "copy": "$.info.description"}
  ]
}"#,
    );

    assert_eq!(doc["info"]["title"], "the-source");
    assert_eq!(doc["info"]["description"], "the-source", "source untouched");
}

/// 1.1 Copy. `copy` into multiple target nodes applies the same source to
/// each, consistent with target-is-nodelist semantics.
#[test]
fn v11_copy_fans_out_to_many_targets() {
    let doc = apply(
        "v11-copy-fanout",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"responses": {"200": {"description": "b"}}}},
        "/c": {"get": {"responses": {"200": {"description": "c"}}}}
      }
    },
    {"target": "$.paths.*.get", "copy": "$.paths[\"/a\"].get"}
  ]
}"#,
    );

    // Every `get` was merged with /a's `get`, so they all now carry its
    // operationId and responses.
    for path in ["/a", "/b", "/c"] {
        assert_eq!(doc["paths"][path]["get"]["operationId"], "aGet");
    }
}

/// 1.1 Copy. Move semantics via `remove` + `copy` in sequence.
#[test]
fn v11_move_via_remove_then_copy() {
    let doc = apply(
        "v11-move-sequence",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {"/b": {"get": {"operationId": "bGet", "responses": {"200": {"description": "b"}}}}}
    },
    {"target": "$.paths[\"/c\"]", "copy": "$.paths[\"/b\"]"},
    {"target": "$.paths[\"/b\"]", "remove": true}
  ]
}"#,
    );

    assert!(doc["paths"].get("/b").is_none(), "/b was removed");
    assert_eq!(doc["paths"]["/c"]["get"]["operationId"], "bGet");
}

/// 1.1 Copy. The `copy` field is a JSONPath string; wrapping it in an
/// object or giving it a non-string value is a schema error.
#[test]
fn v11_copy_must_be_a_jsonpath_string() {
    for (name, copy_value) in [
        ("copy-object", r#"{"from": "$.foo"}"#),
        ("copy-number", "1"),
        ("copy-null", "null"),
    ] {
        let (spec, ov) = files(
            name,
            crate::common::SPEC,
            &format!(
                r#"{{
  "overlay": "1.1.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "copy": {copy_value}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
            &["copy", "string", "type"],
        );
    }
}

/// 1.1 Copy. An invalid JSONPath in the `copy` source is rejected.
#[test]
fn v11_copy_invalid_source_jsonpath_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-bad-source",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "copy": "$[unclosed"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["copy", "jsonpath", "json path"],
    );
}

/// 1.1 Copy. When both `update` and `copy` are present, `update` wins and
/// `copy` is ignored (1.1 §5: "This field has no impact if the `remove`
/// field of this action object is `true` or if the `update` field contains
/// a value").
#[test]
fn v11_update_wins_over_copy() {
    let doc = apply(
        "v11-update-vs-copy",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "from-update"}, "copy": "$.openapi"}
  ]
}"#,
    );

    assert_eq!(doc["info"]["description"], "from-update");
}

/// 1.1 Copy. `remove: true` wins over both `update` and `copy`.
#[test]
fn v11_remove_wins_over_update_and_copy() {
    let doc = apply(
        "v11-remove-vs-all",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"summary": "nope"},
      "copy": "$.info",
      "remove": true
    }
  ]
}"#,
    );

    assert!(doc["paths"]["/a"].get("get").is_none());
}

/// Version boundary: a 1.0 overlay that uses `copy` is rejected — `copy`
/// didn't exist in 1.0. Lock down that version dispatch actually checks
/// which actions the declared version permits.
#[test]
fn v10_copy_action_is_rejected() {
    let (spec, ov) = files(
        "v10-with-copy",
        crate::common::SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "copy": "$.openapi"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["copy", "1.0", "unknown", "unsupported"],
    );
}

// --- Source cardinality -------------------------------------------------
//
// 1.1 §5: `copy` is "A JSONPath expression selecting a single node to copy
// into the `target` nodes." The source MUST match exactly one node. Zero
// or more than one is an error.

/// 1.1+ Copy. Source JSONPath selects zero nodes → rejected.
#[test]
fn v11_copy_source_with_zero_matches_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-zero-source",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "copy": "$.nothing.here"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["copy", "source", "single", "zero", "no match"],
    );
}

/// 1.1+ Copy. Source JSONPath selects more than one node → rejected.
#[test]
fn v11_copy_source_with_multiple_matches_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-many-source",
        crate::common::SPEC,
        // `$.paths.*` matches at least `/a` (the trivial spec has one path,
        // but we add two more so the source nodelist is three nodes long).
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths", "update": {"/b": {"get": {"responses": {}}}, "/c": {"get": {"responses": {}}}}},
    {"target": "$.info", "copy": "$.paths.*"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["copy", "source", "single", "multiple", "more than one"],
    );
}

// --- Target homogeneity -------------------------------------------------
//
// 1.1 §5 / 1.2 §5. When `target` selects multiple nodes they must all be
// the same category (object, array, or primitive). Mixed selections are
// rejected because the applicable rule depends on the category.

/// 1.1+ Copy. Mixed target selection (object + array) → rejected.
#[test]
fn v11_copy_target_mixed_object_and_array_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-obj-arr",
        crate::common::SPEC,
        // `$.paths["/a"].get` is an object; adding a parameters array next
        // to it and targeting the union gives a mixed nodelist.
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["x"]}},
    {"target": "$.paths[\"/a\"].get[?@]", "copy": "$.info.title"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["target", "nodes", "same category", "mixed", "homogeneous"],
    );
}

/// 1.1+ Copy. Mixed target selection (object + primitive) → rejected.
#[test]
fn v11_copy_target_mixed_object_and_primitive_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-obj-prim",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info[?@]", "copy": "$.openapi"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["target", "nodes", "same category", "mixed", "homogeneous"],
    );
}

/// 1.1+ Copy. Mixed target selection (array + primitive) → rejected.
#[test]
fn v11_copy_target_mixed_array_and_primitive_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-arr-prim",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["x"], "summary": "s"}},
    {"target": "$.paths[\"/a\"].get[?@.tags || @.summary]", "copy": "$.openapi"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["target", "nodes", "same category", "mixed", "homogeneous"],
    );
}
