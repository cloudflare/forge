//! Tests for target cardinality (E1-E4), sequential application (F1), and
//! the RFC 9535 JSONPath features we commit to supporting (G1-G8).

use crate::common::apply;

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

    assert_eq!(doc["paths"]["/a"]["get"]["responses"]["500"]["description"], "server error");
    assert_eq!(doc["paths"]["/b"]["get"]["responses"]["500"]["description"], "server error");
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
    }
  ]
}"#,
    );

    let names: Vec<_> = doc["paths"]["/a"]["get"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["b".to_string(), "c".to_string()]);
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

/// G (functions). RFC 9535 function extensions such as `length()` are
/// usable inside filters. Here, operations with a non-empty `parameters`
/// array are flagged.
#[test]
fn g_function_extension_length() {
    let doc = apply(
        "g-length-function",
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
    assert!(doc["paths"]["/a"]["get"].get("x-has-parameters").is_none(), "no parameters array means no match");
}
