use forge::{Json, Scalar};

use crate::common::{
    field, kind, kinds, model_of, models, non_null, object, parse, parse_err, responding_with_schemas, response_type,
    scalar,
};

#[test]
fn ref_to_a_schema_is_a_model_even_a_primitive() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Id"}"##,
        r#"{"Id": {"type": "string"}}"#,
    ));

    let id = model_of(response_type(&forge, "a.get"));
    assert_eq!(id.schema_name(), "Id");
    assert_eq!(scalar(id.ty()), Scalar::String);
}

#[test]
fn ref_into_a_schema_is_written_in_place() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Account/properties/id"}"##,
        r#"{"Account": {"type": "object", "properties": {"id": {"type": "string"}}}}"#,
    ));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::String);
    assert!(models(&forge).is_empty(), "{:?}", models(&forge));
}

#[test]
fn recursive_ref_written_in_place_is_an_error() {
    let err = parse_err(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Tree/properties/node"}"##,
        r##"{"Tree": {"type": "object", "properties": {
          "node": {"type": "object", "properties": {"next": {"$ref": "#/components/schemas/Tree/properties/node"}}}
        }}}"##,
    ));

    assert!(err.contains("#/components/schemas/Tree/properties/node"), "{err}");
}

#[test]
fn external_ref_is_an_error() {
    let err = parse_err(&responding_with_schemas(
        r#"{"$ref": "other.json#/components/schemas/Zone"}"#,
        "{}",
    ));

    assert!(err.contains("other.json#/components/schemas/Zone"), "{err}");
}

#[test]
fn siblings_of_a_ref_are_ignored_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Zone", "nullable": true, "properties": {"extra": {"type": "string"}}}"##,
        r#"{"Zone": {"type": "object", "properties": {"id": {"type": "string"}}}}"#,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(Zone)");
}

#[test]
fn annotations_next_to_a_ref_keep_the_model_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "$ref": "#/components/schemas/Zone", "description": "The zone.", "deprecated": true
            }}}}}}}},
          "components": {"schemas": {"Zone": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(Zone)");
}

#[test]
fn shape_next_to_a_ref_is_intersected_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "$ref": "#/components/schemas/Zone", "properties": {"extra": {"type": "string"}}
            }}}}}}}},
          "components": {"schemas": {"Zone": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(Zone)", "Object"]);
}

#[test]
fn nullable_next_to_a_ref_is_a_union_with_null_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "$ref": "#/components/schemas/Zone", "nullable": true
            }}}}}}}},
          "components": {"schemas": {"Zone": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model_of(non_null(response_type(&forge, "a.get"))).schema_name(), "Zone");
}

#[test]
fn empty_ref_is_an_error() {
    let err = parse_err(&responding_with_schemas(r#"{"$ref": ""}"#, "{}"));

    assert!(err.contains(r#"$ref """#), "{err}");
}

#[test]
fn property_that_is_a_ref_has_the_description_of_its_schema() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"zone": {"$ref": "#/components/schemas/Zone"}}}"##,
        r#"{"Zone": {"type": "string", "description": "A zone."}}"#,
    ));

    let zone = field(object(response_type(&forge, "a.get")), "zone");
    assert_eq!(zone.description(), "A zone.");
}

#[test]
fn property_description_follows_a_chain_of_refs() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id"}}}"##,
        r##"{"Id": {"$ref": "#/components/schemas/Uuid"}, "Uuid": {"type": "string", "description": "A UUID."}}"##,
    ));

    let id = field(object(response_type(&forge, "a.get")), "id");
    assert_eq!(id.description(), "A UUID.");
}

#[test]
fn property_description_is_never_the_title_of_its_schema() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"zone": {"$ref": "#/components/schemas/Zone"}}}"##,
        r#"{"Zone": {"type": "string", "title": "Zone"}}"#,
    ));

    let zone = field(object(response_type(&forge, "a.get")), "zone");
    assert_eq!(zone.description(), "");
}

#[test]
fn description_next_to_a_property_ref_is_its_own_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"home": {"$ref": "#/components/schemas/Zone", "description": "The home zone."}}
            }}}}}}}},
          "components": {"schemas": {"Zone": {"type": "string", "description": "A zone."}}}
        }"##,
    );

    let home = field(object(response_type(&forge, "a.get")), "home");
    assert_eq!(home.description(), "The home zone.");
}

