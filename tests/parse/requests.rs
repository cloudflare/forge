use forge::{Json, Location, Name, Number, Scalar, Type};

use crate::common::{
    field, field_names, intersection, kind, kinds, method, model_of, object, parse, parse_err, scalar,
};

#[test]
fn path_param_is_a_required_request_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3",
          "info": { "title": "Example", "version": "1.0.0" },
          "paths": {
            "/zones/{zone_id}": {
              "get": {
                "x-fern-sdk-group-name": "zones",
                "x-fern-sdk-method-name": "get",
                "parameters": [
                  { "name": "zone_id", "in": "path", "required": true, "schema": { "type": "string" } }
                ],
                "responses": { "200": { "description": "OK" } }
              }
            }
          }
        }"#,
    );

    let get = method(&forge, "zones.get");
    let Some(Type::Object(params)) = get.request() else {
        panic!("want an object request, got {:?}", get.request());
    };
    let zone_id = field(params, "zone_id");
    assert!(zone_id.is_required());
    assert!(
        matches!(zone_id.ty(), Type::Scalar(s) if s.kind() == Scalar::String),
        "got {:?}",
        zone_id.ty()
    );
    assert_eq!(get.location(zone_id), Some(Location::Path));
}

#[test]
fn query_param_is_optional_and_exploded_by_default() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let list = method(&forge, "a.list");
    let page = field(object(list.request().unwrap()), "page");
    assert!(!page.is_required());
    assert_eq!(list.location(page), Some(Location::Query { exploded: true }));
}

#[test]
fn query_param_can_be_required() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "page", "in": "query", "required": true, "schema": {"type": "integer"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let list = method(&forge, "a.list");
    assert!(field(object(list.request().unwrap()), "page").is_required());
}

#[test]
fn query_param_with_explode_false_is_not_exploded() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "ids", "in": "query", "style": "form", "explode": false,
              "schema": {"type": "array", "items": {"type": "string"}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let list = method(&forge, "a.list");
    let ids = field(object(list.request().unwrap()), "ids");
    assert_eq!(list.location(ids), Some(Location::Query { exploded: false }));
}

#[test]
fn header_and_cookie_params_are_not_fields() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}},
              {"name": "session", "in": "cookie", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let get = method(&forge, "a.get");
    assert!(get.request().is_none(), "got {:?}", get.request());
}

#[test]
fn param_field_is_named_by_x_fern_parameter_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "q", "in": "query", "x-fern-parameter-name": "query", "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let q = field(object(method(&forge, "a.list").request().unwrap()), "q");
    assert_eq!(q.name(), &Name::new("query"));
}

#[test]
fn param_description_falls_back_to_an_inline_schema() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "own", "in": "query", "description": "Param.", "schema": {"type": "string", "description": "Schema."}},
              {"name": "inherited", "in": "query", "schema": {"type": "string", "description": "Schema."}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "own").description(), "Param.");
    assert_eq!(field(params, "inherited").description(), "Schema.");
}

#[test]
fn param_description_comes_from_a_ref_schema() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "own", "in": "query", "description": "Param.", "schema": {"$ref": "#/components/schemas/Id"}},
              {"name": "id", "in": "query", "schema": {"$ref": "#/components/schemas/Id"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Id": {"type": "string", "description": "An ID."}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "own").description(), "Param.");
    assert_eq!(field(params, "id").description(), "An ID.");
}

#[test]
fn param_description_follows_a_chain_of_refs() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"$ref": "#/components/schemas/Id"}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {
            "Id": {"$ref": "#/components/schemas/Uuid"},
            "Uuid": {"type": "string", "description": "A UUID."}
          }}
        }"##,
    );

    let params = object(method(&forge, "a.get").request().unwrap());
    assert_eq!(field(params, "id").description(), "A UUID.");
}

#[test]
fn param_description_is_never_a_schema_title() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "id", "in": "query", "schema": {"$ref": "#/components/schemas/Id"}},
              {"name": "inline", "in": "query", "schema": {"type": "string", "title": "Inline"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Id": {"type": "string", "title": "Identifier"}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "id").description(), "");
    assert_eq!(field(params, "inline").description(), "");
}

#[test]
fn description_next_to_a_param_schema_ref_is_its_own_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "id", "in": "query",
              "schema": {"$ref": "#/components/schemas/Id", "description": "The ID to find."}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Id": {"type": "string", "description": "An ID."}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "id").description(), "The ID to find.");
}

