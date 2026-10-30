use forge::{Forge, Json, Name, Number, Object, Scalar};

use crate::common::{field, field_names, kind, method, model, models, object, parse, parse_err, scalar};

/// Returns the headers of the method at `path`, which must have some.
#[track_caller]
fn headers<'f>(forge: &'f Forge, path: &str) -> Object<'f> {
    let method = method(forge, path);
    let Some(headers) = method.headers() else {
        panic!("{method:?} has no headers");
    };
    headers
}

#[test]
fn header_param_is_a_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "X-Request-ID", "in": "header", "required": true, "description": "Traces the request.",
                "schema": {"type": "integer", "format": "int64"}},
              {"name": "If-None-Match", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let headers = headers(&forge, "a.get");
    let request_id = field(headers, "X-Request-ID");
    assert_eq!(request_id.name(), &Name::new("x request id"));
    assert!(request_id.is_required());
    assert_eq!(request_id.description(), "Traces the request.");
    assert_eq!(scalar(request_id.ty()), Scalar::Number(Number::Int64));
    let if_none_match = field(headers, "If-None-Match");
    assert!(!if_none_match.is_required());
    assert_eq!(scalar(if_none_match.ty()), Scalar::String);
}

#[test]
fn header_field_is_named_by_x_forge_parameter_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "cf-r2-jurisdiction", "in": "header", "x-forge-parameter-name": "jurisdiction",
              "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let jurisdiction = field(headers(&forge, "a.get"), "cf-r2-jurisdiction");
    assert_eq!(jurisdiction.name(), &Name::new("jurisdiction"));
}

#[test]
fn header_description_is_the_params_or_else_its_schemas() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "X-Own", "in": "header", "description": "Param.", "schema": {"$ref": "#/components/schemas/Id"}},
              {"name": "X-Inherited", "in": "header", "schema": {"$ref": "#/components/schemas/Id"}},
              {"name": "X-Titled", "in": "header", "schema": {"type": "string", "title": "Titled"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Id": {"type": "string", "description": "An ID."}}}
        }"##,
    );

    let headers = headers(&forge, "a.get");
    assert_eq!(field(headers, "X-Own").description(), "Param.");
    assert_eq!(field(headers, "X-Inherited").description(), "An ID.");
    assert_eq!(field(headers, "X-Titled").description(), "");
}

#[test]
fn deprecated_header_is_a_deprecated_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "X-Old", "in": "header", "deprecated": true, "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(field(headers(&forge, "a.get"), "X-Old").is_deprecated());
}

#[test]
fn header_is_sensitive_when_its_schema_is_and_never_read_only() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "X-Api-Key", "in": "header", "schema": {"type": "string", "x-forge-sensitive": true, "readOnly": true}},
              {"name": "X-Auth-Token", "in": "header", "schema": {"$ref": "#/components/schemas/Token"}},
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Token": {"type": "string", "x-forge-sensitive": true, "readOnly": true}}}
        }"##,
    );

    let headers = headers(&forge, "a.get");
    for name in ["X-Api-Key", "X-Auth-Token"] {
        assert!(field(headers, name).is_sensitive(), "{name}");
        assert!(!field(headers, name).is_read_only(), "{name}");
    }
    assert!(!field(headers, "X-Trace").is_sensitive());
}

#[test]
fn header_has_the_default_of_its_schema() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "X-Version", "in": "header", "schema": {"type": "string", "default": "2024-01-01"}},
              {"name": "X-Retries", "in": "header", "schema": {"$ref": "#/components/schemas/Retries"}},
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Retries": {"type": "integer", "default": 3}}}
        }"##,
    );

    let headers = headers(&forge, "a.get");
    assert_eq!(
        field(headers, "X-Version").default(),
        Some(&Json::String("2024-01-01".into()))
    );
    assert_eq!(field(headers, "X-Retries").default(), Some(&Json::Number(3.0)));
    assert_eq!(field(headers, "X-Trace").default(), None);
}

#[test]
fn header_param_ref_is_followed() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "parameters": [{"$ref": "#/components/parameters/IdempotencyKey"}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"parameters": {"IdempotencyKey": {"name": "Idempotency-Key", "in": "header",
            "description": "Makes retries safe.", "schema": {"type": "string"}}}}
        }"##,
    );

    let key = field(headers(&forge, "a.create"), "Idempotency-Key");
    assert_eq!(key.description(), "Makes retries safe.");
}

#[test]
fn path_item_headers_belong_to_each_operation() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "X-Account", "in": "header", "schema": {"type": "string"}}],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get", "responses": {"204": {"description": "ok"}}},
            "delete": {"x-forge-group-name": "a", "x-forge-method-name": "delete", "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    for name in ["a.get", "a.delete"] {
        assert_eq!(field_names(headers(&forge, name)), ["X-Account"], "{name}");
    }
}

#[test]
fn operation_header_replaces_the_path_item_header() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "X-Limit", "in": "header", "schema": {"type": "string"}}],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "parameters": [{"name": "X-Limit", "in": "header", "required": true, "schema": {"type": "integer"}}],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let headers = headers(&forge, "a.get");
    assert_eq!(field_names(headers), ["X-Limit"]);
    let limit = field(headers, "X-Limit");
    assert!(limit.is_required());
    assert_eq!(scalar(limit.ty()), Scalar::Number(Number::Int));
}