#[test]
fn description_next_to_a_property_ref_is_ignored_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"home": {"$ref": "#/components/schemas/Zone", "description": "The home zone."}}}"##,
        r#"{"Zone": {"type": "string", "description": "A zone."}}"#,
    ));

    let home = field(object(response_type(&forge, "a.get")), "home");
    assert_eq!(home.description(), "A zone.");
}

/// Returns a 3.1 document responding with `schema`, with `schemas` as its
/// schemas.
fn responding_with_schemas_3_1(schema: &str, schemas: &str) -> String {
    responding_with_schemas(schema, schemas).replacen("3.0.3", "3.1.0", 1)
}

#[test]
fn property_description_comes_from_an_all_of_member_in_3_1() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {
          "region": {"allOf": [{"$ref": "#/components/schemas/Region"}, {"default": "us"}]},
          "until": {"allOf": [{"type": "string", "description": "The end."}, {"$ref": "#/components/schemas/Region"}]}
        }}"##,
        r#"{"Region": {"type": "string", "description": "A region."}}"#,
    ));

    let ty = object(response_type(&forge, "a.get"));
    assert_eq!(field(ty, "region").description(), "A region.");
    assert_eq!(field(ty, "until").description(), "The end.");
}

#[test]
fn property_description_comes_from_a_one_member_all_of_in_3_1() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {"page": {"allOf": [{"$ref": "#/components/schemas/Page"}]}}}"##,
        r#"{"Page": {"type": "integer", "description": "The page."}}"#,
    ));

    assert_eq!(
        field(object(response_type(&forge, "a.get")), "page").description(),
        "The page."
    );
}

#[test]
fn property_description_follows_all_of_inside_a_ref_in_3_1() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {"region": {"$ref": "#/components/schemas/Region"}}}"##,
        r##"{
          "Region": {"allOf": [{"$ref": "#/components/schemas/Code"}]},
          "Code": {"type": "string", "description": "A code."}
        }"##,
    ));

    assert_eq!(
        field(object(response_type(&forge, "a.get")), "region").description(),
        "A code."
    );
}

#[test]
fn own_description_comes_before_all_of_members_in_3_1() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {
          "region": {"description": "Where.", "allOf": [{"$ref": "#/components/schemas/Region"}]}
        }}"##,
        r#"{"Region": {"type": "string", "description": "A region."}}"#,
    ));

    assert_eq!(
        field(object(response_type(&forge, "a.get")), "region").description(),
        "Where."
    );
}

#[test]
fn ref_description_comes_before_all_of_members_in_3_1() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {
          "region": {"$ref": "#/components/schemas/Region", "allOf": [{"description": "Other."}]}
        }}"##,
        r#"{"Region": {"type": "string", "description": "A region."}}"#,
    ));

    assert_eq!(
        field(object(response_type(&forge, "a.get")), "region").description(),
        "A region."
    );
}

#[test]
fn property_description_never_comes_from_one_of_or_any_of_members() {
    let forge = parse(&responding_with_schemas_3_1(
        r#"{"type": "object", "properties": {
          "since": {"oneOf": [{"type": "string", "description": "A date."}, {"type": "integer"}]},
          "until": {"anyOf": [{"type": "string", "description": "A date."}, {"type": "integer"}]}
        }}"#,
        "{}",
    ));

    let ty = object(response_type(&forge, "a.get"));
    assert_eq!(field(ty, "since").description(), "");
    assert_eq!(field(ty, "until").description(), "");
}

#[test]
fn all_of_member_description_is_ignored_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {
          "region": {"allOf": [{"$ref": "#/components/schemas/Region"}, {"default": "us"}]},
          "page": {"allOf": [{"$ref": "#/components/schemas/Region"}]}
        }}"##,
        r#"{"Region": {"type": "string", "description": "A region."}}"#,
    ));

    let ty = object(response_type(&forge, "a.get"));
    assert_eq!(field(ty, "region").description(), "");
    assert_eq!(field(ty, "page").description(), "");
}

#[test]
fn all_of_that_leads_back_to_itself_has_no_description() {
    let forge = parse(&responding_with_schemas_3_1(
        r##"{"type": "object", "properties": {"a": {"$ref": "#/components/schemas/A"}}}"##,
        r##"{
          "A": {"type": "object", "allOf": [{"$ref": "#/components/schemas/B"}, {"$ref": "#/components/schemas/A"}]},
          "B": {"type": "object", "allOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]}
        }"##,
    ));

    assert_eq!(field(object(response_type(&forge, "a.get")), "a").description(), "");
}

