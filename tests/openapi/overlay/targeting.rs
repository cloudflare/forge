//! Tests for target cardinality (E1-E4), sequential application (F1), and
//! the RFC 9535 JSONPath features we commit to supporting (G1-G8).
//!
//! The `g_` test cases hand-exercise the slices of RFC 9535 Forge most
//! depends on when overlaying OpenAPI documents. The implementation relies
//! on `serde_json_path`, which carries the RFC's own conformance corpus;
//! these tests pin the behaviours Forge users contract with on top.

use crate::common::{SPEC, apply, failed_with, files, overlay};

/// E1. A target that matches nothing is a no-op; the command still succeeds
/// and the document is unchanged.
#[test]
fn zero_matches_is_a_noop() {
    let doc = apply(
        "e1-zero-matches",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/missing\"].get", "update": {"summary": "s"}}]
}"#,
    );

    assert_eq!(doc["info"]["title"], "t", "spec unchanged");
    assert!(doc["paths"].get("/missing").is_none());
}

/// RFC 9535 filters select children of the named input node. A filter that
/// matches none of those children must remain a no-op; it must not be
/// hoisted to the parent, where it could select sibling operations instead.
#[test]
fn zero_match_filter_on_named_node_does_not_select_siblings() {
    let doc = apply(
        "e1-zero-filter-no-sibling-fallback",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"]",
      "update": {
        "get": {"x-hit": true},
        "post": {"x-hit": true, "responses": {}}
      }
    },
    {
      "target": "$.paths[\"/a\"].get[?@['x-hit']]",
      "update": {"description": "must-not-be-added"}
    }
  ]
}"#,
    );

    assert!(doc["paths"]["/a"]["get"].get("description").is_none());
    assert!(doc["paths"]["/a"]["post"].get("description").is_none());
}

/// E3. A target that matches many nodes (wildcard) applies the update to
/// each matched node.
#[test]
fn wildcard_applies_to_every_match() {
    let doc = apply(
        "e3-wildcard",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"operationId": "bGet", "responses": {"200": {"description": "ok"}}}},
        "/c": {"get": {"operationId": "cGet", "responses": {"200": {"description": "ok"}}}}
      }
    },
    {
      "target": "$.paths.*.get",
      "update": {"x-safe": true}
    }
  ]
}"#,
    );

    for path in ["/a", "/b", "/c"] {
        assert_eq!(doc["paths"][path]["get"]["x-safe"], true, "{path} was updated");
    }
}

/// E4. Recursive descent `..` reaches matching nodes at any depth.
#[test]
fn descendant_walker_matches_at_any_depth() {
    let doc = apply(
        "e4-descendant",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"responses": {"200": {"description": "ok"}, "404": {"description": "nf"}}}}
      }
    },
    {
      "target": "$..responses",
      "update": {"500": {"description": "server error"}}
    }
  ]
}"#,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["responses"]["500"]["description"],
        "server error"
    );
    assert_eq!(
        doc["paths"]["/b"]["get"]["responses"]["500"]["description"],
        "server error"
    );
}

/// F1. Actions apply in order; a later action sees the result of an earlier
/// one. Here, a key is removed then re-created.
#[test]
fn actions_apply_sequentially() {
    let doc = apply(
        "f1-remove-then-recreate",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "remove": true},
    {
      "target": "$.paths[\"/a\"]",
      "update": {"get": {"operationId": "replaced", "responses": {"200": {"description": "ok"}}}}
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["operationId"], "replaced");
}

/// F1 (continued). When a target matches many sibling nodes in one array,
/// mutation order matters. We lock down "apply from highest index down"
/// semantics so removing `[0]` and `[1]` from `[a, b, c]` by filter
/// produces `[c]`, not an off-by-one `[b, c]` from in-place index shift.
#[test]
fn duplicate_or_overlapping_matches_apply_in_safe_order() {
    let doc = apply(
        "f1-overlapping",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"tags": ["drop", "drop", "keep"]}
    },
    {"target": "$.paths[\"/a\"].get.tags[?@=='drop']", "remove": true}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["keep"]));
}

// --- JSONPath feature coverage (G1-G8) ---

/// G1. Root target `$` selects the document itself, and `update` merges
/// into it. This is the pattern used by the OAI `update-root` compliant
/// set to add an `x-*` extension at the root level.
#[test]
fn g1_root_target_updates_whole_document() {
    let doc = apply(
        "g1-root-update",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$", "update": {"info": {"x-overlaid": true}}}]
}"#,
    );

    assert_eq!(doc["info"]["x-overlaid"], true);
    assert_eq!(doc["info"]["title"], "t", "existing root keys intact");
    assert_eq!(doc["openapi"], "3.0.3");
}

