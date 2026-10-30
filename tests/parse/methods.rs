use forge::{Availability, HttpMethod, Name};

use crate::common::{group, method, parse, parse_err};

/// Returns a document with one method, `a.get`, at `/a`, whose operation
/// also has `fields`, which end with a comma.
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

#[test]
fn each_operation_field_is_its_http_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get", "responses": {"204": {"description": "ok"}}},
            "put": {"x-forge-group-name": "a", "x-forge-method-name": "put", "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-group-name": "a", "x-forge-method-name": "post", "responses": {"204": {"description": "ok"}}},
            "delete": {"x-forge-group-name": "a", "x-forge-method-name": "delete", "responses": {"204": {"description": "ok"}}},
            "options": {"x-forge-group-name": "a", "x-forge-method-name": "options", "responses": {"204": {"description": "ok"}}},
            "head": {"x-forge-group-name": "a", "x-forge-method-name": "head", "responses": {"204": {"description": "ok"}}},
            "patch": {"x-forge-group-name": "a", "x-forge-method-name": "patch", "responses": {"204": {"description": "ok"}}},
            "trace": {"x-forge-group-name": "a", "x-forge-method-name": "trace", "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    for (name, want) in [
        ("get", HttpMethod::Get),
        ("put", HttpMethod::Put),
        ("post", HttpMethod::Post),
        ("delete", HttpMethod::Delete),
        ("options", HttpMethod::Options),
        ("head", HttpMethod::Head),
        ("patch", HttpMethod::Patch),
        ("trace", HttpMethod::Trace),
    ] {
        let method = method(&forge, &format!("a.{name}"));
        assert_eq!(method.http_method(), &want);
        assert_eq!(method.path(), "/a");
    }
}

#[test]
fn query_operation_is_query() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"query": {"x-forge-group-name": "a", "x-forge-method-name": "search",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(method(&forge, "a.search").http_method(), &HttpMethod::Query);
}

#[test]
fn additional_operation_is_its_method_as_written() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"additionalOperations": {
            "COPY": {"x-forge-group-name": "a", "x-forge-method-name": "copy",
              "responses": {"204": {"description": "ok"}}}
          }}}
        }"#,
    );

    assert_eq!(
        method(&forge, "a.copy").http_method(),
        &HttpMethod::Other("COPY".to_string())
    );
}

#[test]
fn additional_operation_with_the_method_of_a_field_is_that_variant() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"additionalOperations": {
            "GET": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}
          }}}
        }"#,
    );

    assert_eq!(method(&forge, "a.get").http_method(), &HttpMethod::Get);
}

#[test]
fn additional_operation_methods_are_case_sensitive() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"additionalOperations": {
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}
          }}}
        }"#,
    );

    assert_eq!(
        method(&forge, "a.get").http_method(),
        &HttpMethod::Other("get".to_string())
    );
}

#[test]
fn method_has_the_summary_description_and_deprecation_of_its_operation() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "summary": "Get an a.", "description": "Gets an a.", "deprecated": true,
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert_eq!(get.summary(), "Get an a.");
    assert_eq!(get.description(), "Gets an a.");
    assert!(get.is_deprecated());
}

#[test]
fn method_without_docs_is_empty_and_not_deprecated() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert_eq!(get.summary(), "");
    assert_eq!(get.description(), "");
    assert!(!get.is_deprecated());
}

#[test]
fn path_item_ref_is_followed() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"$ref": "#/components/pathItems/A"}},
          "components": {"pathItems": {
            "A": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }}
        }"##,
    );

    assert_eq!(method(&forge, "a.get").path(), "/a");
}

#[test]
fn extensions_in_paths_and_path_items_are_not_operations() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "x-paths-extension": {"get": {"x-forge-group-name": "x", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/a": {
              "x-forge-commands": {"a": {"description": "A."}},
              "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
                "responses": {"204": {"description": "ok"}}}
            }
          }
        }"#,
    );

    assert_eq!(forge.groups().count(), 1);
    assert_eq!(group(&forge, "a").methods().len(), 1);
}

#[test]
fn additional_operation_with_the_method_of_a_present_field_is_skipped() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}},
            "additionalOperations": {"GET": {"x-forge-group-name": "a", "x-forge-method-name": "shadowed",
              "responses": {"204": {"description": "ok"}}}}
          }}
        }"#,
    );

    let names: Vec<&Name> = group(&forge, "a").methods().map(|method| method.name()).collect();
    assert_eq!(names, [&Name::new("get")]);
}

