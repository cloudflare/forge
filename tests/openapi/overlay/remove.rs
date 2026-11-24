//! Tests for the `remove` action (rules D1-D4):
//! removing an object key, removing an array element with a filter,
//! and the precedence of `remove: true` over `update`.

use crate::common::apply;

/// D2. `remove: true` with a target that selects an object property removes
/// that property from its parent map. Here, the entire `get` operation is
/// removed from the path item.
#[test]
fn remove_deletes_object_property() {
    let doc = apply(
        "d2-remove-operation",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get", "remove": true}]
}"#,
    );

    assert!(doc["paths"]["/a"].get("get").is_none(), "get was removed");
    assert!(doc["paths"].get("/a").is_some(), "the path item is still there");
}

/// D3. `remove: true` with a filter-based target removes every matched
/// element from its parent array. Index-based removal is tested in the
/// JSONPath feature suite.
#[test]
fn remove_filters_elements_out_of_array() {
    let doc = apply(
        "d3-filter-remove",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "keep", "in": "query", "schema": {"type": "string"}},
          {"name": "legacy", "in": "query", "schema": {"type": "string"}},
          {"name": "also-legacy", "in": "query", "schema": {"type": "string"}}
        ]
      }
    },
    {
      "target": "$.paths[\"/a\"].get.parameters[?@.name=='legacy' || @.name=='also-legacy']",
      "remove": true
    }
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params.len(), 1);
    assert_eq!(params[0]["name"], "keep");
}

/// D3 (continued). Removing with a filter that targets nothing is a no-op
/// and does not fail.
#[test]
fn remove_with_zero_matches_is_a_noop() {
    let doc = apply(
        "d3-no-match",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"parameters": [{"name": "keep", "in": "query", "schema": {"type": "string"}}]}
    },
    {
      "target": "$.paths[\"/a\"].get.parameters[?@.name=='missing']",
      "remove": true
    }
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params.len(), 1);
    assert_eq!(params[0]["name"], "keep");
}

/// D4. When an action has both `remove: true` and `update`, `remove` wins
/// and `update` is ignored (per section 5: "This field has no impact if the
/// `remove` field of this action object is `true`.").
#[test]
fn remove_wins_over_update() {
    let doc = apply(
        "d4-remove-wins",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.paths[\"/a\"].get",
    "update": {"summary": "s"},
    "remove": true
  }]
}"#,
    );

    assert!(
        doc["paths"]["/a"].get("get").is_none(),
        "get was removed; update was ignored"
    );
}

/// D1. **1.0 primitive-removal compatibility policy.** The Overlay v1.0.0
/// normative text (§5) says a `target` selects objects or arrays, not
/// primitives, so under a strict reading `remove: true` cannot drop a
/// primitive-valued property. However, OAI's own `compliant-sets/remove-example`
/// corpus applies `remove: true` to a string-valued `example` property and
/// expects the property to be dropped.
///
/// **Policy:** forge follows the OAI fixtures over the stricter spec text.
/// `remove: true` on a target that selects a primitive-valued property is
/// treated as "drop the property from its parent object." This is an
/// explicit compatibility exception to 1.0's primitive-target prohibition
/// and applies in all supported versions (1.0, 1.1, 1.2).
///
/// 1.1 and 1.2 also permit this behavior directly via their relaxed
/// primitive-target rules, so the exception only materially affects 1.0.
#[test]
fn v10_remove_primitive_valued_property_follows_oai_fixtures_not_strict_spec() {
    let doc = apply(
        "v10-remove-primitive-oai-exception",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get.operationId", "remove": true}]
}"#,
    );

    assert!(
        doc["paths"]["/a"]["get"].get("operationId").is_none(),
        "operationId was dropped"
    );
    assert!(
        doc["paths"]["/a"]["get"].get("responses").is_some(),
        "siblings untouched"
    );
}

/// Root target `$` with `remove: true` is rejected. Overlay spec is
/// silent, but silently nuking the whole document is overwhelmingly a
/// typoed JSONPath (`$` instead of `$.something`) and the resulting
/// empty object is unusable downstream. Fail fast matches Redocly.
#[test]
fn remove_root_target_is_rejected() {
    let (spec, ov) = crate::common::files(
        "remove-root-target",
        crate::common::SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$", "remove": true}]
}"#,
    );

    let err = crate::common::failed_with(
        crate::common::overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["remove", "root"],
    );
    assert!(
        err.contains("`$`") || err.contains("$ "),
        "error should name the root selector so the author knows which target is the problem:\n{err}"
    );
}

/// Regression test for total-order sorting in `apply_remove`: when a single
/// target selects equal-depth array elements alongside object keys (e.g.,
/// `[parameters[0], responses['200'], parameters[1]]`), the comparator must
/// still sort array indices strictly descending without panicking or deleting
/// shifted elements.
#[test]
fn remove_mixed_equal_depth_array_and_object_targets_deletes_exact_elements() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "parameters": [
          {"name": "drop0", "x-drop": true},
          {"name": "drop1", "x-drop": true},
          {"name": "keep2"}
        ],
        "responses": {
          "200": {"description": "ok", "x-drop": true},
          "404": {"description": "keep"}
        }
      }
    }
  }
}"#;
    let (spec_p, ov_p) = crate::common::files(
        "remove-mixed-equal-depth",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.paths['/a'].get['parameters', 'responses'][?@.x-drop == true]",
    "remove": true
  }]
}"#,
    );
    // Also exercise `$..[?@.x-drop == true]` which visits equal-depth array
    // elements and object members in a single nodelist.
    let (spec_p2, ov_p2) = crate::common::files(
        "remove-interleaved-union",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$..[?@.x-drop == true]",
    "remove": true
  }]
}"#,
    );

    for (sp, ov) in [(spec_p, ov_p), (spec_p2, ov_p2)] {
        let out = crate::common::overlay(&[sp.to_str().unwrap(), ov.to_str().unwrap()], "");
        crate::common::succeeded(&out);
        let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
        assert_eq!(params.len(), 1, "only keep2 should remain: {params:?}");
        assert_eq!(params[0]["name"], "keep2");
        assert!(doc["paths"]["/a"]["get"]["responses"].get("200").is_none());
        assert_eq!(doc["paths"]["/a"]["get"]["responses"]["404"]["description"], "keep");
    }
}

/// Regression test for the strict-cycle case in `apply_remove`: equal-length
/// nested pointers mixing `Segment::Index` and `Segment::Name` at different
/// positions (`[0][2]`, `["x"][1]`, `[1][0]`) must sort without panicking.
#[test]
fn remove_equal_depth_nested_mixed_segments_does_not_panic() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {},
  "x-grid": {
    "a": [[10, 11, 12], [20, 21, 22]],
    "b": {"x": [30, 31, 32]}
  }
}"#;
    let (sp, ov) = crate::common::files(
        "remove-nested-mixed-segments",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.x-grid..[?@ == 12 || @ == 31 || @ == 20]",
    "remove": true
  }]
}"#,
    );
    let out = crate::common::overlay(&[sp.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["x-grid"]["a"], serde_json::json!([[10, 11], [21, 22]]));
    assert_eq!(doc["x-grid"]["b"]["x"], serde_json::json!([30, 32]));
}
