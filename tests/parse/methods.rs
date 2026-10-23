use forge::{Availability, HttpMethod, Name};

use crate::common::{group, method, parse, parse_err};

/// Returns a document with one method, `a.get`, at `/a`, whose operation
/// also has `fields`, which end with a comma.
fn operation_with(fields: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{{fields}
            "x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get", "responses": {"204": {"description": "ok"}}},
            "put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "put", "responses": {"204": {"description": "ok"}}},
            "post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "post", "responses": {"204": {"description": "ok"}}},
            "delete": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "delete", "responses": {"204": {"description": "ok"}}},
            "options": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "options", "responses": {"204": {"description": "ok"}}},
            "head": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "head", "responses": {"204": {"description": "ok"}}},
            "patch": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "patch", "responses": {"204": {"description": "ok"}}},
            "trace": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "trace", "responses": {"204": {"description": "ok"}}}
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
          "paths": {"/a": {"query": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "search",
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
            "COPY": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "copy",
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
            "GET": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
            "A": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
            "x-paths-extension": {"get": {"x-fern-sdk-group-name": "x", "x-fern-sdk-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/a": {
              "x-forge-commands": {"a": {"description": "A."}},
              "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
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
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
              "responses": {"204": {"description": "ok"}}},
            "additionalOperations": {"GET": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "shadowed",
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
          "webhooks": {"newPet": {"post": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "created",
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
          "paths": {"/subscribe": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "subscribe",
            "callbacks": {"event": {"{$request.query.url}": {"post": {
              "x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "event",
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
        let forge = parse(&operation_with(&format!(r#""x-fern-availability": "{written}","#)));

        assert_eq!(method(&forge, "a.get").availability(), Some(want), "{written}");
        assert_eq!(want.as_str(), written);
    }
}

#[test]
fn unknown_availability_is_an_error_naming_the_operation() {
    let err = parse_err(&operation_with(r#""x-fern-availability": "stable","#));

    assert!(err.contains(r#"GET /a: x-fern-availability "stable" is not"#), "{err}");
}

#[test]
fn availability_is_case_sensitive() {
    let err = parse_err(&operation_with(r#""x-fern-availability": "Beta","#));

    assert!(err.contains(r#"GET /a: x-fern-availability "Beta" is not"#), "{err}");
}

#[test]
fn availability_that_is_not_a_string_is_an_error() {
    let err = parse_err(&operation_with(r#""x-fern-availability": 1,"#));

    assert!(err.contains("expected a string"), "{err}");
}

#[test]
fn availability_and_deprecation_are_apart() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
              "deprecated": true, "x-fern-availability": "generally-available",
              "responses": {"204": {"description": "ok"}}},
            "put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "put",
              "x-fern-availability": "deprecated",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "post",
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

/// Returns a document with one operation, `GET /a`, with `fields`, which
/// end with a comma, and no other keys that name it.
fn named_by(fields: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{{fields}
            "responses": {{"204": {{"description": "ok"}}}}}}}}}}
        }}"#
    )
}

#[test]
fn dotted_operation_id_is_the_group_and_method() {
    let forge = parse(&named_by(r#""operationId": "pets.list","#));

    let list = method(&forge, "pets.list");
    assert_eq!(list.path(), "/a");
    assert_eq!(forge.groups().count(), 1);
}

#[test]
fn operation_id_splits_at_the_last_dot_into_a_group_path() {
    let forge = parse(&named_by(r#""operationId": "accounts.members.list","#));

    assert_eq!(method(&forge, "accounts.members.list").path(), "/a");
    assert_eq!(group(&forge, "accounts").methods().len(), 0);
}

#[test]
fn operation_id_names_are_names() {
    let forge = parse(&named_by(r#""operationId": "userAccounts.listAll","#));

    assert_eq!(method(&forge, "user_accounts.list_all").path(), "/a");
}

#[test]
fn operation_id_without_a_dot_is_not_a_method() {
    let forge = parse(&named_by(r#""operationId": "listPets","#));

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn fern_extensions_win_over_operation_id() {
    let forge = parse(&operation_with(r#""operationId": "pets.list","#));

    assert_eq!(method(&forge, "a.get").path(), "/a");
    assert_eq!(forge.groups().count(), 1);
}

#[test]
fn one_fern_extension_falls_back_to_operation_id() {
    for fields in [
        r#""x-fern-sdk-group-name": "a", "operationId": "pets.list","#,
        r#""x-fern-sdk-method-name": "get", "operationId": "pets.list","#,
        r#""x-fern-sdk-group-name": "", "x-fern-sdk-method-name": "get", "operationId": "pets.list","#,
        r#""x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "", "operationId": "pets.list","#,
    ] {
        let forge = parse(&named_by(fields));

        assert_eq!(method(&forge, "pets.list").path(), "/a", "{fields}");
        assert_eq!(forge.groups().count(), 1, "{fields}");
    }
}

#[test]
fn ignored_operation_with_an_operation_id_is_not_a_method() {
    let forge = parse(&named_by(r#""operationId": "pets.list", "x-fern-ignore": true,"#));

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn operation_id_group_name_without_letters_is_an_error_naming_the_operation() {
    for operation_id in ["a..b.list", ".list", "!.list"] {
        let err = parse_err(&named_by(&format!(r#""operationId": "{operation_id}","#)));

        assert!(
            err.contains("GET /a: operationId has a group name with no letters or digits"),
            "{operation_id}: {err}"
        );
    }
}

#[test]
fn operation_id_method_name_without_letters_is_an_error_naming_the_operation() {
    for operation_id in ["pets.", "pets.-"] {
        let err = parse_err(&named_by(&format!(r#""operationId": "{operation_id}","#)));

        assert!(
            err.contains("GET /a: operationId has a method name with no letters or digits"),
            "{operation_id}: {err}"
        );
    }
}

#[test]
fn operation_id_that_is_not_a_string_is_an_error() {
    let err = parse_err(&named_by(r#""operationId": 1,"#));

    assert!(err.contains("expected a string"), "{err}");
}

#[test]
fn fern_and_operation_id_methods_with_equal_names_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"operationId": "pets.list",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert!(err.contains(r#"GET /b: method "list" is also GET /a"#), "{err}");
}