#[test]
fn param_description_comes_from_an_all_of_member_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "region", "in": "query",
              "schema": {"allOf": [{"$ref": "#/components/schemas/Region"}, {"default": "us"}]}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Region": {"type": "string", "description": "A region."}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "region").description(), "A region.");
}

#[test]
fn param_description_from_an_all_of_member_is_ignored_in_3_0() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "region", "in": "query",
              "schema": {"allOf": [{"$ref": "#/components/schemas/Region"}, {"default": "us"}]}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Region": {"type": "string", "description": "A region."}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "region").description(), "");
}

#[test]
fn param_ref_description_overrides_the_params_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"$ref": "#/components/parameters/Page", "description": "The page of pets."}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"parameters": {"Page": {"name": "page", "in": "query", "description": "A page.",
            "schema": {"type": "integer"}}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "page").description(), "The page of pets.");
}

#[test]
fn param_ref_description_is_ignored_in_3_0() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"$ref": "#/components/parameters/Page", "description": "The page of pets."}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"parameters": {"Page": {"name": "page", "in": "query", "description": "A page.",
            "schema": {"type": "integer"}}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "page").description(), "A page.");
}

#[test]
fn param_ref_without_a_description_has_the_params() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"$ref": "#/components/parameters/Page"}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"parameters": {"Page": {"name": "page", "in": "query", "description": "A page.",
            "schema": {"type": "integer"}}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "page").description(), "A page.");
}

#[test]
fn param_field_is_never_read_only() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [
              {"name": "id", "in": "path", "required": true, "schema": {"type": "string", "readOnly": true}},
              {"name": "since", "in": "query", "schema": {"$ref": "#/components/schemas/Since", "readOnly": true}},
              {"name": "page", "in": "query", "schema": {"$ref": "#/components/schemas/Page"}}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {
            "Since": {"type": "string"},
            "Page": {"type": "integer", "readOnly": true}
          }}
        }"##,
    );

    let params = object(method(&forge, "a.get").request().unwrap());
    for name in ["id", "since", "page"] {
        assert!(!field(params, name).is_read_only(), "{name}");
    }
}

#[test]
fn query_string_property_is_never_read_only() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "filter", "in": "querystring", "content": {"application/x-www-form-urlencoded": {"schema": {
              "type": "object", "properties": {"status": {"type": "string", "readOnly": true, "x-sensitive": true}}
            }}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let status = field(object(method(&forge, "a.list").request().unwrap()), "status");
    assert!(!status.is_read_only());
    assert!(status.is_sensitive());
}

#[test]
fn param_field_is_sensitive_when_its_schema_is() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "token", "in": "query", "schema": {"type": "string", "x-sensitive": true}},
              {"name": "page", "in": "query", "schema": {"type": "integer"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert!(field(params, "token").is_sensitive());
    assert!(!field(params, "page").is_sensitive());
}

#[test]
fn param_field_is_sensitive_when_its_ref_schema_is() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "token", "in": "query", "schema": {"$ref": "#/components/schemas/Token"}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {
            "Token": {"$ref": "#/components/schemas/Secret"},
            "Secret": {"type": "string", "x-sensitive": true}
          }}
        }"##,
    );

    assert!(field(object(method(&forge, "a.list").request().unwrap()), "token").is_sensitive());
}

#[test]
fn sensitive_next_to_a_param_schema_ref_counts_in_3_0() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "token", "in": "query",
              "schema": {"$ref": "#/components/schemas/Token", "x-sensitive": true}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Token": {"type": "string"}}}
        }"##,
    );

    assert!(field(object(method(&forge, "a.list").request().unwrap()), "token").is_sensitive());
}

#[test]
fn sensitive_on_the_param_itself_is_ignored() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "token", "in": "query", "x-sensitive": true, "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(!field(object(method(&forge, "a.list").request().unwrap()), "token").is_sensitive());
}

#[test]
fn param_ref_is_followed() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"$ref": "#/components/parameters/Page"}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"parameters": {"Page": {"name": "page", "in": "query", "schema": {"type": "integer"}}}}
        }"##,
    );

    let list = method(&forge, "a.list");
    let page = field(object(list.request().unwrap()), "page");
    assert_eq!(list.location(page), Some(Location::Query { exploded: true }));
}

#[test]
fn path_item_params_belong_to_each_operation() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get", "responses": {"204": {"description": "ok"}}},
            "delete": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "delete", "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    for name in ["a.get", "a.delete"] {
        let method = method(&forge, name);
        let id = field(object(method.request().unwrap()), "id");
        assert_eq!(method.location(id), Some(Location::Path));
    }
}

