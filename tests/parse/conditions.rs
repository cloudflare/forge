//! Tests for `x-forge-skip` with a list of conditions and `x-forge-only-for`.
//! See RFC 0003.

use crate::common::{
    field_names, method, object, parse, parse_with_conditions, parse_with_conditions_err, response_type,
};

/// A document with two methods named by `a.get` and `b.get`, the first with
/// the extensions in `a_ext` and the second with those in `b_ext`.
fn two_methods(a_ext: &str, b_ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/a": {{
              "get": {{
                "x-forge-group-name": "a",
                "x-forge-method-name": "get",
                {a_ext}
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }},
            "/b": {{
              "get": {{
                "x-forge-group-name": "b",
                "x-forge-method-name": "get",
                {b_ext}
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }}
          }}
        }}"#
    )
}

fn method_names(forge: &forge::Forge) -> Vec<String> {
    forge
        .groups()
        .flat_map(|group| {
            let group_path: Vec<_> = group.path().map(forge::Name::kebab).collect();
            let prefix = group_path.join(".");
            group
                .methods()
                .map(|method| {
                    if prefix.is_empty() {
                        method.name().kebab()
                    } else {
                        format!("{prefix}.{}", method.name().kebab())
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn skip_true_is_always_skipped_whatever_the_conditions() {
    let doc = two_methods(r#""x-forge-skip": true,"#, "");

    for conditions in [&[][..], &["sdk"], &["anything"]] {
        let forge = parse_with_conditions(&doc, conditions);
        assert_eq!(method_names(&forge), ["b.get"], "{conditions:?}");
    }
}

#[test]
fn skip_false_and_empty_list_are_no_ops() {
    let doc = two_methods(r#""x-forge-skip": false,"#, r#""x-forge-skip": [],"#);
    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn skip_list_only_fires_when_a_listed_condition_is_active() {
    let doc = two_methods(r#""x-forge-skip": ["terraform"],"#, "");

    let forge = parse_with_conditions(&doc, &[]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["b.get"]);
}

#[test]
fn skip_list_fires_when_any_listed_condition_is_active() {
    let doc = two_methods(r#""x-forge-skip": ["terraform", "mcp"],"#, "");

    let forge = parse_with_conditions(&doc, &["mcp"]);
    assert_eq!(method_names(&forge), ["b.get"]);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["b.get"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn only_for_keeps_only_when_a_listed_condition_is_active() {
    let doc = two_methods(r#""x-forge-only-for": ["sdk"],"#, "");

    let forge = parse_with_conditions(&doc, &[]);
    assert_eq!(method_names(&forge), ["b.get"]);

    let forge = parse_with_conditions(&doc, &["mcp"]);
    assert_eq!(method_names(&forge), ["b.get"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn only_for_with_any_listed_condition_keeps_the_method() {
    let doc = two_methods(r#""x-forge-only-for": ["ts", "go", "rust"],"#, "");

    let forge = parse_with_conditions(&doc, &["go"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn only_for_empty_list_is_a_no_op() {
    let doc = two_methods(r#""x-forge-only-for": [],"#, "");

    let forge = parse_with_conditions(&doc, &[]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn skip_wins_over_only_for() {
    // The method matches only_for, but also matches skip: skip wins.
    let doc = two_methods(r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["sdk"],"#, "");

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["b.get"]);
}

#[test]
fn no_filter_without_conditions_matches_legacy_behavior() {
    // A document with no skip/only_for behaves the same way whether or not
    // conditions are pinned.
    let doc = two_methods("", "");

    assert_eq!(method_names(&parse(&doc)), ["a.get", "b.get"]);
    assert_eq!(
        method_names(&parse_with_conditions(&doc, &["sdk", "mcp"])),
        ["a.get", "b.get"]
    );
}

/// A document whose only method returns an object with properties `a` and
/// `b`. `a` carries `extensions`.
fn response_with_property(extensions: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/x": {{
              "get": {{
                "x-forge-group-name": "x",
                "x-forge-method-name": "get",
                "responses": {{"200": {{
                  "description": "ok",
                  "content": {{"application/json": {{"schema": {{
                    "type": "object",
                    "properties": {{
                      "a": {{"type": "string", {extensions}}},
                      "b": {{"type": "string"}}
                    }}
                  }}}}}}
                }}}}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skipped_property_is_dropped_from_fields() {
    let doc = response_with_property(r#""x-forge-skip": ["terraform"]"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["b"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["a", "b"]);
}

#[test]
fn only_for_property_is_dropped_when_no_listed_condition_is_active() {
    let doc = response_with_property(r#""x-forge-only-for": ["sdk"]"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["a", "b"]);

    let forge = parse_with_conditions(&doc, &["mcp"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["b"]);
}

#[test]
fn methods_helper_is_named() {
    // Sanity: the helper here returns sensible names used by the above
    // assertions.
    let forge = parse(&two_methods("", ""));
    let names = method_names(&forge);
    assert_eq!(names, ["a.get", "b.get"]);
    // `method(…, "a.get")` resolves the same path the helper produces.
    let _ = method(&forge, "a.get");
}

/// A document with two path items; the first one carries `ext`.
fn two_path_items(ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/a": {{
              {ext}
              "get": {{
                "x-forge-group-name": "a",
                "x-forge-method-name": "get",
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }},
            "/b": {{
              "get": {{
                "x-forge-group-name": "b",
                "x-forge-method-name": "get",
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skip_on_a_path_item_drops_every_method_in_it() {
    let doc = two_path_items(r#""x-forge-skip": ["terraform"],"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["b.get"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);
}

#[test]
fn only_for_on_a_path_item_keeps_only_matching_conditions() {
    let doc = two_path_items(r#""x-forge-only-for": ["sdk"],"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.get", "b.get"]);

    let forge = parse_with_conditions(&doc, &[]);
    assert_eq!(method_names(&forge), ["b.get"]);
}

/// A document with one method whose single parameter carries `ext`.
fn method_with_parameter(ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/x": {{
              "get": {{
                "x-forge-group-name": "x",
                "x-forge-method-name": "get",
                "parameters": [
                  {{"name": "p", "in": "query", "schema": {{"type": "string"}}, {ext}}}
                ],
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skip_on_a_parameter_drops_it() {
    let doc = method_with_parameter(r#""x-forge-skip": ["terraform"]"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    let m = method(&forge, "x.get");
    assert!(m.request().is_none(), "parameter should be dropped: {:?}", m.request());

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let m = method(&forge, "x.get");
    assert!(m.request().is_some(), "parameter should be kept");
}

#[test]
fn only_for_on_a_parameter_keeps_it_only_for_matching_conditions() {
    let doc = method_with_parameter(r#""x-forge-only-for": ["sdk"]"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert!(method(&forge, "x.get").request().is_some());

    let forge = parse_with_conditions(&doc, &[]);
    assert!(method(&forge, "x.get").request().is_none());
}

/// A document with one method whose request body carries `ext`.
fn method_with_body(ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/x": {{
              "post": {{
                "x-forge-group-name": "x",
                "x-forge-method-name": "post",
                "requestBody": {{
                  {ext}
                  "content": {{"application/json": {{"schema": {{"type": "string"}}}}}}
                }},
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skip_on_a_request_body_drops_it() {
    let doc = method_with_body(r#""x-forge-skip": ["terraform"],"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert!(method(&forge, "x.post").body().is_none());

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert!(method(&forge, "x.post").body().is_some());
}

#[test]
fn only_for_on_a_request_body_keeps_it_only_for_matching_conditions() {
    let doc = method_with_body(r#""x-forge-only-for": ["sdk"],"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert!(method(&forge, "x.post").body().is_some());

    let forge = parse_with_conditions(&doc, &[]);
    assert!(method(&forge, "x.post").body().is_none());
}

/// A document with one method with two responses: 200 (carries `ext`) and 204.
fn method_with_responses(ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/x": {{
              "get": {{
                "x-forge-group-name": "x",
                "x-forge-method-name": "get",
                "responses": {{
                  "200": {{"description": "ok", {ext}}},
                  "204": {{"description": "no content"}}
                }}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skip_on_a_response_drops_it() {
    let doc = method_with_responses(r#""x-forge-skip": ["terraform"]"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    let statuses: Vec<_> = method(&forge, "x.get")
        .responses()
        .map(|r| r.status().to_owned())
        .collect();
    assert_eq!(statuses, ["204"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let statuses: Vec<_> = method(&forge, "x.get")
        .responses()
        .map(|r| r.status().to_owned())
        .collect();
    assert_eq!(statuses, ["200", "204"]);
}

#[test]
fn only_for_on_a_response_keeps_it_only_for_matching_conditions() {
    let doc = method_with_responses(r#""x-forge-only-for": ["sdk"]"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let statuses: Vec<_> = method(&forge, "x.get")
        .responses()
        .map(|r| r.status().to_owned())
        .collect();
    assert_eq!(statuses, ["200", "204"]);

    let forge = parse_with_conditions(&doc, &[]);
    let statuses: Vec<_> = method(&forge, "x.get")
        .responses()
        .map(|r| r.status().to_owned())
        .collect();
    assert_eq!(statuses, ["204"]);
}

/// A document with one method that references the component schema `Pet`,
/// which carries `ext`.
fn method_referencing_schema(ext: &str) -> String {
    format!(
        r##"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/x": {{
              "get": {{
                "x-forge-group-name": "x",
                "x-forge-method-name": "get",
                "responses": {{"200": {{
                  "description": "ok",
                  "content": {{"application/json": {{"schema": {{"$ref": "#/components/schemas/Pet"}}}}}}
                }}}}
              }}
            }}
          }},
          "components": {{
            "schemas": {{
              "Pet": {{"type": "object", {ext} "properties": {{"name": {{"type": "string"}}}}}}
            }}
          }}
        }}"##
    )
}

#[test]
fn ref_to_skipped_component_schema_is_an_error() {
    let doc = method_referencing_schema(r#""x-forge-skip": ["terraform"],"#);

    let err = parse_with_conditions_err(&doc, &["terraform"]);
    assert!(
        err.contains("points to a schema removed by x-forge-skip"),
        "error should name the dangling ref: {err}"
    );

    // When conditions don't match, the schema is kept and parsing succeeds.
    parse_with_conditions(&doc, &["sdk"]);
}

#[test]
fn ref_to_only_for_component_schema_is_an_error_when_no_condition_matches() {
    let doc = method_referencing_schema(r#""x-forge-only-for": ["sdk"],"#);

    let err = parse_with_conditions_err(&doc, &[]);
    assert!(
        err.contains("points to a schema removed by x-forge-skip or x-forge-only-for"),
        "error should name the dangling ref: {err}"
    );

    parse_with_conditions(&doc, &["sdk"]);
}

#[test]
fn always_skipped_component_schema_is_dangling_even_in_library_mode() {
    // `x-forge-skip: true` drops unconditionally; the library path (no
    // conditions) still errors on refs into it.
    let doc = method_referencing_schema(r#""x-forge-skip": true,"#);
    let err = crate::common::parse_err(&doc);
    assert!(
        err.contains("points to a schema removed by x-forge-skip"),
        "error should name the dangling ref: {err}"
    );
}

/// A document with one operation and two aliases: the first alias carries
/// `ext`, the second does not.
fn two_aliases(ext: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3",
          "info": {{"title": "t", "version": "1"}},
          "paths": {{
            "/a": {{
              "get": {{
                "x-forge-group-name": "a",
                "x-forge-method-name": "list",
                "x-forge-aliases": [
                  {{"x-forge-group-name": "a", "x-forge-method-name": "primary", {ext}}},
                  {{"x-forge-group-name": "a", "x-forge-method-name": "secondary"}}
                ],
                "responses": {{"204": {{"description": "ok"}}}}
              }}
            }}
          }}
        }}"#
    )
}

#[test]
fn skip_on_an_alias_drops_only_that_alias() {
    let doc = two_aliases(r#""x-forge-skip": ["terraform"]"#);

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["a.secondary"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.primary", "a.secondary"]);
}

#[test]
fn only_for_on_an_alias_keeps_it_only_for_matching_conditions() {
    let doc = two_aliases(r#""x-forge-only-for": ["sdk"]"#);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.primary", "a.secondary"]);

    let forge = parse_with_conditions(&doc, &["mcp"]);
    assert_eq!(method_names(&forge), ["a.secondary"]);
}

#[test]
fn operation_parameter_skip_overrides_path_item_parameter() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "parameters": [
            {"name": "debug", "in": "query", "schema": {"type": "boolean"}}
          ],
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "parameters": [
              {"name": "debug", "in": "query", "x-forge-skip": ["sdk"], "schema": {"type": "boolean"}}
            ],
            "responses": {"204": {"description": "ok"}}
          }
        }
      }
    }"#;

    // When `sdk` is active, the operation's skipped override suppresses the
    // path item's `debug` parameter instead of letting it leak through.
    let forge = parse_with_conditions(doc, &["sdk"]);
    assert!(method(&forge, "x.get").request().is_none());

    // When `sdk` is inactive, the parameter is kept.
    let forge = parse_with_conditions(doc, &["terraform"]);
    assert!(method(&forge, "x.get").request().is_some());
}

#[test]
fn operation_parameter_can_unskip_a_skipped_path_item_parameter() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "parameters": [
            {"name": "debug", "in": "query", "x-forge-skip": ["sdk"], "schema": {"type": "boolean"}}
          ],
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "parameters": [
              {"name": "debug", "in": "query", "schema": {"type": "boolean"}}
            ],
            "responses": {"204": {"description": "ok"}}
          }
        }
      }
    }"#;

    let forge = parse_with_conditions(doc, &["sdk"]);
    assert!(method(&forge, "x.get").request().is_some());
}

#[test]
fn skipping_a_required_path_parameter_is_an_error() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/accounts/{account_id}": {
          "get": {
            "x-forge-group-name": "accounts",
            "x-forge-method-name": "get",
            "parameters": [
              {
                "name": "account_id",
                "in": "path",
                "required": true,
                "x-forge-skip": ["terraform"],
                "schema": {"type": "integer"}
              }
            ],
            "responses": {"204": {"description": "ok"}}
          }
        }
      }
    }"#;

    let err = parse_with_conditions_err(doc, &["terraform"]);
    assert!(
        err.contains(r#"path parameter "account_id" is required by the path template"#),
        "unexpected error: {err}"
    );

    // When the condition is not active, the path parameter is kept normally.
    let forge = parse_with_conditions(doc, &["sdk"]);
    let fields = object(method(&forge, "accounts.get").request().unwrap());
    assert_eq!(field_names(fields), ["account_id"]);
}

#[test]
fn ref_to_skipped_defs_schema_is_an_error() {
    let doc = r##"{
      "openapi": "3.1.0",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "responses": {"200": {
              "description": "ok",
              "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Container/$defs/Secret"}}}
            }}
          }
        }
      },
      "components": {
        "schemas": {
          "Container": {
            "type": "object",
            "$defs": {
              "Secret": {
                "type": "string",
                "x-forge-skip": ["terraform"]
              }
            }
          }
        }
      }
    }"##;

    let err = parse_with_conditions_err(doc, &["terraform"]);
    assert!(
        err.contains("points to a schema removed by x-forge-skip or x-forge-only-for"),
        "error should name the dangling $defs ref: {err}"
    );

    parse_with_conditions(doc, &["sdk"]);
}

#[test]
fn ref_to_skipped_property_schema_is_an_error() {
    let doc = r##"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "responses": {"200": {
              "description": "ok",
              "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Thing/properties/internal"}}}
            }}
          }
        }
      },
      "components": {
        "schemas": {
          "Thing": {
            "type": "object",
            "properties": {
              "internal": {"type": "string", "x-forge-only-for": ["internal"]}
            }
          }
        }
      }
    }"##;

    let err = parse_with_conditions_err(doc, &["sdk"]);
    assert!(
        err.contains("points to a schema removed by x-forge-skip or x-forge-only-for"),
        "error should name the dangling property ref: {err}"
    );

    parse_with_conditions(doc, &["internal"]);
}

#[test]
fn only_for_extension_is_consumed_and_not_exposed_on_method() {
    let doc = two_methods(r#""x-forge-only-for": ["sdk"], "x-other": 1,"#, "");
    let forge = parse_with_conditions(&doc, &["sdk"]);
    let m = method(&forge, "a.get");
    assert_eq!(m.extension("x-forge-only-for"), None);
    let ext_names: Vec<_> = m.extensions().map(|(k, _)| k).collect();
    assert_eq!(ext_names, ["x-other"]);
}

#[test]
fn truth_table_of_skip_and_only_for_combinations() {
    let cases: &[(&str, &[&str], bool)] = &[
        // Combined distinct conditions: exclusion wins when both match.
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["terraform"],"#,
            &[],
            false,
        ),
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["terraform"],"#,
            &["sdk"],
            true,
        ),
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["terraform"],"#,
            &["terraform"],
            false,
        ),
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["terraform"],"#,
            &["sdk", "terraform"],
            false,
        ),
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-skip": ["terraform"],"#,
            &["terraform", "sdk"],
            false,
        ),
        // Duplicates and ordering do not affect semantics.
        (
            r#""x-forge-only-for": ["sdk", "sdk"], "x-forge-skip": ["terraform"],"#,
            &["sdk", "sdk"],
            true,
        ),
        // `x-forge-skip: true` overrides a matching `x-forge-only-for`.
        (r#""x-forge-only-for": ["sdk"], "x-forge-skip": true,"#, &["sdk"], false),
        // `x-forge-skip: false` is a no-op alongside `x-forge-only-for`.
        (r#""x-forge-only-for": ["sdk"], "x-forge-skip": false,"#, &[], false),
        (r#""x-forge-only-for": ["sdk"], "x-forge-skip": false,"#, &["sdk"], true),
        // Condition names are case-sensitive.
        (r#""x-forge-skip": ["SDK"],"#, &["sdk"], true),
        (r#""x-forge-skip": ["SDK"],"#, &["SDK"], false),
        (r#""x-forge-only-for": ["SDK"],"#, &["sdk"], false),
        (r#""x-forge-only-for": ["SDK"],"#, &["SDK"], true),
    ];

    for &(ext, conditions, kept) in cases {
        let doc = two_methods(ext, "");
        let forge = parse_with_conditions(&doc, conditions);
        let expected: &[&str] = if kept { &["a.get", "b.get"] } else { &["b.get"] };
        assert_eq!(method_names(&forge), expected, "ext={ext} conditions={conditions:?}");
    }
}

#[test]
fn deserialize_without_conditions_keeps_conditional_filters_and_drops_skip_true() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/always": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "always",
            "x-forge-skip": true,
            "responses": {"204": {"description": "ok"}}
          }
        },
        "/cond-skip": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "cond_skip",
            "x-forge-skip": ["terraform"],
            "responses": {"204": {"description": "ok"}}
          }
        },
        "/only-for": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "only_for",
            "x-forge-only-for": ["sdk"],
            "responses": {"204": {"description": "ok"}}
          }
        },
        "/both": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "both",
            "x-forge-only-for": ["sdk"],
            "x-forge-skip": ["sdk"],
            "responses": {"204": {"description": "ok"}}
          }
        }
      }
    }"#;

    let forge = parse(doc);
    assert_eq!(method_names(&forge), ["a.both", "a.cond-skip", "a.only-for"]);
}

#[test]
fn invalid_skip_and_only_for_shapes_are_errors() {
    let cases: &[(&str, &str)] = &[
        (r#""x-forge-skip": "terraform","#, "boolean or an array"),
        (r#""x-forge-skip": 123,"#, "boolean or an array"),
        (r#""x-forge-skip": null,"#, "boolean or an array"),
        (r#""x-forge-skip": {},"#, "boolean or an array"),
        (r#""x-forge-skip": [""],"#, "condition name must not be empty"),
        (r#""x-forge-skip": ["sdk", ""],"#, "condition name must not be empty"),
        (r#""x-forge-skip": [123],"#, "string"),
        (r#""x-forge-only-for": true,"#, "array of condition names"),
        (r#""x-forge-only-for": "sdk","#, "array of condition names"),
        (r#""x-forge-only-for": 123,"#, "array of condition names"),
        (r#""x-forge-only-for": [""],"#, "condition name must not be empty"),
        (
            r#""x-forge-only-for": ["sdk", ""],"#,
            "condition name must not be empty",
        ),
        (r#""x-forge-only-for": [true],"#, "string"),
        (
            r#""x-forge-only-for": ["sdk"], "x-forge-only-for": ["mcp"],"#,
            "duplicate field `x-forge-only-for`",
        ),
    ];

    for &(ext, want) in cases {
        let doc = two_methods(ext, "");
        let err = parse_with_conditions_err(&doc, &["sdk"]);
        assert!(err.contains(want), "ext={ext}: want {want:?}, got {err:?}");
    }

    // Mid-array empty string on a schema property fails cleanly without corrupting the arena.
    let prop_doc = response_with_property(r#""x-forge-skip": ["sdk", ""]"#);
    let err = parse_with_conditions_err(&prop_doc, &["sdk"]);
    assert!(err.contains("condition name must not be empty"), "{err}");
}

#[test]
fn ref_placements_honor_skip_and_only_for_on_components() {
    let doc = r##"{
      "openapi": "3.1.0",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/skipped-path": {"$ref": "#/components/pathItems/SkippedPath"},
        "/x": {
          "post": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "post",
            "parameters": [{"$ref": "#/components/parameters/SkippedParam"}],
            "requestBody": {"$ref": "#/components/requestBodies/OnlySdkBody"},
            "responses": {
              "200": {"$ref": "#/components/responses/OnlySdkResponse"},
              "204": {"description": "no content"}
            }
          }
        }
      },
      "components": {
        "pathItems": {
          "SkippedPath": {
            "x-forge-skip": ["terraform"],
            "get": {
              "x-forge-group-name": "p",
              "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}
            }
          }
        },
        "parameters": {
          "SkippedParam": {
            "name": "q",
            "in": "query",
            "x-forge-skip": ["terraform"],
            "schema": {"type": "string"}
          }
        },
        "requestBodies": {
          "OnlySdkBody": {
            "x-forge-only-for": ["sdk"],
            "content": {"application/json": {"schema": {"type": "string"}}}
          }
        },
        "responses": {
          "OnlySdkResponse": {
            "description": "ok",
            "x-forge-only-for": ["sdk"]
          }
        }
      }
    }"##;

    // Under `terraform`: pathItem, param, body, and 200 response are all filtered out.
    let forge = parse_with_conditions(doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["x.post"]);
    let post = method(&forge, "x.post");
    assert!(post.request().is_none());
    assert!(post.body().is_none());
    let statuses: Vec<_> = post.responses().map(|r| r.status().to_owned()).collect();
    assert_eq!(statuses, ["204"]);

    // Under `sdk`: all four referenced components are kept.
    let forge = parse_with_conditions(doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["p.get", "x.post"]);
    let post = method(&forge, "x.post");
    assert!(post.request().is_some());
    assert!(post.body().is_some());
    let statuses: Vec<_> = post.responses().map(|r| r.status().to_owned()).collect();
    assert_eq!(statuses, ["200", "204"]);
}

#[test]
fn skipped_required_property_is_silently_ignored_in_required() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "responses": {"200": {
              "description": "ok",
              "content": {"application/json": {"schema": {
                "type": "object",
                "required": ["a", "b"],
                "properties": {
                  "a": {"type": "string", "x-forge-skip": ["terraform"]},
                  "b": {"type": "string"}
                }
              }}}
            }}
          }
        }
      }
    }"#;

    let forge = parse_with_conditions(doc, &["terraform"]);
    let fields: Vec<_> = object(response_type(&forge, "x.get"))
        .fields()
        .map(|f| (f.wire_name(), f.is_required()))
        .collect();
    assert_eq!(fields, [("b", true)]);

    let forge = parse_with_conditions(doc, &["sdk"]);
    let fields: Vec<_> = object(response_type(&forge, "x.get"))
        .fields()
        .map(|f| (f.wire_name(), f.is_required()))
        .collect();
    assert_eq!(fields, [("a", true), ("b", true)]);
}

#[test]
fn header_parameter_skip_and_override() {
    let doc = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/x": {
          "parameters": [
            {"name": "X-Debug", "in": "header", "schema": {"type": "string"}}
          ],
          "get": {
            "x-forge-group-name": "x",
            "x-forge-method-name": "get",
            "parameters": [
              {"name": "x-debug", "in": "header", "x-forge-skip": ["sdk"], "schema": {"type": "string"}},
              {"name": "X-Sdk-Trace", "in": "header", "x-forge-only-for": ["sdk"], "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}
          }
        }
      }
    }"#;

    // Under `sdk`: `X-Debug` is suppressed by the case-insensitive operation override; `X-Sdk-Trace` is kept.
    let forge = parse_with_conditions(doc, &["sdk"]);
    let headers = method(&forge, "x.get").headers().unwrap();
    assert_eq!(field_names(headers), ["X-Sdk-Trace"]);

    // Under `terraform`: `X-Debug` (overridden as `x-debug`) is kept; `X-Sdk-Trace` is dropped.
    let forge = parse_with_conditions(doc, &["terraform"]);
    let headers = method(&forge, "x.get").headers().unwrap();
    assert_eq!(field_names(headers), ["x-debug"]);
}
