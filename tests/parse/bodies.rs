use forge::{Body, Content, Forge, Scalar};

use crate::common::{field, kind, method, object, parse, scalar};

/// Returns the body of the method `a.create`.
#[track_caller]
fn body(forge: &Forge) -> Body<'_> {
    let create = method(forge, "a.create");
    let Some(body) = create.body() else {
        panic!("{create:?} has no body");
    };
    body
}

fn media_types<'f>(contents: impl Iterator<Item = Content<'f>>) -> Vec<&'f str> {
    contents.map(|content| content.media_type()).collect()
}

#[test]
fn body_has_its_required_and_description() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"required": true, "description": "The pet.",
              "content": {"application/json": {"schema": {"type": "string"}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let body = body(&forge);
    assert!(body.is_required());
    assert_eq!(body.description(), "The pet.");
}

#[test]
fn body_is_optional_by_default() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"application/json": {"schema": {"type": "string"}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(!body(&forge).is_required());
}

#[test]
fn contents_are_sorted_by_media_type() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {
              "text/plain": {"schema": {"type": "string"}},
              "multipart/form-data": {"schema": {"type": "object"}},
              "application/json": {"schema": {"type": "object"}}
            }},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(
        media_types(body(&forge).contents()),
        ["application/json", "multipart/form-data", "text/plain"]
    );
}

#[test]
fn json_is_application_json_before_other_json_types() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {
              "application/geo+json": {"schema": {"type": "object"}},
              "application/json": {"schema": {"type": "string"}}
            }},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(body(&forge).json().unwrap().media_type(), "application/json");
}

#[test]
fn json_is_otherwise_the_first_json_type() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"patch": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {
              "multipart/form-data": {"schema": {"type": "object"}},
              "application/scim+json": {"schema": {"type": "object"}},
              "application/merge-patch+json": {"schema": {"type": "object"}}
            }},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(
        body(&forge).json().unwrap().media_type(),
        "application/merge-patch+json"
    );
}

#[test]
fn json_ignores_case_and_parameters() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"Application/JSON; charset=utf-8": {"schema": {"type": "string"}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let json = body(&forge).json().unwrap();
    assert_eq!(json.media_type(), "Application/JSON; charset=utf-8");
    assert!(json.is_json());
}

#[test]
fn multipart_content_is_typed() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"multipart/form-data": {"schema": {
              "type": "object", "required": ["file"], "properties": {
                "file": {"type": "string", "format": "binary"},
                "name": {"type": "string"}
              }
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let body = body(&forge);
    assert_eq!(media_types(body.contents()), ["multipart/form-data"]);
    let form = object(body.contents().next().unwrap().ty());
    assert!(field(form, "file").is_required());
    assert_eq!(scalar(field(form, "file").ty()), Scalar::Binary);
    assert_eq!(scalar(field(form, "name").ty()), Scalar::String);
}

#[test]
fn octet_stream_content_of_a_binary_string_is_binary() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"application/octet-stream": {"schema": {
              "type": "string", "format": "binary"
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let content = body(&forge).contents().next().unwrap();
    assert!(!content.is_json());
    assert_eq!(scalar(content.ty()), Scalar::Binary);
}

#[test]
fn json_ignores_content_that_is_not_json() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {
              "multipart/form-data": {"schema": {"type": "object", "properties": {"name": {"type": "string"}}}},
              "text/plain": {"schema": {"type": "string"}}
            }},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let body = body(&forge);
    assert!(body.json().is_none());
    let kinds: Vec<String> = body.contents().map(|content| kind(content.ty())).collect();
    assert_eq!(kinds, ["Object", "String"]);
}

#[test]
fn content_that_is_not_json_without_a_schema_is_unknown() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"application/octet-stream": {}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let content = body(&forge).contents().next().unwrap();
    assert_eq!(scalar(content.ty()), Scalar::Unknown);
}