#[test]
fn webhooks_are_not_methods() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "webhooks": {"newPet": {"post": {"x-forge-group-name": "pets", "x-forge-method-name": "created",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn callbacks_are_not_methods() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/subscribe": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "subscribe",
            "callbacks": {"event": {"{$request.query.url}": {"post": {
              "x-forge-group-name": "a", "x-forge-method-name": "event",
              "responses": {"204": {"description": "ok"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(group(&forge, "a").methods().len(), 1);
}

#[test]
fn method_without_the_extensions_is_listed_unconfirmed_and_of_no_availability() {
    let forge = parse(&operation_with(""));

    let get = method(&forge, "a.get");
    assert!(!get.is_hidden());
    assert_eq!(get.confirmation(), None);
    assert_eq!(get.availability(), None);
}

#[test]
fn hidden_method_is_hidden_and_still_a_method() {
    let forge = parse(&operation_with(r#""x-forge-hidden": true,"#));

    assert!(method(&forge, "a.get").is_hidden());
}

#[test]
fn method_hidden_false_is_not_hidden() {
    let forge = parse(&operation_with(r#""x-forge-hidden": false,"#));

    assert!(!method(&forge, "a.get").is_hidden());
}

#[test]
fn hidden_that_is_not_a_boolean_is_an_error() {
    let err = parse_err(&operation_with(r#""x-forge-hidden": "true","#));

    assert!(err.contains("expected a boolean"), "{err}");
}

#[test]
fn confirmation_is_the_sentence_as_written() {
    let forge = parse(&operation_with(
        r#""x-forge-require-confirmation": "This operation deletes the database.","#,
    ));

    assert_eq!(
        method(&forge, "a.get").confirmation(),
        Some("This operation deletes the database.")
    );
}

#[test]
fn empty_confirmation_is_some() {
    let forge = parse(&operation_with(r#""x-forge-require-confirmation": "","#));

    assert_eq!(method(&forge, "a.get").confirmation(), Some(""));
}

#[test]
fn confirmation_that_is_not_a_string_is_an_error() {
    let err = parse_err(&operation_with(r#""x-forge-require-confirmation": true,"#));

    assert!(err.contains("expected a string"), "{err}");
}

#[test]
fn each_availability_is_its_variant() {
    for (written, want) in [
        ("alpha", Availability::Alpha),
        ("beta", Availability::Beta),
        ("preview", Availability::Preview),
        ("generally-available", Availability::GenerallyAvailable),
        ("deprecated", Availability::Deprecated),
    ] {
        let forge = parse(&operation_with(&format!(r#""x-forge-availability": "{written}","#)));

        assert_eq!(method(&forge, "a.get").availability(), Some(want), "{written}");
        assert_eq!(want.as_str(), written);
    }
}

#[test]
fn unknown_availability_is_an_error_naming_the_operation() {
    let err = parse_err(&operation_with(r#""x-forge-availability": "stable","#));

    assert!(err.contains(r#"GET /a: x-forge-availability "stable" is not"#), "{err}");
}

#[test]
fn availability_is_case_sensitive() {
    let err = parse_err(&operation_with(r#""x-forge-availability": "Beta","#));

    assert!(err.contains(r#"GET /a: x-forge-availability "Beta" is not"#), "{err}");
}

#[test]
fn availability_that_is_not_a_string_is_an_error() {
    let err = parse_err(&operation_with(r#""x-forge-availability": 1,"#));

    assert!(err.contains("expected a string"), "{err}");
}

#[test]
fn availability_and_deprecation_are_apart() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "deprecated": true, "x-forge-availability": "generally-available",
              "responses": {"204": {"description": "ok"}}},
            "put": {"x-forge-group-name": "a", "x-forge-method-name": "put",
              "x-forge-availability": "deprecated",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-group-name": "a", "x-forge-method-name": "post",
              "deprecated": true, "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert!(get.is_deprecated());
    assert_eq!(get.availability(), Some(Availability::GenerallyAvailable));
    let put = method(&forge, "a.put");
    assert!(!put.is_deprecated());
    assert_eq!(put.availability(), Some(Availability::Deprecated));
    let post = method(&forge, "a.post");
    assert!(post.is_deprecated());
    assert_eq!(post.availability(), None);
}

#[test]
fn x_forge_method_without_name_is_not_a_method_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": ["a"], "x-forge-method": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}
