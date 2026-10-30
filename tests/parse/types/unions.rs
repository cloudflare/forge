use forge::{Discriminator, EnumValue, Name, Scalar, Type};

use crate::common::{
    field_names, kind, kinds, object, parse, responding_with, responding_with_schemas, response_type, scalar, union,
    values,
};

/// Two object models, `A` and `B`, with a `kind` property.
const A_AND_B: &str = r#"{
  "A": {"type": "object", "properties": {"kind": {"type": "string"}, "a": {"type": "string"}}},
  "B": {"type": "object", "properties": {"kind": {"type": "string"}, "b": {"type": "string"}}}
}"#;

/// Returns each case of `discriminator` as its value and the [`kind`] of
/// its member, sorted.
fn cases<'f>(discriminator: Discriminator<'f>) -> Vec<(&'f str, String)> {
    let mut cases: Vec<_> = discriminator.cases().map(|(value, ty)| (value, kind(ty))).collect();
    cases.sort();
    cases
}

#[test]
fn one_of_is_a_union() {
    let forge = parse(&responding_with_schemas(
        r##"{"oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]}"##,
        A_AND_B,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Model(A)", "Model(B)"]);
    assert!(union(ty).discriminator().is_none());
}

#[test]
fn any_of_is_a_union() {
    let forge = parse(&responding_with(
        r#"{"anyOf": [{"type": "string"}, {"type": "boolean"}]}"#,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Boolean", "String"]);
}

#[test]
fn one_of_is_exclusive() {
    let forge = parse(&responding_with(
        r#"{"oneOf": [{"type": "string"}, {"type": "boolean"}]}"#,
    ));

    assert!(union(response_type(&forge, "a.get")).is_exclusive());
}

#[test]
fn any_of_is_not_exclusive() {
    let forge = parse(&responding_with(
        r#"{"anyOf": [{"type": "string"}, {"type": "boolean"}]}"#,
    ));

    assert!(!union(response_type(&forge, "a.get")).is_exclusive());
}

#[test]
fn any_of_with_a_discriminator_is_not_exclusive() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "anyOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind"}
        }"##,
        A_AND_B,
    ));

    assert!(!union(response_type(&forge, "a.get")).is_exclusive());
}

#[test]
fn type_array_is_exclusive() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": ["string", "integer"]
            }}}}}}}}
        }"#,
    );

    assert!(union(response_type(&forge, "a.get")).is_exclusive());
}

#[test]
fn type_and_null_are_exclusive() {
    let forge = parse(&responding_with(r#"{"anyOf": [{"type": "string"}, {"type": "null"}]}"#));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Null", "String"]);
    assert!(union(ty).is_exclusive());
}

#[test]
fn nullable_any_of_is_not_exclusive() {
    let forge = parse(&responding_with(
        r#"{"anyOf": [{"type": "string"}, {"type": "boolean"}], "nullable": true}"#,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Boolean", "Null", "String"]);
    assert!(!union(ty).is_exclusive());
}

#[test]
fn one_of_with_an_any_of_member_is_not_exclusive() {
    let forge = parse(&responding_with(
        r#"{"oneOf": [{"type": "boolean"}, {"anyOf": [{"type": "string"}, {"type": "integer"}]}]}"#,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Boolean", "Number(Int)", "String"]);
    assert!(!union(ty).is_exclusive());
}

#[test]
fn discriminated_member_keeps_its_own_exclusivity() {
    let forge = parse(&responding_with_schemas(
        r##"{"anyOf": [
          {"oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}], "discriminator": {"propertyName": "kind"}},
          {"type": "string"}
        ]}"##,
        A_AND_B,
    ));

    let ty = response_type(&forge, "a.get");
    assert!(!union(ty).is_exclusive());
    let inner = union(ty).members().find(|m| matches!(m, Type::Union(_))).unwrap();
    assert!(union(inner).is_exclusive());
}

#[test]
fn types_in_a_type_array_are_a_union() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "type": ["string", "integer"]
            }}}}}}}}
        }"#,
    );

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Number(Int)", "String"]);
}

