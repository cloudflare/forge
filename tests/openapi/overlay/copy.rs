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

/// 1.1+ Copy. Mixed target (object + array) → rejected. Union selects
/// an object child (`responses`) and an array child (`tags`, seeded first)
/// of the same operation — a genuinely two-category nodelist. (A filter
/// like `[?@]` would also pull in the primitive `operationId`, which is
/// a different mixed case covered by its own test below.)
#[test]
fn v11_copy_target_mixed_object_and_array_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-obj-arr",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["x"]}},
    {"target": "$.paths[\"/a\"].get[\"responses\",\"tags\"]", "copy": "$.info.title"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["nodes", "same category", "mixed", "homogeneous"],
    );
}

/// 1.1+ Copy. Mixed target selection (object + primitive) → rejected.
/// Target is a union over an object child (`responses`) and a primitive
/// child (`operationId`) of the same operation, so the nodelist is
/// genuinely heterogeneous.
#[test]
fn v11_copy_target_mixed_object_and_primitive_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-obj-prim",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get[\"operationId\",\"responses\"]", "copy": "$.openapi"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["nodes", "same category", "mixed", "homogeneous"],
    );
}

/// 1.1+ Copy. Mixed target selection (array + primitive) → rejected.
/// Target is a union over an array child (`tags`, added by the first
/// action) and a primitive child (`operationId`) of the same operation.
#[test]
fn v11_copy_target_mixed_array_and_primitive_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-mixed-arr-prim",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["x"]}},
    {"target": "$.paths[\"/a\"].get[\"operationId\",\"tags\"]", "copy": "$.openapi"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["nodes", "same category", "mixed", "homogeneous"],
    );
}

// --- Value-type matrix: positives --------------------------------------

/// 1.1+ Copy. Array source into array target → concatenates (same rule
/// as array-value `update` on an array target).
#[test]
fn v11_copy_array_into_array_target_concatenates() {
    let doc = apply(
        "v11-copy-array-into-array",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b"], "parameters": []}},
    {"target": "$.paths[\"/a\"].get.parameters", "copy": "$.paths[\"/a\"].get.tags"}
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["parameters"],
        serde_json::json!(["a", "b"]),
        "array source concatenated into the (initially empty) array target"
    );
}

/// 1.1+ Copy. Object source into array target → appended as one entry.
/// SPEC has no `components` key, so the source material is seeded via a
/// root-targeted update first — that gives the subsequent copy a real
/// source node to pick up.
#[test]
fn v11_copy_object_into_array_target_appends_one_entry() {
    let doc = apply(
        "v11-copy-object-into-array",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"components": {"schemas": {"X": {"type": "string"}}}}},
    {"target": "$.paths[\"/a\"].get", "update": {"parameters": []}},
    {"target": "$.paths[\"/a\"].get.parameters", "copy": "$.components.schemas.X"}
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params.len(), 1, "object source was appended as a single entry");
    assert_eq!(params[0], serde_json::json!({"type": "string"}));
}

/// 1.1+ Copy. Primitive source into array target → appended as one entry.
#[test]
fn v11_copy_primitive_into_array_target_appends_one_entry() {
    let doc = apply(
        "v11-copy-primitive-into-array",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["existing"]}},
    {"target": "$.paths[\"/a\"].get.tags", "copy": "$.info.title"}
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["tags"],
        serde_json::json!(["existing", "t"]),
        "primitive source appended as a single array entry"
    );
}

/// 1.1+ Copy. Object source into object target → recursive merge (same
/// semantics as object `update`). Siblings of the merged keys survive.
#[test]
fn v11_copy_object_into_object_target_recursively_merges() {
    let doc = apply(
        "v11-copy-object-merges",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$",
      "update": {
        "components": {
          "schemas": {
            "Source": {"type": "object", "properties": {"id": {"type": "string"}}},
            "Target": {"type": "object", "properties": {"name": {"type": "string"}}}
          }
        }
      }
    },
    {"target": "$.components.schemas.Target", "copy": "$.components.schemas.Source"}
  ]
}"#,
    );

    let merged = &doc["components"]["schemas"]["Target"];
    assert_eq!(merged["type"], "object");
    assert_eq!(
        merged["properties"]["id"]["type"], "string",
        "source property merged in"
    );
    assert_eq!(
        merged["properties"]["name"]["type"], "string",
        "pre-existing property preserved"
    );
}

