use forge::{Number, Scalar, Type};

use crate::common::{
    field, model_of, object, parse, responding_with, responding_with_schemas, response_type, scalar, union,
};

fn format(ty: Type<'_>) -> Option<&str> {
    let Type::Scalar(scalar) = ty else {
        panic!("want a scalar, got {ty:?}");
    };
    scalar.format()
}

#[test]
fn original_scalar_formats_are_kept_without_changing_the_classification() {
    for (schema, kind, want) in [
        (r#"{"type":"string"}"#, Scalar::String, None),
        (r#"{"type":"string","format":""}"#, Scalar::String, Some("")),
        (r#"{"type":"string","format":"uuid"}"#, Scalar::String, Some("uuid")),
        (
            r#"{"type":"string","format":"custom-ID"}"#,
            Scalar::String,
            Some("custom-ID"),
        ),
        (
            r#"{"type":"string","format":"date-time"}"#,
            Scalar::DateTime,
            Some("date-time"),
        ),
        (r#"{"type":"string","format":"date"}"#, Scalar::Date, Some("date")),
        (r#"{"type":"string","format":"byte"}"#, Scalar::Bytes, Some("byte")),
        (r#"{"type":"string","format":"binary"}"#, Scalar::Binary, Some("binary")),
        (r#"{"type":"string","contentEncoding":"base64"}"#, Scalar::Bytes, None),
        (
            r#"{"type":"string","format":"uuid","contentEncoding":"base64"}"#,
            Scalar::Bytes,
            Some("uuid"),
        ),
        (
            r#"{"type":"integer","format":"int32"}"#,
            Scalar::Number(Number::Int32),
            Some("int32"),
        ),
        (
            r#"{"type":"number","format":"decimal"}"#,
            Scalar::Number(Number::Double),
            Some("decimal"),
        ),
    ] {
        let forge = parse(&responding_with(schema));
        let ty = response_type(&forge, "a.get");
        assert_eq!(scalar(ty), kind, "{schema}");
        assert_eq!(format(ty), want, "{schema}");
    }
}

#[test]
fn strings_with_different_formats_do_not_share_annotations() {
    let forge = parse(&responding_with_schemas(
        r##"{"type":"object","properties":{
          "id":{"$ref":"#/components/schemas/ID"},
          "uri":{"type":"string","format":"uri"},
          "plain":{"type":"string"},
          "empty":{"type":"string","format":""},
          "id_again":{"type":"string","format":"uuid"}
        }}"##,
        r#"{"ID":{"type":"string","format":"uuid"}}"#,
    ));
    let object = object(response_type(&forge, "a.get"));
    assert_eq!(format(model_of(field(object, "id").ty()).ty()), Some("uuid"));
    for (name, want) in [
        ("uri", Some("uri")),
        ("plain", None),
        ("empty", Some("")),
        ("id_again", Some("uuid")),
    ] {
        assert_eq!(format(field(object, name).ty()), want, "{name}");
    }
}

#[test]
fn union_deduplication_keeps_distinct_formats() {
    let forge = parse(&responding_with(
        r#"{"anyOf":[
      {"type":"string","format":"uuid"},
      {"type":"string","format":"uri"},
      {"type":"string","format":"uuid"}
    ]}"#,
    ));
    let formats: Vec<_> = union(response_type(&forge, "a.get")).members().map(format).collect();
    assert_eq!(formats, [Some("uuid"), Some("uri")]);
}

#[test]
fn primitive_types() {
    for (schema, want) in [
        (r#"{"type": "string"}"#, Scalar::String),
        (r#"{"type": "boolean"}"#, Scalar::Boolean),
        (r#"{"type": "integer"}"#, Scalar::Number(Number::Int)),
        (r#"{"type": "number"}"#, Scalar::Number(Number::Double)),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), want, "{schema}");
    }
}

#[test]
fn number_format_is_its_size() {
    for (schema, want) in [
        (r#"{"type": "integer", "format": "int8"}"#, Number::Int8),
        (r#"{"type": "integer", "format": "int16"}"#, Number::Int16),
        (r#"{"type": "integer", "format": "int32"}"#, Number::Int32),
        (r#"{"type": "integer", "format": "int64"}"#, Number::Int64),
        (r#"{"type": "integer", "format": "uint8"}"#, Number::Uint8),
        (r#"{"type": "integer", "format": "uint16"}"#, Number::Uint16),
        (r#"{"type": "integer", "format": "uint32"}"#, Number::Uint32),
        (r#"{"type": "integer", "format": "uint64"}"#, Number::Uint64),
        (r#"{"type": "number", "format": "float"}"#, Number::Float),
        (r#"{"type": "number", "format": "double"}"#, Number::Double),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn number_format_decides_the_size_whatever_the_type() {
    for (schema, want) in [
        (r#"{"type": "number", "format": "int32"}"#, Number::Int32),
        (r#"{"type": "number", "format": "int64"}"#, Number::Int64),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn number_format_that_is_not_a_size_is_ignored() {
    for (schema, want) in [
        (r#"{"type": "integer", "format": "timestamp"}"#, Number::Int),
        (r#"{"type": "number", "format": "decimal"}"#, Number::Double),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Number(want), "{schema}");
    }
}

#[test]
fn string_formats() {
    for (schema, want) in [
        (r#"{"type": "string", "format": "date-time"}"#, Scalar::DateTime),
        (r#"{"type": "string", "format": "date"}"#, Scalar::Date),
        (r#"{"type": "string", "format": "byte"}"#, Scalar::Bytes),
        (r#"{"type": "string", "format": "binary"}"#, Scalar::Binary),
        (r#"{"type": "string", "format": "uuid"}"#, Scalar::String),
        (r#"{"type": "string", "format": "uri"}"#, Scalar::String),
    ] {
        let forge = parse(&responding_with(schema));

        assert_eq!(scalar(response_type(&forge, "a.get")), want, "{schema}");
    }
}

#[test]
fn base64_content_encoding_is_bytes() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "string", "contentEncoding": "base64"
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Bytes);
}

#[test]
fn binary_format_is_binary_even_with_base64_content_encoding() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "string", "format": "binary", "contentEncoding": "base64"
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Binary);
}

#[test]
fn json_field_with_binary_format_is_binary_and_byte_format_is_bytes() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {
          "raw": {"type": "string", "format": "binary"},
          "encoded": {"type": "string", "format": "byte"}
        }}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(scalar(field(object, "raw").ty()), Scalar::Binary);
    assert_eq!(scalar(field(object, "encoded").ty()), Scalar::Bytes);
}

#[test]
fn empty_schema_is_unknown() {
    let forge = parse(&responding_with("{}"));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn schema_with_only_annotations_is_unknown() {
    let forge = parse(&responding_with(r#"{"description": "Anything.", "example": 1}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn true_schema_is_unknown() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": true}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}