#[test]
fn union_of_one_member_is_the_member() {
    let forge = parse(&responding_with_schemas(
        r##"{"oneOf": [{"$ref": "#/components/schemas/A"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kind(response_type(&forge, "a.get")), "Model(A)");
}

#[test]
fn union_of_the_same_type_twice_is_the_type() {
    let forge = parse(&responding_with(
        r#"{"anyOf": [{"type": "string"}, {"type": "string", "description": "Again."}]}"#,
    ));

    assert_eq!(scalar(response_type(&forge, "a.get")), Scalar::String);
}

#[test]
fn union_member_that_is_a_union_is_flattened() {
    let forge = parse(&responding_with_schemas(
        r##"{"oneOf": [
          {"$ref": "#/components/schemas/A"},
          {"oneOf": [{"type": "string"}, {"$ref": "#/components/schemas/B"}]}
        ]}"##,
        A_AND_B,
    ));

    assert_eq!(
        kinds(response_type(&forge, "a.get")),
        ["Model(A)", "Model(B)", "String"]
    );
}

#[test]
fn enum_members_are_merged() {
    let forge = parse(&responding_with(
        r#"{"oneOf": [{"enum": ["x", "y"]}, {"type": "boolean"}, {"enum": ["y", "z"]}]}"#,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Boolean", "Enum"]);
    let enum_ty = union(ty).members().find(|m| matches!(m, Type::Enum(_))).unwrap();
    let xyz = ["x", "y", "z"].map(EnumValue::String);
    assert_eq!(values(enum_ty), xyz);
}

#[test]
fn discriminator_mapping_gives_the_cases() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind", "mapping": {"a": "#/components/schemas/A", "b": "#/components/schemas/B"}}
        }"##,
        A_AND_B,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(discriminator.wire_name(), "kind");
    assert_eq!(discriminator.name(), &Name::new("kind"));
    assert_eq!(
        cases(discriminator),
        [("a", "Model(A)".into()), ("b", "Model(B)".into())]
    );
}

#[test]
fn discriminator_mapping_can_be_a_schema_name() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind", "mapping": {"a": "A", "b": "B"}}
        }"##,
        A_AND_B,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(
        cases(discriminator),
        [("a", "Model(A)".into()), ("b", "Model(B)".into())]
    );
}

#[test]
fn discriminator_without_mapping_uses_schema_names() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind"}
        }"##,
        A_AND_B,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(
        cases(discriminator),
        [("A", "Model(A)".into()), ("B", "Model(B)".into())]
    );
}

#[test]
fn discriminator_without_mapping_uses_the_one_value_of_an_enum() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/Cat"}, {"$ref": "#/components/schemas/Dog"}],
          "discriminator": {"propertyName": "kind"}
        }"##,
        r#"{
          "Cat": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["cat"]}}},
          "Dog": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["dog"]}}}
        }"#,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(
        cases(discriminator),
        [("cat", "Model(Cat)".into()), ("dog", "Model(Dog)".into())]
    );
}

#[test]
fn discriminator_of_members_written_in_place_uses_the_one_value_of_an_enum() {
    let forge = parse(&responding_with(
        r#"{
          "discriminator": {"propertyName": "type"},
          "oneOf": [
            {"type": "object", "title": "Int32", "properties": {"type": {"type": "string", "enum": ["int32"]}}},
            {"type": "object", "title": "Struct", "properties": {"type": {"type": "string", "enum": ["struct"]}, "fields": {"type": "array", "items": {"type": "string"}}}}
          ]
        }"#,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Object", "Object"]);
    let discriminator = union(ty).discriminator().unwrap();
    assert_eq!(
        cases(discriminator),
        [("int32", "Object".into()), ("struct", "Object".into())]
    );
}

#[test]
fn discriminator_is_named_by_x_forge_property_name() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind"}
        }"##,
        r#"{
          "A": {"type": "object", "properties": {"kind": {"type": "string", "x-forge-property-name": "pet_kind"}}},
          "B": {"type": "object", "properties": {"kind": {"type": "string", "x-forge-property-name": "pet_kind"}}}
        }"#,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(discriminator.name(), &Name::new("pet_kind"));
}