/// 1.2 Copy. The same object-into-object merge works under 1.2. Smoke
/// coverage that version dispatch wires 1.2 through the same semantic
/// path as 1.1.
#[test]
fn v12_copy_object_into_object_target_recursively_merges() {
    let doc = apply(
        "v12-copy-object-merges",
        r#"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$",
      "update": {
        "components": {
          "schemas": {
            "Source": {"type": "object", "properties": {"id": {"type": "string"}}},
            "Target": {"type": "object", "properties": {"name": {"type": "string"}}}
          }
        }
      }
    },
    {"target": "$.components.schemas.Target", "copy": "$.components.schemas.Source"}
  ]
}"#,
    );

    let merged = &doc["components"]["schemas"]["Target"];
    assert_eq!(merged["properties"]["id"]["type"], "string");
    assert_eq!(merged["properties"]["name"]["type"], "string");
}

/// 1.1+ Copy. Zero target matches is a successful no-op.
#[test]
fn v11_copy_with_zero_target_matches_is_a_successful_noop() {
    let doc = apply(
        "v11-copy-zero-targets",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/missing-path\"]", "copy": "$.info.title"}
  ]
}"#,
    );

    assert!(
        doc["paths"].get("/missing-path").is_none(),
        "no target was materialized"
    );
    assert_eq!(doc["info"]["title"], "t", "source untouched");
}

// --- Value-type matrix: cross-category negatives -----------------------

/// 1.1+ Copy. Object source into primitive target → rejected. Seeds the
/// source object via a root-targeted update so the copy actually has a
/// one-node source (instead of tripping source-cardinality on a missing
/// `$.components`).
#[test]
fn v11_copy_object_source_into_primitive_target_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-obj-src-prim-tgt",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"components": {"schemas": {"X": {"type": "string"}}}}},
    {"target": "$.info.title", "copy": "$.components.schemas.X"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &[
            "incompatible",
            "category",
            "primitive and object",
            "object into primitive",
        ],
    );
}

/// 1.1+ Copy. Array source into object target → rejected.
#[test]
fn v11_copy_array_source_into_object_target_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-arr-src-obj-tgt",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b"]}},
    {"target": "$.info", "copy": "$.paths[\"/a\"].get.tags"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["incompatible", "category", "cannot merge", "array into object"],
    );
}

/// 1.1+ Copy. Array source into primitive target → rejected.
#[test]
fn v11_copy_array_source_into_primitive_target_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-arr-src-prim-tgt",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b"]}},
    {"target": "$.info.title", "copy": "$.paths[\"/a\"].get.tags"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["incompatible", "category", "array into primitive", "array into scalar"],
    );
}

/// 1.1+ Copy. Primitive source into object target → rejected.
#[test]
fn v11_copy_primitive_source_into_object_target_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-prim-src-obj-tgt",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "copy": "$.info.title"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &[
            "incompatible",
            "category",
            "primitive into object",
            "scalar into object",
        ],
    );
}

/// 1.1+ Copy. Nested property-type incompatibility: the source object
/// has a property whose value disagrees in category with the same-named
/// target property (source `responses` is a string; target `responses`
/// is an object). The merge has no sensible rule and must be rejected.
/// Source object is seeded via a root-targeted update so the copy has a
/// real one-node source.
#[test]
fn v11_copy_nested_property_type_incompatibility_is_rejected() {
    let (spec, ov) = files(
        "v11-copy-nested-incompat",
        crate::common::SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"components": {"schemas": {"Bad": {"responses": "oops"}}}}},
    {"target": "$.paths[\"/a\"].get", "copy": "$.components.schemas.Bad"}
  ]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["incompatible", "category", "cannot merge", "primitive and object"],
    );
}