#[test]
fn operation_param_replaces_the_path_item_param() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "page", "in": "query", "schema": {"type": "string"}}],
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
              "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field_names(params), ["page"]);
    assert_eq!(scalar(field(params, "page").ty()), Scalar::Number(Number::Int));
}

#[test]
fn undeclared_path_placeholder_is_a_required_string() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let get = method(&forge, "a.get");
    let id = field(object(get.request().unwrap()), "id");
    assert!(id.is_required());
    assert_eq!(scalar(id.ty()), Scalar::String);
    assert_eq!(get.location(id), Some(Location::Path));
}

#[test]
fn params_are_in_path_template_then_declared_order() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{second}/{first}": {
            "parameters": [{"name": "item_query", "in": "query", "schema": {"type": "string"}}],
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
              "parameters": [
                {"name": "op_query", "in": "query", "schema": {"type": "string"}},
                {"name": "first", "in": "path", "required": true, "schema": {"type": "string"}},
                {"name": "second", "in": "path", "required": true, "schema": {"type": "string"}}
              ],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let params = object(method(&forge, "a.get").request().unwrap());
    assert_eq!(field_names(params), ["second", "first", "item_query", "op_query"]);
}

#[test]
fn query_string_object_is_query_fields() {
    let forge = parse(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "filter", "in": "querystring", "content": {"application/x-www-form-urlencoded": {"schema": {
              "type": "object", "properties": {"status": {"type": "string"}, "limit": {"type": "integer"}}
            }}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let list = method(&forge, "a.list");
    let params = object(list.request().unwrap());
    for name in ["status", "limit"] {
        let location = list.location(field(params, name));
        assert!(matches!(location, Some(Location::Query { .. })), "{name}: {location:?}");
    }
}

#[test]
fn no_params_and_no_body_is_no_request() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(method(&forge, "a.get").request().is_none());
}

#[test]
fn body_without_params_is_the_request() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "create",
            "requestBody": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "string"}}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(kind(method(&forge, "a.create").request().unwrap()), "Array");
}

#[test]
fn object_body_is_intersected_with_the_params() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object", "properties": {"name": {"type": "string"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let update = method(&forge, "a.update");
    let members: Vec<Type> = intersection(update.request().unwrap()).members().collect();
    let [params, body] = members[..] else {
        panic!("want two members, got {members:?}");
    };
    assert_eq!(update.location(field(object(params), "id")), Some(Location::Path));
    assert_eq!(update.location(field(object(body), "name")), None);
}

#[test]
fn model_body_is_intersected_with_the_params() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"Pet": {"type": "object", "properties": {"name": {"type": "string"}}}}}
        }"##,
    );

    let members: Vec<Type> = intersection(method(&forge, "a.update").request().unwrap())
        .members()
        .collect();
    assert_eq!(
        members.iter().map(|m| kind(*m)).collect::<Vec<_>>(),
        ["Object", "Model(Pet)"]
    );
}

#[test]
fn union_body_is_intersected_with_the_params() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "oneOf": [{"$ref": "#/components/schemas/Cat"}, {"$ref": "#/components/schemas/Dog"}]
            }}}},
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {
            "Cat": {"type": "object", "properties": {"meows": {"type": "boolean"}}},
            "Dog": {"type": "object", "properties": {"barks": {"type": "boolean"}}}
          }}
        }"##,
    );

    let members: Vec<Type> = intersection(method(&forge, "a.update").request().unwrap())
        .members()
        .collect();
    assert_eq!(
        members.iter().map(|m| kind(*m)).collect::<Vec<_>>(),
        ["Object", "Union"]
    );
}

#[test]
fn array_body_is_the_last_field_of_the_params() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "string"}}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let update = method(&forge, "a.update");
    let params = object(update.request().unwrap());
    assert_eq!(field_names(params), ["id", "body"]);
    let body = field(params, "body");
    assert_eq!(kind(body.ty()), "Array");
    assert_eq!(update.location(body), None);
}

#[test]
fn body_field_is_neither_read_only_nor_sensitive() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "array", "items": {"type": "string"}, "readOnly": true, "x-sensitive": true
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let body = field(object(method(&forge, "a.update").request().unwrap()), "body");
    assert!(!body.is_read_only());
    assert!(!body.is_sensitive());
}