/// G1 (continued). Root target `$` with `remove: true` deletes the whole
/// document, which produces an empty object. Primarily for the
/// `replace-servers-for-sandbox` pattern where `$.servers` is removed then
/// re-added at the root.
#[test]
fn g1_root_target_remove_then_recreate() {
    let doc = apply(
        "g1-root-remove-recreate",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"servers": [{"url": "https://old.example.com"}]}},
    {"target": "$.servers", "remove": true},
    {"target": "$", "update": {"servers": [{"url": "https://new.example.com"}]}}
  ]
}"#,
    );

    let servers = doc["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["url"], "https://new.example.com");
}

/// G2. Bracketed name selectors with special characters in the key work,
/// including the `/` common in OpenAPI paths.
#[test]
fn g2_bracketed_key_with_special_chars() {
    let doc = apply(
        "g2-bracket-key",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$['paths']['/a']['get']", "update": {"summary": "s"}}]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["summary"], "s");
}

/// G2. Name selectors with escape sequences (`\"`, `\\`, `\/`, apostrophe)
/// and other characters awkward for bare-dot notation. RFC 9535 §2.3.1 uses
/// the JSON string grammar, so a selector may include any character that
/// JSON permits in a string.
#[test]
fn g2_name_selector_with_escapes() {
    let doc = apply(
        "g2-escapes-ok",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"x-with/slash": {}, "x-with'apos": {}}},
    {"target": "$[\"x-with/slash\"]", "update": {"a": 1}},
    {"target": "$[\"x-with'apos\"]", "update": {"b": 2}}
  ]
}"#,
    );

    assert_eq!(doc["x-with/slash"]["a"], 1);
    assert_eq!(doc["x-with'apos"]["b"], 2);
}

/// G2. Unicode (BMP and astral plane) in name selectors round-trips through
/// the parser.
#[test]
fn g2_unicode_name_selector() {
    let doc = apply(
        "g2-unicode",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$", "update": {"café": {}, "🦀": {}}},
    {"target": "$['café']", "update": {"x": 1}},
    {"target": "$['🦀']", "update": {"y": 2}}
  ]
}"#,
    );

    assert_eq!(doc["café"]["x"], 1);
    assert_eq!(doc["🦀"]["y"], 2);
}

/// G2. Union of name selectors applies to each listed name.
#[test]
fn g2_name_selector_union() {
    let doc = apply(
        "g2-name-union",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"responses": {"200": {"description": "b"}}}},
        "/c": {"get": {"responses": {"200": {"description": "c"}}}}
      }
    },
    {"target": "$.paths['/a','/b'].get", "update": {"x-tag": "marked"}}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["x-tag"], "marked");
    assert_eq!(doc["paths"]["/b"]["get"]["x-tag"], "marked");
    assert!(doc["paths"]["/c"]["get"].get("x-tag").is_none());
}

/// G3. Wildcard `[*]` on an array matches every entry.
#[test]
fn g3_wildcard_on_array() {
    let doc = apply(
        "g3-array-wildcard",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "schema": {"type": "string"}},
          {"name": "b", "in": "query", "schema": {"type": "string"}}
        ]
      }
    },
    {"target": "$.paths[\"/a\"].get.parameters[*]", "update": {"required": true}}
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    for p in params {
        assert_eq!(p["required"], true);
    }
}

/// G4. Array index, positive and negative, selects a single element.
#[test]
fn g4_array_index_positive_and_negative() {
    let doc = apply(
        "g4-array-index",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"tags": ["a", "b", "c"]}
    },
    {"target": "$.paths[\"/a\"].get.tags[0]", "remove": true},
    {"target": "$.paths[\"/a\"].get.tags[-1]", "remove": true}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["b"]));
}

/// G4. Union of index selectors, including mixing with name selectors on
/// an object vs. an array, as RFC 9535 §2.5.1 defines.
#[test]
fn g4_index_selector_union() {
    let doc = apply(
        "g4-index-union",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"tags": ["a", "b", "c", "d", "e"]}
    },
    {"target": "$.paths[\"/a\"].get.tags[0,2,-1]", "remove": true}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["b", "d"]));
}

/// G5. Slice selector `[start:end]` selects the matched range of array
/// entries.
#[test]
fn g5_array_slice() {
    let doc = apply(
        "g5-array-slice",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {"tags": ["a", "b", "c", "d"]}
    },
    {"target": "$.paths[\"/a\"].get.tags[1:3]", "remove": true}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a", "d"]));
}

