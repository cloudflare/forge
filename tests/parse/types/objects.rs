use forge::{Json, Name, Number, Scalar};

use crate::common::{field, field_names, object, parse, parse_err, responding_with, response_type, scalar};

#[test]
fn properties_are_fields_and_allow_no_other_keys() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string"}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(scalar(field(object, "id").ty()), Scalar::String);
    assert!(object.extra().is_none(), "{object:?}");
}

#[test]
fn required_fields_are_listed_in_required() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert!(field(object, "id").is_required());
    assert!(!field(object, "name").is_required());
}

#[test]
fn required_names_without_a_property_are_ignored() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "required": ["port", "protocol"], "properties": {"port": {"type": "integer"}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field_names(object), ["port"]);
    assert!(field(object, "port").is_required());
}

#[test]
fn field_is_named_by_x_forge_property_name() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"owner": {"type": "string", "x-forge-property-name": "person"}}}"#,
    ));

    let owner = field(object(response_type(&forge, "a.get")), "owner");
    assert_eq!(owner.name(), &Name::new("person"));
}

#[test]
fn field_is_named_after_its_property() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"created_at": {"type": "string"}}}"#,
    ));

    let created_at = field(object(response_type(&forge, "a.get")), "created_at");
    assert_eq!(created_at.name(), &Name::new("created_at"));
}

#[test]
fn field_has_the_description_and_deprecation_of_its_property() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"old": {"type": "string", "description": "Old.", "deprecated": true}}}"#,
    ));

    let old = field(object(response_type(&forge, "a.get")), "old");
    assert_eq!(old.description(), "Old.");
    assert!(old.is_deprecated());
}

#[test]
fn field_is_read_only_when_its_property_is() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string", "readOnly": true}}}"#,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "id").is_read_only());
}

#[test]
fn field_is_neither_read_only_nor_sensitive_by_default() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"name": {"type": "string"}, "shown": {"type": "string", "readOnly": false, "x-forge-sensitive": false}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    for name in ["name", "shown"] {
        assert!(!field(object, name).is_read_only(), "{name}");
        assert!(!field(object, name).is_sensitive(), "{name}");
    }
}

#[test]
fn read_only_that_is_not_a_boolean_is_an_error() {
    let err = parse_err(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string", "readOnly": "yes"}}}"#,
    ));

    assert!(err.contains("expected a boolean"), "{err}");
}

#[test]
fn field_is_sensitive_when_its_property_is() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"password": {"type": "string", "x-forge-sensitive": true}}}"#,
    ));

    assert!(field(object(response_type(&forge, "a.get")), "password").is_sensitive());
}

#[test]
fn sensitive_that_is_not_a_boolean_is_an_error() {
    let err = parse_err(&responding_with(
        r#"{"type": "object", "properties": {"password": {"type": "string", "x-forge-sensitive": "true"}}}"#,
    ));

    assert!(err.contains("expected a boolean"), "{err}");
}

#[test]
fn property_named_ref_is_a_field() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"$ref": {"type": "string", "format": "uri"}}}"#,
    ));

    assert_eq!(field_names(object(response_type(&forge, "a.get"))), ["$ref"]);
}

#[test]
fn properties_without_a_type_are_an_object() {
    let forge = parse(&responding_with(r#"{"properties": {"id": {"type": "string"}}}"#));

    assert_eq!(field_names(object(response_type(&forge, "a.get"))), ["id"]);
}

#[test]
fn object_without_properties_allows_any_keys() {
    let forge = parse(&responding_with(r#"{"type": "object"}"#));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(object.fields().len(), 0);
    assert_eq!(scalar(object.extra().unwrap()), Scalar::Unknown);
}

#[test]
fn additional_properties_true_allows_any_other_keys() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": true}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field_names(object), ["id"]);
    assert_eq!(scalar(object.extra().unwrap()), Scalar::Unknown);
}

#[test]
fn additional_properties_false_with_properties_allows_no_other_keys() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": false}"#,
    ));

    assert!(object(response_type(&forge, "a.get")).extra().is_none());
}

