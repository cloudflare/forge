use forge::{EnumValue, Scalar};

use crate::common::{
    kind, kinds, model_of, non_null, parse, responding_with, responding_with_schemas, response_type, scalar, values,
};

#[test]
fn nullable_is_a_union_with_null() {
    let forge = parse(&responding_with(r#"{"type": "string", "nullable": true}"#));

    assert_eq!(scalar(non_null(response_type(&forge, "a.get"))), Scalar::String);
}

#[test]
fn nullable_false_is_not_a_union() {
    let forge = parse(&responding_with(r#"{"type": "string", "nullable": false}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::String);
}

#[test]
fn nullable_unknown_is_unknown() {
    let forge = parse(&responding_with(r#"{"nullable": true}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn nullable_enum_is_a_union_with_null() {
    let forge = parse(&responding_with(
        r#"{"type": "string", "enum": ["a", "b"], "nullable": true}"#,
    ));

    let a_b = [EnumValue::String("a"), EnumValue::String("b")];
    assert_eq!(values(non_null(response_type(&forge, "a.get"))), a_b);
}

#[test]
fn null_in_an_enum_is_a_union_with_null() {
    let forge = parse(&responding_with(r#"{"type": "string", "enum": ["a", null]}"#));

    let a = [EnumValue::String("a")];
    assert_eq!(values(non_null(response_type(&forge, "a.get"))), a);
}

#[test]
fn enum_of_only_null_is_null() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "enum": [null], "nullable": true}"#,
    ));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Null);
}

#[test]
fn nullable_union_has_null_as_a_member() {
    let forge = parse(&responding_with(
        r#"{"nullable": true, "oneOf": [{"type": "string"}, {"type": "boolean"}]}"#,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Boolean", "Null", "String"]);
}

#[test]
fn nullable_member_of_a_union_is_null_in_the_union() {
    let forge = parse(&responding_with(
        r#"{"oneOf": [{"type": "string", "nullable": true}, {"type": "boolean"}]}"#,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Boolean", "Null", "String"]);
}

#[test]
fn null_enum_member_of_a_union_is_null() {
    let forge = parse(&responding_with(r#"{"anyOf": [{"type": "string"}, {"enum": [null]}]}"#));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Null", "String"]);
}

#[test]
fn nullable_all_of_is_a_union_with_null() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [{"$ref": "#/components/schemas/Reason"}], "nullable": true}"##,
        r#"{"Reason": {"type": "string"}}"#,
    ));

    assert_eq!(
        model_of(non_null(response_type(&forge, "a.get"))).schema_name(),
        "Reason"
    );
}

#[test]
fn nullable_is_read_in_3_1() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "string", "nullable": true
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(non_null(response_type(&forge, "a.get"))), Scalar::String);
}

#[test]
fn null_in_a_type_array_is_a_union_with_null() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": ["string", "null"]
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(non_null(response_type(&forge, "a.get"))), Scalar::String);
}

#[test]
fn null_type_is_null() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "null"
            }}}}}}}}
        }"#,
    );

    assert_eq!(kind(response_type(&forge, "a.get")), "Null");
}

#[test]
fn const_null_is_null() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "const": null
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Null);
}