#[test]
fn operation_header_replaces_the_path_item_header_ignoring_case() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "X-Request-ID", "in": "header", "schema": {"type": "string"}}],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "parameters": [{"name": "x-request-id", "in": "header", "schema": {"type": "integer"}}],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let headers = headers(&forge, "a.get");
    assert_eq!(field_names(headers), ["x-request-id"]);
    assert_eq!(scalar(field(headers, "x-request-id").ty()), Scalar::Number(Number::Int));
}

#[test]
fn query_param_does_not_replace_a_header_with_its_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "version", "in": "header", "schema": {"type": "string"}}],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "parameters": [{"name": "version", "in": "query", "schema": {"type": "string"}}],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert_eq!(field_names(get.headers().unwrap()), ["version"]);
    assert_eq!(field_names(object(get.request().unwrap())), ["version"]);
}

#[test]
fn headers_are_in_declared_order_the_path_items_first() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [
              {"name": "X-First", "in": "header", "schema": {"type": "string"}},
              {"name": "X-Second", "in": "header", "schema": {"type": "string"}}
            ],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "parameters": [
                {"name": "X-Third", "in": "header", "schema": {"type": "string"}},
                {"name": "x-first", "in": "header", "schema": {"type": "string"}}
              ],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    assert_eq!(
        field_names(headers(&forge, "a.get")),
        ["x-first", "X-Second", "X-Third"]
    );
}

#[test]
fn headers_with_equal_names_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "X-Rate-Limit", "in": "header", "schema": {"type": "string"}},
              {"name": "X_Rate_Limit", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(
        err.contains("GET /a") && err.contains("X-Rate-Limit") && err.contains("X_Rate_Limit"),
        "{err}"
    );
}

#[test]
fn path_item_headers_differing_in_case_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [
              {"name": "X-A", "in": "header", "schema": {"type": "string"}},
              {"name": "x-a", "in": "header", "schema": {"type": "string"}}
            ],
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    assert!(err.contains("X-A") && err.contains("x-a"), "{err}");
}

#[test]
fn header_and_param_with_equal_names_are_not_an_error() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{account_id}": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "account_id", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "Account-Id", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(field_names(headers(&forge, "a.get")), ["Account-Id"]);
}

#[test]
fn cookie_params_are_not_headers() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [
              {"name": "session", "in": "cookie", "schema": {"type": "string"}},
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(field_names(headers(&forge, "a.get")), ["X-Trace"]);
}

#[test]
fn method_with_only_cookie_params_has_no_headers() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "session", "in": "cookie", "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(method(&forge, "a.get").headers().is_none());
}

#[test]
fn accept_content_type_and_authorization_headers_are_kept() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"put": {"x-forge-group-name": "a", "x-forge-method-name": "upload",
            "parameters": [
              {"name": "Content-Type", "in": "header", "required": true, "schema": {"type": "string"}},
              {"name": "Content-Length", "in": "header", "schema": {"type": "integer"}},
              {"name": "Accept", "in": "header", "schema": {"type": "string"}},
              {"name": "Authorization", "in": "header", "schema": {"type": "string"}}
            ],
            "requestBody": {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let headers = headers(&forge, "a.upload");
    assert_eq!(
        field_names(headers),
        ["Content-Type", "Content-Length", "Accept", "Authorization"]
    );
    assert!(field(headers, "Content-Type").is_required());
}

#[test]
fn method_without_header_params_has_no_headers() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
            "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let list = method(&forge, "a.list");
    assert!(list.headers().is_none(), "got {:?}", list.headers());
}

#[test]
fn headers_are_not_in_the_request() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "parameters": [
              {"name": "page", "in": "query", "schema": {"type": "integer"}},
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
            ],
            "requestBody": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "string"}}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let create = method(&forge, "a.create");
    assert_eq!(field_names(object(create.request().unwrap())), ["page", "body"]);
    assert_eq!(create.location(field(create.headers().unwrap(), "X-Trace")), None);
}

#[test]
fn method_with_only_headers_has_no_request() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "X-Trace", "in": "header", "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert!(get.request().is_none(), "got {:?}", get.request());
    assert_eq!(field_names(get.headers().unwrap()), ["X-Trace"]);
}

#[test]
fn model_used_only_by_a_header_is_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": ["a", "b"], "x-forge-method-name": "get",
            "parameters": [{"name": "cf-r2-storage-class", "in": "header", "schema": {"$ref": "#/components/schemas/StorageClass"}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"StorageClass": {"type": "string", "enum": ["Standard", "InfrequentAccess"]}}}
        }"##,
    );

    assert_eq!(models(&forge), ["StorageClass"]);
    let class = field(headers(&forge, "a.b.get"), "cf-r2-storage-class");
    assert_eq!(kind(class.ty()), "Model(StorageClass)");
    let group = model(&forge, "StorageClass").group().unwrap();
    assert_eq!(group.path().collect::<Vec<_>>(), [&Name::new("a"), &Name::new("b")]);
}

#[test]
fn header_with_content_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "X-Filter", "in": "header", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"status": {"type": "string"}}
            }}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(
        err.contains("GET /a") && err.contains("X-Filter") && err.contains("content"),
        "{err}"
    );
}

#[test]
fn header_style_other_than_simple_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "X-Ids", "in": "header", "style": "form",
              "schema": {"type": "array", "items": {"type": "string"}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("X-Ids") && err.contains("form"), "{err}");
}