#[test]
fn read_only_field_of_a_body_model_is_kept() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "create",
            "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}}}}},
          "components": {"schemas": {"Pet": {"type": "object", "properties": {
            "id": {"type": "string", "readOnly": true}, "name": {"type": "string"}
          }}}}
        }"##,
    );

    let pet = object(model_of(method(&forge, "a.create").request().unwrap()).ty());
    assert_eq!(field_names(pet), ["id", "name"]);
    assert!(field(pet, "id").is_read_only());
    assert!(!field(pet, "name").is_read_only());
}

#[test]
fn map_body_is_a_body_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object", "additionalProperties": {"type": "string"}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.update").request().unwrap());
    assert_eq!(kind(field(params, "body").ty()), "Object");
}

#[test]
fn unknown_body_is_a_body_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {}}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.update").request().unwrap());
    assert_eq!(scalar(field(params, "body").ty()), Scalar::Unknown);
}

#[test]
fn nullable_body_is_a_body_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object", "nullable": true, "properties": {"name": {"type": "string"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.update").request().unwrap());
    assert_eq!(kinds(field(params, "body").ty()), ["Null", "Object"]);
}

#[test]
fn body_with_the_name_of_a_param_is_a_body_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{zone_id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "zone_id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object", "properties": {"zoneId": {"type": "string"}, "name": {"type": "string"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.update").request().unwrap());
    assert_eq!(field_names(params), ["zone_id", "body"]);
}

#[test]
fn field_of_another_method_has_no_location() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get", "responses": {"204": {"description": "ok"}}},
            "delete": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "delete", "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let get = method(&forge, "a.get");
    let delete = method(&forge, "a.delete");
    let id = field(object(delete.request().unwrap()), "id");
    assert_eq!(get.location(id), None);
}

#[test]
fn body_that_is_not_json_is_an_unknown_body_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "upload",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"multipart/form-data": {"schema": {
              "type": "object", "properties": {"file": {"type": "string", "format": "binary"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.upload").request().unwrap());
    assert_eq!(field_names(params), ["id", "body"]);
    assert_eq!(scalar(field(params, "body").ty()), Scalar::Unknown);
}

#[test]
fn body_that_is_only_multipart_is_an_unknown_request() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "upload",
            "requestBody": {"content": {"multipart/form-data": {"schema": {
              "type": "object", "properties": {"file": {"type": "string", "format": "binary"}}
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let upload = method(&forge, "a.upload");
    assert_eq!(scalar(upload.request().unwrap()), Scalar::Unknown);
    assert_eq!(kind(upload.body().unwrap().contents().next().unwrap().ty()), "Object");
}

#[test]
fn path_param_missing_from_the_template_is_dropped() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [
              {"name": "id", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "account_id", "in": "path", "required": true, "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(field_names(object(method(&forge, "a.get").request().unwrap())), ["id"]);
}

#[test]
fn deprecated_query_param_is_a_deprecated_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "page", "in": "query", "deprecated": true, "schema": {"type": "integer"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(field(object(method(&forge, "a.list").request().unwrap()), "page").is_deprecated());
}

#[test]
fn deprecated_path_param_is_not_a_deprecated_field() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [{"name": "id", "in": "path", "required": true, "deprecated": true, "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(!field(object(method(&forge, "a.get").request().unwrap()), "id").is_deprecated());
}

#[test]
fn all_of_body_is_one_member_of_the_intersection() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "requestBody": {"content": {"application/json": {"schema": {
              "allOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]
            }}}},
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {
            "A": {"type": "object", "properties": {"a": {"type": "string"}}},
            "B": {"type": "object", "properties": {"b": {"type": "string"}}}
          }}
        }"##,
    );

    let members: Vec<Type> = intersection(method(&forge, "a.update").request().unwrap())
        .members()
        .collect();
    assert_eq!(
        members.iter().map(|m| kind(*m)).collect::<Vec<_>>(),
        ["Object", "Intersection"]
    );
}

#[test]
fn param_with_content_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "filter", "in": "query", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"status": {"type": "string"}}
            }}}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("GET /a") && err.contains("filter"), "{err}");
}