/// 1.1+ Copy. Primitive source onto a primitive target that already
/// carries the identical value is a no-op: the new value equals the
/// current one, so mutation is not recorded. Under `--out <spec>`, the
/// spec file is left byte-for-byte identical.
#[test]
fn v11_copy_primitive_to_same_value_is_noop_under_write() {
    use std::fs;

    let dir = crate::common::dir("v11-copy-primitive-same-value");
    let spec = dir.join("spec.json");
    // `info.title` and `info.version` are both "1"-style primitives in
    // the trivial spec, but copying `info.title` onto `info.title` would
    // still be a no-op. Force a case where source and target are
    // different *locations* but carry the same primitive value.
    fs::write(
        &spec,
        r#"{"openapi":"3.0.3","info":{"title":"same","version":"same"},"paths":{"/a":{"get":{"operationId":"aGet","responses":{"200":{"description":"ok"}}}}}}"#,
    )
    .unwrap();
    let before = fs::read(&spec).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "copy": "$.info.version"}]
}"#,
    )
    .unwrap();

    let out = crate::common::overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    crate::common::succeeded(&out);
    assert_eq!(
        fs::read(&spec).unwrap(),
        before,
        "copy of identical primitive is a no-op: --out <spec> did not touch the spec"
    );
}

/// 1.1+ Copy. Primitive source onto a primitive target that holds a
/// different value *does* record a mutation and the target takes the
/// source's value.
#[test]
fn v11_copy_primitive_to_different_value_mutates() {
    use std::fs;

    let dir = crate::common::dir("v11-copy-primitive-diff-value");
    let spec = dir.join("spec.json");
    fs::write(
        &spec,
        r#"{"openapi":"3.0.3","info":{"title":"old-title","version":"new-version"},"paths":{"/a":{"get":{"operationId":"aGet","responses":{"200":{"description":"ok"}}}}}}"#,
    )
    .unwrap();
    let before = fs::read(&spec).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "copy": "$.info.version"}]
}"#,
    )
    .unwrap();

    let out = crate::common::overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    crate::common::succeeded(&out);
    assert_ne!(
        fs::read(&spec).unwrap(),
        before,
        "copy of differing primitive does mutate: --out <spec> rewrote the spec"
    );
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&spec).unwrap()).unwrap();
    assert_eq!(doc["info"]["title"], "new-version");
}

/// `copy` sources come from the spec itself (not the overlay), so a `$ref`
/// inside the source is already in the spec's coordinate system and is
/// re-inserted unchanged — rebasing only applies to inserted content whose
/// base URI differs from the target spec's. This guards the deliberate
/// scope of the rebase: inserted-from-overlay only.
#[test]
fn v11_copy_leaves_in_spec_refs_untouched() {
    let doc = apply(
        "v11-copy-leaves-ref-untouched",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$",
      "update": {"components": {"schemas": {"Src": {"$ref": "./from-spec.json#/T"}}}}
    },
    {"target": "$.paths[\"/a\"].get", "update": {"parameters": []}},
    {"target": "$.paths[\"/a\"].get.parameters", "copy": "$.components.schemas.Src"}
  ]
}"#,
    );

    // The overlay's `update` seeded `components.schemas.Src` with a
    // rebased absolute ref (file:// ...). Copying it into the parameters
    // array preserves what the spec now holds — the absolute ref — and
    // does not re-rebase against the overlay base.
    let p = doc["paths"]["/a"]["get"]["parameters"][0]["$ref"].as_str().unwrap();
    assert_eq!(
        p,
        doc["components"]["schemas"]["Src"]["$ref"].as_str().unwrap(),
        "copy transplants the source value verbatim"
    );
}