/// G5. Slice with omitted start or end bounds.
#[test]
fn g5_array_slice_open_bounds() {
    let doc = apply(
        "g5-slice-open-start",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b", "c", "d"]}},
    {"target": "$.paths[\"/a\"].get.tags[:2]", "remove": true}
  ]
}"#,
    );
    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["c", "d"]));

    let doc = apply(
        "g5-slice-open-end",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b", "c", "d"]}},
    {"target": "$.paths[\"/a\"].get.tags[2:]", "remove": true}
  ]
}"#,
    );
    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a", "b"]));
}

/// G5. Slice with a positive step picks every Nth element.
#[test]
fn g5_array_slice_positive_step() {
    let doc = apply(
        "g5-slice-step",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b", "c", "d", "e"]}},
    {"target": "$.paths[\"/a\"].get.tags[::2]", "remove": true}
  ]
}"#,
    );
    // Removes indices 0, 2, 4 → leaves b, d.
    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["b", "d"]));
}

/// G5. Slice with a negative step walks the array in reverse.
#[test]
fn g5_array_slice_negative_step() {
    let doc = apply(
        "g5-slice-neg-step-remove",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.paths[\"/a\"].get", "update": {"tags": ["a", "b", "c", "d"]}},
    {"target": "$.paths[\"/a\"].get.tags[3:0:-1]", "remove": true}
  ]
}"#,
    );
    // Removes indices 3, 2, 1 → leaves [a].
    assert_eq!(doc["paths"]["/a"]["get"]["tags"], serde_json::json!(["a"]));
}

/// G6. Filter existence test: `[?@.foo]` matches entries where `foo` is
/// present (RFC 9535 §2.3.5.2.2).
#[test]
fn g6_filter_existence_test() {
    let doc = apply(
        "g6-filter-exists",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "deprecated": true, "schema": {"type": "string"}},
          {"name": "b", "in": "query", "schema": {"type": "string"}}
        ]
      }
    },
    {"target": "$.paths[\"/a\"].get.parameters[?@.deprecated]", "remove": true}
  ]
}"#,
    );
    let names: Vec<_> = doc["paths"]["/a"]["get"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["b".to_string()]);
}

/// G6. Logical negation `!` inverts a filter test.
#[test]
fn g6_filter_negation() {
    let doc = apply(
        "g6-filter-negation",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "deprecated": true, "schema": {"type": "string"}},
          {"name": "b", "in": "query", "schema": {"type": "string"}}
        ]
      }
    },
    {"target": "$.paths[\"/a\"].get.parameters[?!@.deprecated]", "remove": true}
  ]
}"#,
    );
    let names: Vec<_> = doc["paths"]["/a"]["get"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["a".to_string()]);
}

/// G6. Comparison operators `==`, `!=`, `<`, `<=`, `>`, `>=` over literal
/// types (RFC 9535 §2.3.5.2.2).
#[test]
fn g6_comparison_operators() {
    let doc = apply(
        "g6-comparisons",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "p1", "in": "query", "schema": {"type": "integer", "maximum": 10}},
          {"name": "p2", "in": "query", "schema": {"type": "integer", "maximum": 50}},
          {"name": "p3", "in": "query", "schema": {"type": "integer", "maximum": 100}}
        ]
      }
    },
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum < 20]", "update": {"x-lt": true}},
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum <= 50]", "update": {"x-le": true}},
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum > 50]", "update": {"x-gt": true}},
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum >= 50]", "update": {"x-ge": true}},
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum != 10]", "update": {"x-ne": true}},
    {"target": "$.paths[\"/a\"].get.parameters[?@.schema.maximum == 100]", "update": {"x-eq": true}}
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    // p1 (10): lt, le, ne (10 != 10 is false actually — so skip), eq (false)
    assert_eq!(params[0]["x-lt"], true);
    assert_eq!(params[0]["x-le"], true);
    assert!(params[0].get("x-gt").is_none());
    // p2 (50): le, ge, ne
    assert_eq!(params[1]["x-le"], true);
    assert_eq!(params[1]["x-ge"], true);
    assert_eq!(params[1]["x-ne"], true);
    assert!(params[1].get("x-lt").is_none());
    assert!(params[1].get("x-gt").is_none());
    // p3 (100): gt, ge, ne, eq
    assert_eq!(params[2]["x-gt"], true);
    assert_eq!(params[2]["x-ge"], true);
    assert_eq!(params[2]["x-ne"], true);
    assert_eq!(params[2]["x-eq"], true);
}

