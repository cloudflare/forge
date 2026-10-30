use forge::{EnumValue, Scalar};

use crate::common::{parse, responding_with, response_type, scalar, values};

#[test]
fn string_enum() {
    let forge = parse(&responding_with(r#"{"type": "string", "enum": ["a", "b"]}"#));

    let a_b = [EnumValue::String("a"), EnumValue::String("b")];
    assert_eq!(values(response_type(&forge, "a.get")), a_b);
}

#[test]
fn number_enum() {
    let forge = parse(&responding_with(r#"{"type": "integer", "enum": [1, 2.5]}"#));

    assert_eq!(
        values(response_type(&forge, "a.get")),
        [EnumValue::Number(1.0), EnumValue::Number(2.5)]
    );
}

#[test]
fn boolean_enum() {
    let forge = parse(&responding_with(r#"{"type": "boolean", "enum": [true]}"#));

    assert_eq!(values(response_type(&forge, "a.get")), [EnumValue::Boolean(true)]);
}

#[test]
fn enum_without_a_type() {
    let forge = parse(&responding_with(r#"{"enum": ["a"]}"#));

    assert_eq!(values(response_type(&forge, "a.get")), [EnumValue::String("a")]);
}

#[test]
fn enum_of_mixed_values() {
    let forge = parse(&responding_with(r#"{"enum": ["a", 1, false]}"#));

    let want = [
        EnumValue::String("a"),
        EnumValue::Number(1.0),
        EnumValue::Boolean(false),
    ];
    assert_eq!(values(response_type(&forge, "a.get")), want);
}

#[test]
fn enum_values_are_different() {
    let forge = parse(&responding_with(r#"{"type": "string", "enum": ["a", "b", "a"]}"#));

    let a_b = [EnumValue::String("a"), EnumValue::String("b")];
    assert_eq!(values(response_type(&forge, "a.get")), a_b);
}

#[test]
fn const_is_an_enum_of_one_value() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "const": "a"
            }}}}}}}}
        }"#,
    );

    assert_eq!(values(response_type(&forge, "a.get")), [EnumValue::String("a")]);
}

#[test]
fn enum_of_arrays_is_unknown() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {}, "enum": [[]]}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}
