//! Tests for `x-forge-skip` with a list of conditions and `x-forge-only-for`.
//! See RFC 0003.

use crate::common::{field_names, method, object, parse, parse_with_conditions, response_type};

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