/// G6. Filter selectors with `==`, `!=`, `&&`, `||`, and string and
/// boolean literals work together.
#[test]
fn g6_filter_boolean_expressions() {
    let doc = apply(
        "g6-filter-boolean",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "deprecated": true, "schema": {"type": "string"}},
          {"name": "b", "in": "header", "deprecated": true, "schema": {"type": "string"}},
          {"name": "c", "in": "query", "deprecated": false, "schema": {"type": "string"}}
        ]
      }
    },
    {
      "target": "$.paths[\"/a\"].get.parameters[?@.deprecated==true && @.in=='query']",
      "remove": true
    },
    {
      "target": "$.paths[\"/a\"].get.parameters[?@.in!='query' || @.deprecated==false]",
      "update": {"x-review": true}
    }
  ]
}"#,
    );

    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    let names: Vec<_> = params.iter().map(|p| p["name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(names, vec!["b".to_string(), "c".to_string()]);
    assert_eq!(params[0]["x-review"], true, "b matched @.in!='query'");
    assert_eq!(params[1]["x-review"], true, "c matched @.deprecated==false");
}

/// G6. Null literal comparison distinguishes "missing" from "present and null".
#[test]
fn g6_filter_null_literal() {
    let doc = apply(
        "g6-filter-null",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "default": null, "schema": {"type": "string"}},
          {"name": "b", "in": "query", "default": "x", "schema": {"type": "string"}}
        ]
      }
    },
    {"target": "$.paths[\"/a\"].get.parameters[?@.default==null]", "update": {"x-nullish": true}}
  ]
}"#,
    );
    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params[0]["x-nullish"], true);
    assert!(params[1].get("x-nullish").is_none());
}

/// G6. Nested logical expressions with explicit grouping.
#[test]
fn g6_filter_nested_groups() {
    let doc = apply(
        "g6-filter-nested",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths[\"/a\"].get",
      "update": {
        "parameters": [
          {"name": "a", "in": "query", "required": true, "schema": {"type": "string"}},
          {"name": "b", "in": "header", "required": true, "schema": {"type": "string"}},
          {"name": "c", "in": "query", "required": false, "schema": {"type": "string"}}
        ]
      }
    },
    {
      "target": "$.paths[\"/a\"].get.parameters[?(@.in=='query' && @.required==true) || @.in=='header']",
      "update": {"x-marked": true}
    }
  ]
}"#,
    );
    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params[0]["x-marked"], true, "query+required");
    assert_eq!(params[1]["x-marked"], true, "header");
    assert!(params[2].get("x-marked").is_none(), "query but not required");
}

/// G7. Descendant walker combined with a filter reaches the right nodes.
#[test]
fn g7_descendant_with_filter() {
    let doc = apply(
        "g7-descendant-filter",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"responses": {"200": {"description": "b"}}}},
        "/c": {"post": {"responses": {"201": {"description": "c"}}}}
      }
    },
    {"target": "$..responses.200", "update": {"x-cached": true}}
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/a"]["get"]["responses"]["200"]["x-cached"], true);
    assert_eq!(doc["paths"]["/b"]["get"]["responses"]["200"]["x-cached"], true);
    assert!(doc["paths"]["/c"]["post"]["responses"]["201"].get("x-cached").is_none());
}

/// G8. `length()` function inside a filter.
#[test]
fn g8_function_length() {
    let doc = apply(
        "g8-length",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"parameters": [{"name": "x", "in": "query", "schema": {"type": "string"}}], "responses": {"200": {"description": "ok"}}}},
        "/c": {"get": {"parameters": [], "responses": {"200": {"description": "ok"}}}}
      }
    },
    {
      "target": "$.paths.*[?length(@.parameters) > 0]",
      "update": {"x-has-parameters": true}
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/b"]["get"]["x-has-parameters"], true);
    assert!(doc["paths"]["/c"]["get"].get("x-has-parameters").is_none());
    assert!(
        doc["paths"]["/a"]["get"].get("x-has-parameters").is_none(),
        "no parameters array means no match"
    );
}

