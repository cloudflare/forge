use forge::{Scalar, Type};

use crate::common::{field, intersection, kind, kinds, object, parse, responding_with_schemas, response_type, scalar};

/// Two object models, `A` and `B`.
const A_AND_B: &str = r#"{
  "A": {"type": "object", "properties": {"a": {"type": "string"}}},
  "B": {"type": "object", "properties": {"b": {"type": "string"}}}
}"#;

#[test]
fn all_of_is_an_intersection() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Model(B)"]);
}

#[test]
fn all_of_one_member_is_the_member() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [{"$ref": "#/components/schemas/A"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(A)");
}

#[test]
fn members_without_a_shape_are_dropped() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [
          {"$ref": "#/components/schemas/A"},
          {"type": "object"},
          {},
          {"description": "Described."},
          {"$ref": "#/components/schemas/B"}
        ]}"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Model(B)"]);
}

#[test]
fn true_member_is_dropped() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "allOf": [{"$ref": "#/components/schemas/A"}, true, {"$ref": "#/components/schemas/B"}]
            }}}}}}}},
          "components": {"schemas": {
            "A": {"type": "object", "properties": {"a": {"type": "string"}}},
            "B": {"type": "object", "properties": {"b": {"type": "string"}}}
          }}
        }"##,
    );

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Model(B)"]);
}

#[test]
fn member_left_after_dropping_is_the_type() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [{"description": "Described."}, {"$ref": "#/components/schemas/A"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(A)");
}

#[test]
fn type_next_to_all_of_is_dropped() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "string", "allOf": [{"$ref": "#/components/schemas/Reason"}]}"##,
        r#"{"Reason": {"type": "string", "enum": ["spam", "abuse"]}}"#,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(Reason)");
}

#[test]
fn properties_next_to_all_of_are_a_member() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "properties": {"id": {"type": "string"}}, "allOf": [{"$ref": "#/components/schemas/A"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Object"]);
}

#[test]
fn all_of_member_that_is_an_all_of_is_flattened() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [
          {"$ref": "#/components/schemas/A"},
          {"allOf": [{"$ref": "#/components/schemas/B"}, {"type": "object", "properties": {"c": {"type": "string"}}}]}
        ]}"##,
        A_AND_B,
    ));

    assert_eq!(
        kinds(response_type(&forge, "a.get")),
        ["Model(A)", "Model(B)", "Object"]
    );
}

#[test]
fn required_member_makes_sibling_fields_required() {
    let forge = parse(&responding_with_schemas(
        r#"{"allOf": [
          {"type": "object", "properties": {"name": {"type": "string"}, "note": {"type": "string"}}},
          {"required": ["name"]}
        ]}"#,
        "{}",
    ));

    let object = object(response_type(&forge, "a.get"));
    assert!(field(object, "name").is_required());
    assert!(!field(object, "note").is_required());
}

#[test]
fn required_member_copies_the_fields_of_a_model() {
    let forge = parse(&responding_with_schemas(
        r##"{"allOf": [{"$ref": "#/components/schemas/Rule"}, {"required": ["name"]}]}"##,
        r#"{"Rule": {"type": "object", "properties": {"name": {"type": "string"}, "note": {"type": "string"}}}}"#,
    ));

    let object = object(response_type(&forge, "a.get"));
    assert!(field(object, "name").is_required());
    assert!(!field(object, "note").is_required());
}

#[test]
fn unevaluated_properties_is_an_object_member() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "allOf": [{"$ref": "#/components/schemas/A"}],
              "unevaluatedProperties": {"type": "string"}
            }}}}}}}},
          "components": {"schemas": {"A": {"type": "object", "properties": {"a": {"type": "string"}}}}}
        }"##,
    );

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Model(A)", "Object"]);
    let rest = intersection(ty)
        .members()
        .find(|m| matches!(m, Type::Object(_)))
        .unwrap();
    assert_eq!(object(rest).fields().len(), 0);
    assert_eq!(scalar(object(rest).extra().unwrap()), Scalar::String);
}

#[test]
fn array_next_to_all_of_is_dropped() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "array", "items": {"type": "object"}, "allOf": [{"$ref": "#/components/schemas/Messages"}]}"##,
        r#"{"Messages": {"type": "array", "items": {"type": "object", "properties": {"code": {"type": "integer"}}}}}"#,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(Messages)");
}