#[test]
fn discriminator_of_any_of() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "anyOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind", "mapping": {"a": "#/components/schemas/A", "b": "#/components/schemas/B"}}
        }"##,
        A_AND_B,
    ));

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(
        cases(discriminator),
        [("a", "Model(A)".into()), ("b", "Model(B)".into())]
    );
}

#[test]
fn discriminator_default_mapping_is_the_default() {
    let forge = parse(
        r##"{
          "openapi": "3.2.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
              "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
              "discriminator": {"propertyName": "kind", "mapping": {"a": "#/components/schemas/A"}, "defaultMapping": "#/components/schemas/B"}
            }}}}}}}},
          "components": {"schemas": {
            "A": {"type": "object", "properties": {"kind": {"type": "string"}}},
            "B": {"type": "object", "properties": {"kind": {"type": "string"}}}
          }}
        }"##,
    );

    let discriminator = union(response_type(&forge, "a.get")).discriminator().unwrap();
    assert_eq!(discriminator.default().unwrap().schema_name(), "B");
}

#[test]
fn discriminated_union_is_a_member_of_another_union() {
    let forge = parse(&responding_with_schemas(
        r##"{"oneOf": [
          {"oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}], "discriminator": {"propertyName": "kind"}},
          {"type": "string"}
        ]}"##,
        A_AND_B,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["String", "Union"]);
    assert!(union(ty).discriminator().is_none());
    let inner = union(ty).members().find(|m| matches!(m, Type::Union(_))).unwrap();
    assert!(union(inner).discriminator().is_some());
}

#[test]
fn nullable_discriminated_union_is_a_member_of_a_union_with_null() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}],
          "discriminator": {"propertyName": "kind"},
          "nullable": true
        }"##,
        A_AND_B,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Null", "Union"]);
    assert!(union(ty).discriminator().is_none());
}

#[test]
fn members_with_only_required_are_dropped() {
    let forge = parse(&responding_with(
        r#"{
          "type": "object",
          "properties": {"appeals": {"type": "string"}, "type": {"type": "string"}},
          "oneOf": [{"type": "object", "required": ["appeals"]}, {"type": "object", "required": ["type"]}]
        }"#,
    ));

    let mut names = field_names(object(response_type(&forge, "a.get")));
    names.sort_unstable();
    assert_eq!(names, ["appeals", "type"]);
}

#[test]
fn member_with_only_constraints_is_dropped() {
    let forge = parse(&responding_with_schemas(
        r##"{"anyOf": [
          {"$ref": "#/components/schemas/A"},
          {"$ref": "#/components/schemas/B"},
          {"not": {"required": ["a", "b"]}}
        ]}"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Model(B)"]);
}

#[test]
fn object_member_without_properties_allows_any_keys() {
    let forge = parse(&responding_with(
        r#"{"oneOf": [{"type": "object"}, {"type": "string"}]}"#,
    ));

    let ty = response_type(&forge, "a.get");
    assert_eq!(kinds(ty), ["Object", "String"]);
    let object = object(union(ty).members().find(|m| matches!(m, Type::Object(_))).unwrap());
    assert_eq!(object.fields().len(), 0);
    assert_eq!(scalar(object.extra().unwrap()), Scalar::Unknown);
}

#[test]
fn type_next_to_a_union_is_dropped() {
    let forge = parse(&responding_with_schemas(
        r##"{"type": "object", "anyOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]}"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Model(A)", "Model(B)"]);
}

#[test]
fn properties_next_to_a_union_are_intersected_with_it() {
    let forge = parse(&responding_with_schemas(
        r##"{
          "type": "object", "properties": {"id": {"type": "string"}},
          "oneOf": [{"$ref": "#/components/schemas/A"}, {"$ref": "#/components/schemas/B"}]
        }"##,
        A_AND_B,
    ));

    assert_eq!(kinds(response_type(&forge, "a.get")), ["Object", "Union"]);
}