#[test]
fn property_that_is_a_ref_is_read_only_when_its_schema_is() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id"}}}"##,
        r#"{"Id": {"type": "string", "readOnly": true}}"#,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn property_read_only_follows_a_chain_of_refs() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id"}}}"##,
        r##"{"Id": {"$ref": "#/components/schemas/Uuid"}, "Uuid": {"type": "string", "readOnly": true}}"##,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn read_only_next_to_a_property_ref_counts_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id", "readOnly": true}}
            }}}}}}}},
          "components": {"schemas": {"Id": {"type": "string"}}}
        }"##,
    );

    assert!(field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn read_only_next_to_a_property_ref_is_ignored_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id", "readOnly": true}}}"##,
        r#"{"Id": {"type": "string"}}"#,
    ));

    assert!(!field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn read_only_false_next_to_a_ref_does_not_undo_its_schemas_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"id": {"$ref": "#/components/schemas/Id", "readOnly": false}}
            }}}}}}}},
          "components": {"schemas": {"Id": {"type": "string", "readOnly": true}}}
        }"##,
    );

    assert!(field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn property_that_is_a_ref_is_sensitive_when_its_schema_is() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"token": {"$ref": "#/components/schemas/Token"}}}"##,
        r##"{"Token": {"$ref": "#/components/schemas/Secret"}, "Secret": {"type": "string", "x-forge-sensitive": true}}"##,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "token").is_sensitive());
}

#[test]
fn sensitive_next_to_a_property_ref_counts_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"token": {"$ref": "#/components/schemas/Token", "x-forge-sensitive": true}}}"##,
        r#"{"Token": {"type": "string"}}"#,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "token").is_sensitive());
}

#[test]
fn sensitive_next_to_a_property_ref_counts_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"token": {"$ref": "#/components/schemas/Token", "x-forge-sensitive": true}}
            }}}}}}}},
          "components": {"schemas": {"Token": {"type": "string"}}}
        }"##,
    );

    assert!(field(object(response_type(&forge, "a.get")), "token").is_sensitive());
}

#[test]
fn property_that_is_a_ref_has_the_default_of_its_schema() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"size": {"$ref": "#/components/schemas/Size"}}}"##,
        r#"{"Size": {"type": "integer", "default": 10}}"#,
    ));

    let size = field(object(response_type(&forge, "a.get")), "size");
    assert_eq!(size.default(), Some(&Json::Number(10.0)));
}

#[test]
fn property_default_follows_a_chain_of_refs() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"size": {"$ref": "#/components/schemas/Size"}}}"##,
        r##"{"Size": {"$ref": "#/components/schemas/Count"}, "Count": {"type": "integer", "default": 10}}"##,
    ));

    let size = field(object(response_type(&forge, "a.get")), "size");
    assert_eq!(size.default(), Some(&Json::Number(10.0)));
}

#[test]
fn property_default_is_the_first_along_a_chain_of_refs_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"size": {"$ref": "#/components/schemas/Size"}}
            }}}}}}}},
          "components": {"schemas": {
            "Size": {"$ref": "#/components/schemas/Count", "default": 5},
            "Count": {"type": "integer", "default": 10}
          }}
        }"##,
    );

    let size = field(object(response_type(&forge, "a.get")), "size");
    assert_eq!(size.default(), Some(&Json::Number(5.0)));
}

#[test]
fn property_that_is_a_ref_without_a_default_has_none() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"size": {"$ref": "#/components/schemas/Size"}}}"##,
        r#"{"Size": {"type": "integer"}}"#,
    ));

    assert_eq!(field(object(response_type(&forge, "a.get")), "size").default(), None);
}

#[test]
fn default_next_to_a_property_ref_is_its_own_in_3_1() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {
                "size": {"$ref": "#/components/schemas/Size", "default": 5},
                "none": {"$ref": "#/components/schemas/Size", "default": null}
              }
            }}}}}}}},
          "components": {"schemas": {"Size": {"type": "integer", "default": 10}}}
        }"##,
    );

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field(object, "size").default(), Some(&Json::Number(5.0)));
    assert_eq!(field(object, "none").default(), Some(&Json::Null));
}

#[test]
fn default_next_to_a_property_ref_is_ignored_in_3_0() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {
          "size": {"$ref": "#/components/schemas/Size", "default": 5},
          "count": {"$ref": "#/components/schemas/Count", "default": 5}
        }}"##,
        r#"{"Size": {"type": "integer", "default": 10}, "Count": {"type": "integer"}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field(object, "size").default(), Some(&Json::Number(10.0)));
    assert_eq!(field(object, "count").default(), None);
}