#[test]
fn query_style_other_than_form_is_an_error() {
    for (style, schema) in [
        ("spaceDelimited", r#"{"type": "array", "items": {"type": "string"}}"#),
        ("pipeDelimited", r#"{"type": "array", "items": {"type": "string"}}"#),
        (
            "deepObject",
            r#"{"type": "object", "properties": {"status": {"type": "string"}}}"#,
        ),
    ] {
        let err = parse_err(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
                "parameters": [{{"name": "filter", "in": "query", "style": "{style}", "schema": {schema}}}],
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert!(err.contains(style), "{style}: {err}");
    }
}

#[test]
fn two_query_string_params_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "one", "in": "querystring", "content": {"application/x-www-form-urlencoded": {"schema": {"type": "object"}}}},
              {"name": "two", "in": "querystring", "content": {"application/x-www-form-urlencoded": {"schema": {"type": "object"}}}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("GET /a"), "{err}");
}

#[test]
fn query_and_query_string_params_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
            "get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
              "parameters": [{"name": "filter", "in": "querystring", "content": {"application/x-www-form-urlencoded": {"schema": {"type": "object"}}}}],
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    assert!(err.contains("GET /a"), "{err}");
}

#[test]
fn body_field_is_required_when_the_body_is() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "replace",
              "requestBody": {"required": true, "content": {"application/json": {"schema": {"type": "array", "items": {"type": "string"}}}}},
              "responses": {"204": {"description": "ok"}}},
            "patch": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "append",
              "requestBody": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "string"}}}}},
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let body = |name| field(object(method(&forge, name).request().unwrap()), "body");
    assert!(body("a.replace").is_required());
    assert!(!body("a.append").is_required());
}

#[test]
fn params_with_equal_names_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{zone_id}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "parameters": [
              {"name": "zone_id", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "zoneId", "in": "query", "schema": {"type": "string"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("zone_id") && err.contains("zoneId"), "{err}");
}

#[test]
fn path_style_other_than_simple_is_an_error() {
    for style in ["label", "matrix"] {
        let err = parse_err(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a/{{id}}": {{"get": {{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
                "parameters": [{{"name": "id", "in": "path", "required": true, "style": "{style}", "schema": {{"type": "string"}}}}],
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert!(err.contains(style), "{style}: {err}");
    }
}

#[test]
fn param_field_has_the_default_of_its_schema() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "per_page", "in": "query", "schema": {"type": "integer", "default": 20}},
              {"name": "page", "in": "query", "schema": {"type": "integer"}}
            ],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "per_page").default(), Some(&Json::Number(20.0)));
    assert_eq!(field(params, "page").default(), None);
}

#[test]
fn param_field_has_the_default_of_its_ref_schema() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{order}": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [
              {"name": "order", "in": "path", "required": true, "schema": {"$ref": "#/components/schemas/Order"}},
              {"$ref": "#/components/parameters/Direction"}
            ],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {
            "parameters": {"Direction": {"name": "direction", "in": "query", "schema": {"$ref": "#/components/schemas/Direction"}}},
            "schemas": {
              "Order": {"$ref": "#/components/schemas/Field"},
              "Field": {"type": "string", "default": "name"},
              "Direction": {"type": "string", "enum": ["asc", "desc"], "default": "asc"}
            }
          }
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "order").default(), Some(&Json::String("name".into())));
    assert_eq!(field(params, "direction").default(), Some(&Json::String("asc".into())));
}

#[test]
fn default_next_to_a_param_schema_ref_is_its_own_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "per_page", "in": "query",
              "schema": {"$ref": "#/components/schemas/PerPage", "default": 50}}],
            "responses": {"204": {"description": "ok"}}}}},
          "components": {"schemas": {"PerPage": {"type": "integer", "default": 20}}}
        }"##,
    );

    let params = object(method(&forge, "a.list").request().unwrap());
    assert_eq!(field(params, "per_page").default(), Some(&Json::Number(50.0)));
}

#[test]
fn default_on_the_param_itself_is_ignored() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
            "parameters": [{"name": "per_page", "in": "query", "default": 20, "schema": {"type": "integer"}}],
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(
        field(object(method(&forge, "a.list").request().unwrap()), "per_page").default(),
        None
    );
}

#[test]
fn body_field_and_undeclared_placeholder_have_no_default() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a/{id}": {"put": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "update",
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "array", "items": {"type": "string"}, "default": ["x"]
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let params = object(method(&forge, "a.update").request().unwrap());
    assert_eq!(field(params, "body").default(), None);
    assert_eq!(field(params, "id").default(), None);
}

#[test]
fn array_body_keeps_its_max_items() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "create",
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "array", "items": {"type": "string"}, "maxItems": 100
            }}}},
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let Some(Type::Array(body)) = method(&forge, "a.create").request() else {
        panic!("want an array request");
    };
    assert_eq!(body.max_items(), Some(100));
}
