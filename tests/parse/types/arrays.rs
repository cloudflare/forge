use forge::{Array, Scalar, Type};

use crate::common::{
    elem, field, model_of, object, parse, parse_err, responding_with, responding_with_schemas, response_type, scalar,
};

/// Returns the array `ty` is.
#[track_caller]
fn array(ty: Type<'_>) -> Array<'_> {
    let Type::Array(array) = ty else {
        panic!("want an array, got {ty:?}");
    };
    array
}

#[test]
fn array_of_items() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {"type": "string"}}"#));

    assert_eq!(scalar(elem(response_type(&forge, "a.get"))), Scalar::String);
}

#[test]
fn min_items_preserves_absence_zero_and_positive_bounds() {
    for (bound, want) in [
        ("", None),
        (", \"minItems\": 0", Some(0)),
        (", \"minItems\": 1", Some(1)),
    ] {
        let forge = parse(&responding_with(&format!(
            r#"{{"type": "array", "items": {{"type": "string"}}, "maxItems": 50{bound}}}"#
        )));
        let array = array(response_type(&forge, "a.get"));
        assert_eq!(array.min_items(), want);
        assert_eq!(array.max_items(), Some(50));
    }
}

#[test]
fn arrays_with_different_minimums_keep_their_own_bounds() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {
          "zero": {"type": "array", "items": {}, "minItems": 0},
          "one": {"$ref": "#/components/schemas/One"},
          "any": {"items": {}}
        }}"##,
        r#"{"One": {"type": "array", "items": {}, "minItems": 1, "maxItems": 50}}"#,
    ));
    let object = object(response_type(&forge, "a.get"));
    assert_eq!(array(field(object, "zero").ty()).min_items(), Some(0));
    let one = array(model_of(field(object, "one").ty()).ty());
    assert_eq!(one.min_items(), Some(1));
    assert_eq!(one.max_items(), Some(50));
    assert_eq!(array(field(object, "any").ty()).min_items(), None);
}

#[test]
fn min_items_follows_the_same_number_rules_as_max_items() {
    let forge = parse(&responding_with(r#"{"type": "array", "minItems": 1.0}"#));
    assert_eq!(array(response_type(&forge, "a.get")).min_items(), Some(1));

    for value in ["-1", "2.5", r#""3""#, "null", "true"] {
        let err = parse_err(&responding_with(&format!(
            r#"{{"type": "array", "minItems": {value}}}"#
        )));
        assert!(err.contains("expected a non-negative integer"), "{value}: {err}");
    }
}

#[test]
fn min_items_on_a_non_array_is_ignored() {
    let forge = parse(&responding_with(r#"{"type": "string", "minItems": 1}"#));
    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::String);
}

#[test]
fn empty_items_are_unknown() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {}}"#));

    assert_eq!(scalar(elem(response_type(&forge, "a.get"))), Scalar::Unknown);
}

#[test]
fn items_without_a_type_are_an_array() {
    let forge = parse(&responding_with(r#"{"items": {"type": "string"}}"#));

    assert_eq!(scalar(elem(response_type(&forge, "a.get"))), Scalar::String);
}

#[test]
fn array_without_items_has_unknown_elements() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "array"
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(elem(response_type(&forge, "a.get"))), Scalar::Unknown);
}

#[test]
fn tuple_is_unknown() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": "array", "prefixItems": [{"type": "string"}, {"type": "integer"}], "items": false
            }}}}}}}}
        }"#,
    );

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::Unknown);
}

#[test]
fn max_items_is_the_most_elements() {
    let forge = parse(&responding_with(
        r#"{"type": "array", "items": {"type": "string"}, "maxItems": 3}"#,
    ));

    assert_eq!(array(response_type(&forge, "a.get")).max_items(), Some(3));
}

#[test]
fn array_without_max_items_has_no_limit() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {"type": "string"}}"#));

    assert_eq!(array(response_type(&forge, "a.get")).max_items(), None);
}

#[test]
fn max_items_zero_is_a_limit() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {}, "maxItems": 0}"#));

    assert_eq!(array(response_type(&forge, "a.get")).max_items(), Some(0));
}

#[test]
fn max_items_of_an_array_property() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {"tags": {"type": "array", "items": {"type": "string"}, "maxItems": 20}}}"#,
    ));

    let tags = field(object(response_type(&forge, "a.get")), "tags");
    assert_eq!(array(tags.ty()).max_items(), Some(20));
}

#[test]
fn arrays_of_the_same_items_with_different_limits_are_apart() {
    let forge = parse(&responding_with(
        r#"{"type": "object", "properties": {
          "few": {"type": "array", "items": {"type": "string"}, "maxItems": 2},
          "many": {"type": "array", "items": {"type": "string"}, "maxItems": 50},
          "any": {"type": "array", "items": {"type": "string"}}
        }}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert_eq!(array(field(object, "few").ty()).max_items(), Some(2));
    assert_eq!(array(field(object, "many").ty()).max_items(), Some(50));
    assert_eq!(array(field(object, "any").ty()).max_items(), None);
}

#[test]
fn array_model_keeps_the_limit_of_its_schema() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {
          "tags": {"$ref": "#/components/schemas/Tags"},
          "names": {"type": "array", "items": {"type": "string"}}
        }}"##,
        r#"{"Tags": {"type": "array", "items": {"type": "string"}, "maxItems": 5}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    let tags = model_of(field(object, "tags").ty());
    assert_eq!(array(tags.ty()).max_items(), Some(5));
    assert_eq!(array(field(object, "names").ty()).max_items(), None);
}

#[test]
fn max_items_with_no_fractional_part_is_an_integer() {
    let forge = parse(&responding_with(r#"{"type": "array", "items": {}, "maxItems": 4.0}"#));

    assert_eq!(array(response_type(&forge, "a.get")).max_items(), Some(4));
}

#[test]
fn max_items_that_is_not_a_non_negative_integer_is_an_error() {
    for value in ["-1", "2.5", r#""3""#, "null"] {
        let err = parse_err(&responding_with(&format!(
            r#"{{"type": "array", "items": {{}}, "maxItems": {value}}}"#
        )));

        assert!(err.contains("expected a non-negative integer"), "{value}: {err}");
    }
}

#[test]
fn max_items_on_a_schema_that_is_not_an_array_is_ignored() {
    let forge = parse(&responding_with(r#"{"type": "string", "maxItems": 2}"#));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::String);
}