/// G8. `count(...)` function on a nodelist.
#[test]
fn g8_function_count() {
    let doc = apply(
        "g8-count",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"responses": {"200": {"description": "ok"}, "404": {"description": "nf"}}}},
        "/c": {"get": {"responses": {"200": {"description": "ok"}}}}
      }
    },
    {
      "target": "$.paths.*[?count(@.responses.*) > 1]",
      "update": {"x-many-responses": true}
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/b"]["get"]["x-many-responses"], true);
    assert!(doc["paths"]["/a"]["get"].get("x-many-responses").is_none());
    assert!(doc["paths"]["/c"]["get"].get("x-many-responses").is_none());
}

/// G8. `match()` (full-string regex match) and `search()` (substring).
#[test]
fn g8_function_match_and_search() {
    let doc = apply(
        "g8-match-search",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"operationId": "bGetV2", "responses": {"200": {"description": "ok"}}}},
        "/c": {"get": {"operationId": "helper", "responses": {"200": {"description": "ok"}}}}
      }
    },
    {
      "target": "$.paths[?match(@.get.operationId, '.*V2')].get",
      "update": {"x-v2": true}
    },
    {
      "target": "$.paths[?search(@.get.operationId, 'help')].get",
      "update": {"x-helper": true}
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/b"]["get"]["x-v2"], true);
    assert!(doc["paths"]["/c"]["get"].get("x-v2").is_none());
    assert_eq!(doc["paths"]["/c"]["get"]["x-helper"], true);
}

/// G8. `value()` extracts the single-node value of a nodelist.
#[test]
fn g8_function_value() {
    let doc = apply(
        "g8-value",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {
      "target": "$.paths",
      "update": {
        "/b": {"get": {"operationId": "bGet", "x-weight": 10, "responses": {"200": {"description": "ok"}}}},
        "/c": {"get": {"operationId": "cGet", "x-weight": 1, "responses": {"200": {"description": "ok"}}}}
      }
    },
    {
      "target": "$.paths[?value(@.get.x-weight) > 5].get",
      "update": {"x-heavy": true}
    }
  ]
}"#,
    );

    assert_eq!(doc["paths"]["/b"]["get"]["x-heavy"], true);
    assert!(doc["paths"]["/c"]["get"].get("x-heavy").is_none());
}

/// G8 (negative). `length()` takes exactly one argument; calling it with
/// zero or two arguments is a compile-time JSONPath error.
#[test]
fn g8_function_wrong_arity_is_rejected() {
    for bad in ["$[?length() > 0]", "$[?length(@, @) > 0]"] {
        let (spec, ov) = files(
            &format!("g8-arity-{}", bad.len()),
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "{bad}", "update": {{"x": 1}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["length", "jsonpath", "argument", "arity"],
        );
    }
}

/// G8 (negative). `match()` returns a boolean (`LogicalType`); using it
/// where a `ValueType` is required (e.g. directly as a selector body with
/// a comparison that expects a value) is a type error.
#[test]
fn g8_function_wrong_result_type_is_rejected() {
    // `length()` returns a ValueType; using it as a bare filter boolean
    // (`[?length(@)]` without comparing) is invalid per RFC 9535 §2.4.
    let (spec, ov) = files(
        "g8-result-type",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths.*[?length(@)]", "update": {"x": 1}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["length", "jsonpath", "type"],
    );
}

/// Regression: `normalize_shorthand` must leave floating-point literals inside
/// filter expressions intact (not rewrite `1.5` into `1['5']`).
#[test]
fn filter_with_float_literals_works() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {},
  "x-items": [
    {"name": "cheap", "price": 0.5},
    {"name": "mid", "price": 1.5},
    {"name": "pricey", "price": 2.75}
  ]
}"#;
    let (sp, ov) = files(
        "filter-float-literals",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{
    "target": "$.x-items[?@.price > 1.5]",
    "remove": true
  }]
}"#,
    );
    let out = overlay(&[sp.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let names: Vec<&str> = doc["x-items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["cheap", "mid"]);
}

/// Regression: `normalize_shorthand` must preserve `..` descendant operators
/// followed by hyphenated or numeric shorthand names (`$..x-forge-hidden`,
/// `$..200`) rather than turning them into invalid `$.['...']`.
#[test]
fn descendant_shorthand_with_hyphen_or_digits_works() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "x-forge-hidden": true,
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;
    let (sp, ov) = files(
        "descendant-shorthand-hyphen-digits",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$..x-forge-hidden", "remove": true},
    {"target": "$..200", "update": {"description": "updated"}}
  ]
}"#,
    );
    let out = overlay(&[sp.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(doc["paths"]["/a"]["get"].get("x-forge-hidden").is_none());
    assert_eq!(doc["paths"]["/a"]["get"]["responses"]["200"]["description"], "updated");
}