#[test]
fn additional_properties_false_without_properties_is_the_empty_object() {
    let forge = parse(&responding_with(r#"{"type": "object", "additionalProperties": false}"#));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(object.fields().len(), 0);
    assert!(object.extra().is_none(), "{object:?}");
}

#[test]
fn additional_properties_schema_is_the_type_of_other_keys() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "additionalProperties": {"type": "integer"}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(object.fields().len(), 0);
    assert_eq!(scalar(object.extra().unwrap()), Scalar::Number(Number::Int));
}

#[test]
fn empty_additional_properties_schema_is_unknown() {
    let forge = parse(&responding_with(r#"{"type": "object", "additionalProperties": {}}"#));

    assert_eq!(
        scalar(object(response_type(&forge, "a.get")).extra().unwrap()),
        Scalar::Unknown
    );
}

#[test]
fn pattern_properties_are_ignored() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"id": {"type": "string"}}, "patternProperties": {"^x-": {"type": "string"}}
            }}}}}}}}
        }"#,
    );

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field_names(object), ["id"]);
    assert!(object.extra().is_none(), "{object:?}");
}

#[test]
fn false_property_is_no_field() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "object", "properties": {"id": {"type": "string"}, "gone": false}
            }}}}}}}}
        }"#,
    );

    assert_eq!(field_names(object(response_type(&forge, "a.get"))), ["id"]);
}

#[test]
fn property_skipped_by_x_forge_skip_is_no_field() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"id": {"type": "string"}, "old_id": {"type": "string", "x-forge-skip": true}}}"#,
    ));

    assert_eq!(field_names(object(response_type(&forge, "a.get"))), ["id"]);
}

#[test]
fn fields_with_equal_names_are_an_error() {
    let err = parse_err(&responding_with(
        r#"{"type": "object", "properties": {"user_id": {"type": "string"}, "userId": {"type": "string"}}}"#,
    ));

    assert!(err.contains("user_id") && err.contains("userId"), "{err}");
}

#[test]
fn field_has_the_default_of_its_property() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {
          "name": {"type": "string", "default": "pet"},
          "limit": {"type": "integer", "default": 20},
          "ratio": {"type": "number", "default": 0.5},
          "enabled": {"type": "boolean", "default": false}
        }}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field(object, "name").default(), Some(&Json::String("pet".into())));
    assert_eq!(field(object, "limit").default(), Some(&Json::Number(20.0)));
    assert_eq!(field(object, "ratio").default(), Some(&Json::Number(0.5)));
    assert_eq!(field(object, "enabled").default(), Some(&Json::Bool(false)));
}

#[test]
fn object_and_array_defaults_are_kept_as_written() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {
          "settings": {"type": "object", "default": {"b": 1, "a": [true]}},
          "tags": {"type": "array", "items": {"type": "string"}, "default": ["x", "y"]}
        }}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    let settings = Json::Object(vec![
        ("b".into(), Json::Number(1.0)),
        ("a".into(), Json::Array(vec![Json::Bool(true)])),
    ]);
    assert_eq!(field(object, "settings").default(), Some(&settings));
    let tags = Json::Array(vec![Json::String("x".into()), Json::String("y".into())]);
    assert_eq!(field(object, "tags").default(), Some(&tags));
}

#[test]
fn null_default_is_apart_from_no_default() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"parent": {"type": "string", "nullable": true, "default": null}, "name": {"type": "string"}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field(object, "parent").default(), Some(&Json::Null));
    assert_eq!(field(object, "name").default(), None);
}

#[test]
fn default_is_not_checked_against_the_schema() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"limit": {"type": "integer", "default": "ten"}}}"#,
    ));

    let limit = field(object(response_type(&forge, "a.get")), "limit");
    assert_eq!(limit.default(), Some(&Json::String("ten".into())));
}

#[test]
fn x_sensitive_is_not_read() {
    // `forge normalize` rewrites it, to `x-forge-sensitive`, which is.
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"password": {"type": "string", "x-sensitive": true}}}"#,
    ));

    assert!(!field(object(response_type(&forge, "a.get")), "password").is_sensitive());
}

#[test]
fn vendor_name_and_skip_extensions_are_not_read() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"wire_name": {
          "type": "string", "x-fern-property-name": "renamed", "x-stainless-skip": true
        }}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(field_names(object), ["wire_name"]);
    assert_eq!(field(object, "wire_name").name(), &Name::new("wire_name"));
}

#[test]
fn sensitive_written_twice_is_an_error_naming_it() {
    let err = parse_err(&responding_with(
        r#"{"type": "object", "properties": {"password": {"type": "string", "x-forge-sensitive": true, "x-forge-sensitive": true}}}"#,
    ));

    assert!(err.contains("duplicate field `x-forge-sensitive`"), "{err}");
}