#[test]
fn content_without_a_schema_is_unknown() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"content": {"application/json": {}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let content = body(&forge).contents().next().unwrap();
    assert_eq!(scalar(content.ty()), Scalar::Unknown);
}

#[test]
fn body_ref_is_followed() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {"$ref": "#/components/requestBodies/Pet"},
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"requestBodies": {
            "Pet": {"required": true, "content": {"application/json": {"schema": {"type": "string"}}}}
          }}
        }"##,
    );

    let body = body(&forge);
    assert!(body.is_required());
    assert_eq!(scalar(body.json().unwrap().ty()), Scalar::String);
}

/// Returns a document whose method `a.create` has a JSON body of
/// `schema`, in OpenAPI `version`, with `schemas` as its schemas.
fn with_body_schema(version: &str, schema: &str, schemas: &str) -> String {
    format!(
        r#"{{
          "openapi": "{version}", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"post": {{"x-forge-group-name": "a", "x-forge-method-name": "create",
            "requestBody": {{"content": {{"application/json": {{"schema": {schema}}}}}}},
            "responses": {{"204": {{"description": "ok"}}}}}}}}}},
          "components": {{"schemas": {schemas}}}
        }}"#
    )
}

#[test]
fn content_has_its_schema_description() {
    let schema = r#"{"type": "string", "description": "A name."}"#;
    let forge = parse(&with_body_schema("3.0.3", schema, "{}"));

    assert_eq!(body(&forge).json().unwrap().description(), "A name.");
}

#[test]
fn content_description_follows_refs() {
    let forge = parse(&with_body_schema(
        "3.0.3",
        r##"{"$ref": "#/components/schemas/Name"}"##,
        r##"{"Name": {"$ref": "#/components/schemas/Text"}, "Text": {"type": "string", "description": "Some text."}}"##,
    ));

    assert_eq!(body(&forge).json().unwrap().description(), "Some text.");
}

#[test]
fn content_description_is_never_the_title() {
    let forge = parse(&with_body_schema(
        "3.0.3",
        r##"{"$ref": "#/components/schemas/Pet"}"##,
        r#"{"Pet": {"type": "object", "title": "A pet", "properties": {"name": {"type": "string"}}}}"#,
    ));

    let content = body(&forge).json().unwrap();
    assert_eq!(content.description(), "");
}

#[test]
fn content_description_next_to_a_ref_counts_from_3_1() {
    let schema = r##"{"$ref": "#/components/schemas/Pet", "description": "The new pet."}"##;
    let schemas = r#"{"Pet": {"type": "object", "description": "A pet."}}"#;

    let forge = parse(&with_body_schema("3.0.3", schema, schemas));
    assert_eq!(body(&forge).json().unwrap().description(), "A pet.");
    let forge = parse(&with_body_schema("3.1.0", schema, schemas));
    assert_eq!(body(&forge).json().unwrap().description(), "The new pet.");
}

#[test]
fn content_without_a_schema_has_no_description() {
    let forge = parse(&with_body_schema("3.0.3", "{}", "{}"));

    assert_eq!(body(&forge).json().unwrap().description(), "");
}

#[test]
fn response_content_has_its_schema_description() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {
              "schema": {"type": "string", "description": "The name."}}}}}}}}
        }"#,
    );

    let response = method(&forge, "a.get").responses().next().unwrap();
    assert_eq!(response.json().unwrap().description(), "The name.");
}

#[test]
fn content_description_comes_from_an_all_of_member_in_3_1() {
    let schema = r##"{"allOf": [{"$ref": "#/components/schemas/Pet"}, {"required": ["name"]}]}"##;
    let schemas = r#"{"Pet": {"type": "object", "description": "A pet."}}"#;

    let forge = parse(&with_body_schema("3.0.3", schema, schemas));
    assert_eq!(body(&forge).json().unwrap().description(), "");
    let forge = parse(&with_body_schema("3.1.0", schema, schemas));
    assert_eq!(body(&forge).json().unwrap().description(), "A pet.");
}
