use forge::{Forge, Json};

use crate::common::{method, parse, parse_err};

/// Returns a document with one method, `a.get`, whose operation also has
/// `fields`, which end with a comma.
fn operation_with(fields: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{{fields}
            "x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {{"204": {{"description": "ok"}}}}}}}}}}
        }}"#
    )
}

/// Returns the names of the extensions of the method at `path`, in order.
fn names<'f>(forge: &'f Forge, path: &str) -> Vec<&'f str> {
    method(forge, path).extensions().map(|(name, _)| name).collect()
}

#[test]
fn extensions_are_kept_in_the_order_they_are_written() {
    let forge = parse(&operation_with(
        r#""x-b": {"k": [1, 2.5, null]}, "summary": "s", "x-a": true, "x-c": null, "x-d": -3,"#,
    ));

    let get = method(&forge, "a.get");
    let extensions: Vec<(&str, &Json)> = get.extensions().collect();
    let object = Json::Object(vec![(
        "k".into(),
        Json::Array(vec![Json::Number(1.0), Json::Number(2.5), Json::Null]),
    )]);
    assert_eq!(
        extensions,
        [
            ("x-b", &object),
            ("x-a", &Json::Bool(true)),
            ("x-c", &Json::Null),
            ("x-d", &Json::Number(-3.0)),
        ]
    );
    assert_eq!(get.extensions().len(), 4);
}

#[test]
fn extension_is_found_by_name() {
    let forge = parse(&operation_with(
        r#""x-forge-params": {"zone": {"flag": "z", "positional": false}, "page": {}},"#,
    ));

    let params = method(&forge, "a.get").extension("x-forge-params").unwrap();
    let names: Vec<&str> = params.as_object().unwrap().iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(names, ["zone", "page"]);
    let zone = params.get("zone").unwrap();
    assert_eq!(zone.get("flag").and_then(Json::as_str), Some("z"));
    assert_eq!(zone.get("positional").and_then(Json::as_bool), Some(false));
}

#[test]
fn missing_extension_is_none() {
    let forge = parse(&operation_with(r#""x-a": 1,"#));

    assert_eq!(method(&forge, "a.get").extension("x-b"), None);
}

#[test]
fn method_without_extensions_has_none() {
    let forge = parse(&operation_with(""));

    let get = method(&forge, "a.get");
    assert_eq!(get.extensions().len(), 0);
    assert_eq!(get.extension("x-forge-method-name"), None);
}

#[test]
fn keys_that_are_not_extensions_are_not_kept() {
    let forge = parse(&operation_with(
        r#""operationId": "getA", "tags": ["a"], "X-a": 1, "x-b": 2,"#,
    ));

    assert_eq!(names(&forge, "a.get"), ["x-b"]);
}

#[test]
fn extensions_forge_reads_are_not_kept() {
    let forge = parse(&operation_with(r#""x-forge-skip": false, "x-a": 1,"#));

    let get = method(&forge, "a.get");
    assert_eq!(names(&forge, "a.get"), ["x-a"]);
    assert_eq!(get.extension("x-forge-group-name"), None);
    assert_eq!(get.extension("x-forge-skip"), None);
}

#[test]
fn vendor_extensions_are_not_parser_fallbacks() {
    let forge = parse(&operation_with(
        r#""x-fern-sdk-group-name": "other", "x-fern-sdk-method-name": "other",
          "x-fern-ignore": true, "x-fern-availability": "beta","#,
    ));

    let get = method(&forge, "a.get");
    assert_eq!(get.availability(), None);
    assert_eq!(
        names(&forge, "a.get"),
        [
            "x-fern-sdk-group-name",
            "x-fern-sdk-method-name",
            "x-fern-ignore",
            "x-fern-availability"
        ]
    );
}

#[test]
fn availability_hidden_and_confirmation_are_not_kept() {
    let forge = parse(&operation_with(
        r#""x-a": 1, "x-forge-availability": "beta", "x-forge-hidden": true,
          "x-forge-require-confirmation": "Sure?", "x-b": 2,"#,
    ));

    let get = method(&forge, "a.get");
    assert_eq!(names(&forge, "a.get"), ["x-a", "x-b"]);
    assert_eq!(get.extension("x-forge-availability"), None);
    assert_eq!(get.extension("x-forge-hidden"), None);
    assert_eq!(get.extension("x-forge-require-confirmation"), None);
}

#[test]
fn extensions_forge_reads_are_still_read() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-group-name": ["a", "b"], "x-forge-method-name": "list", "x-a": 1,
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-group-name": "a", "x-forge-method-name": "create", "x-forge-skip": true,
              "x-a": 1, "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    assert_eq!(names(&forge, "a.b.list"), ["x-a"]);
    assert_eq!(forge.groups().flat_map(|group| group.methods()).count(), 1);
}

#[test]
fn repeated_extension_has_the_last_value_in_the_place_of_the_first() {
    let forge = parse(&operation_with(r#""x-a": 1, "x-b": 2, "x-a": {"c": 3},"#));

    let get = method(&forge, "a.get");
    assert_eq!(names(&forge, "a.get"), ["x-a", "x-b"]);
    assert_eq!(get.extension("x-a").and_then(|a| a.get("c")), Some(&Json::Number(3.0)));
}

#[test]
fn repeated_extension_forge_reads_is_still_an_error() {
    let err = parse_err(&operation_with(r#""x-forge-skip": false, "x-forge-skip": false,"#));

    assert!(err.contains("duplicate field `x-forge-skip`"), "{err}");
}

#[test]
fn each_method_keeps_its_own_extensions() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get", "x-a": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/c": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create", "x-a": "create",
              "x-b": [], "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    let a = |path| method(&forge, path).extension("x-a").and_then(Json::as_str);
    assert_eq!(a("a.get"), Some("get"));
    assert_eq!(a("a.list"), None);
    assert_eq!(a("a.create"), Some("create"));
    assert_eq!(names(&forge, "a.get"), ["x-a"]);
    assert_eq!(names(&forge, "a.create"), ["x-a", "x-b"]);
}

#[test]
fn extensions_outside_the_operation_are_not_kept() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"}, "x-root": 1,
          "paths": {"/a": {"x-path-item": 1, "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "q", "in": "query", "x-parameter": 1, "schema": {"type": "string", "x-schema": 1}}],
            "responses": {"204": {"description": "ok", "x-response": 1}}}}}
        }"#,
    );

    assert_eq!(method(&forge, "a.get").extensions().len(), 0);
}

#[test]
fn operation_of_a_referenced_path_item_keeps_its_extensions() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"$ref": "#/components/pathItems/A"},
            "/b": {"get": {"x-forge-group-name": "b", "x-forge-method-name": "get", "x-b": 2,
              "responses": {"204": {"description": "ok"}}}}
          },
          "components": {"pathItems": {
            "A": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get", "x-a": 1,
              "responses": {"204": {"description": "ok"}}}}
          }}
        }"##,
    );

    assert_eq!(names(&forge, "a.get"), ["x-a"]);
    assert_eq!(names(&forge, "b.get"), ["x-b"]);
}
