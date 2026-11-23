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
    let doc = response_with_property(r#""x-forge-skip": ["terraform""#);
    let doc = doc.replace("terraform\"", "terraform\"]");

    let forge = parse_with_conditions(&doc, &["terraform"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["b"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let fields = object(response_type(&forge, "x.get"));
    assert_eq!(field_names(fields), ["a", "b"]);
}

#[test]
fn only_for_property_is_dropped_when_no_listed_condition_is_active() {
    let doc = response_with_property(r#""x-forge-only-for": ["sdk""#);
    let doc = doc.replace("sdk\"", "sdk\"]");

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
    let doc = method_with_parameter(r#""x-forge-skip": ["terraform""#);
    let doc = doc.replace("terraform\"", "terraform\"]");

    let forge = parse_with_conditions(&doc, &["terraform"]);
    let m = method(&forge, "x.get");
    assert!(m.request().is_none(), "parameter should be dropped: {:?}", m.request());

    let forge = parse_with_conditions(&doc, &["sdk"]);
    let m = method(&forge, "x.get");
    assert!(m.request().is_some(), "parameter should be kept");
}

#[test]
fn only_for_on_a_parameter_keeps_it_only_for_matching_conditions() {
    let doc = method_with_parameter(r#""x-forge-only-for": ["sdk""#);
    let doc = doc.replace("sdk\"", "sdk\"]");

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
    let doc = method_with_responses(r#""x-forge-skip": ["terraform""#);
    let doc = doc.replace("terraform\"", "terraform\"]");

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
    let doc = method_with_responses(r#""x-forge-only-for": ["sdk""#);
    let doc = doc.replace("sdk\"", "sdk\"]");

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
    let doc = two_aliases(r#""x-forge-skip": ["terraform""#);
    let doc = doc.replace("terraform\"", "terraform\"]");

    let forge = parse_with_conditions(&doc, &["terraform"]);
    assert_eq!(method_names(&forge), ["a.secondary"]);

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.primary", "a.secondary"]);
}

#[test]
fn only_for_on_an_alias_keeps_it_only_for_matching_conditions() {
    let doc = two_aliases(r#""x-forge-only-for": ["sdk""#);
    let doc = doc.replace("sdk\"", "sdk\"]");

    let forge = parse_with_conditions(&doc, &["sdk"]);
    assert_eq!(method_names(&forge), ["a.primary", "a.secondary"]);

    let forge = parse_with_conditions(&doc, &["mcp"]);
    assert_eq!(method_names(&forge), ["a.secondary"]);
}
