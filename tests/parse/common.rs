//! Helpers to find things in a `Forge` and look inside types, so each test
//! asserts only what it is about. Each helper panics with what there is
//! when it finds nothing.

use forge::{EnumValue, Field, Forge, Group, Intersection, Method, Model, Name, Object, Scalar, Type, Union};

/// Parses `json` as a whole document.
#[track_caller]
pub fn parse(json: &str) -> Forge {
    match serde_json::from_str(json) {
        Ok(forge) => forge,
        Err(err) => panic!("parse: {err}"),
    }
}

/// Returns an OpenAPI 3.0.3 document with one method, `a.get`, whose JSON
/// response has the schema `schema`.
pub fn responding_with(schema: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {{"200": {{"description": "ok", "content": {{"application/json": {{"schema": {schema}}}}}}}}}}}}}}}
        }}"#
    )
}

/// Returns the document of [`responding_with`] with `schemas` as its
/// `components.schemas`.
pub fn responding_with_schemas(schema: &str, schemas: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {{"200": {{"description": "ok", "content": {{"application/json": {{"schema": {schema}}}}}}}}}}}}}}},
          "components": {{"schemas": {schemas}}}
        }}"#
    )
}

/// Parses `json`, which must fail, and returns the error message.
#[track_caller]
pub fn parse_err(json: &str) -> String {
    match serde_json::from_str::<Forge>(json) {
        Ok(_) => panic!("parse: want an error, got a Forge"),
        Err(err) => err.to_string(),
    }
}

/// Returns the group at `path`: the names from the top level down,
/// separated by dots, such as `zones` or `zones.settings`.
#[track_caller]
pub fn group<'f>(forge: &'f Forge, path: &str) -> Group<'f> {
    let names: Vec<Name> = path.split('.').map(Name::new).collect();
    let Some(group) = forge.groups().find(|group| group.path().eq(names.iter())) else {
        panic!("no group {path:?} in {:?}", forge.groups().collect::<Vec<_>>());
    };
    group
}

/// Returns the method at `path`: its group's path, a dot and its name,
/// such as `zones.get`.
#[track_caller]
pub fn method<'f>(forge: &'f Forge, path: &str) -> Method<'f> {
    let Some((group_path, name)) = path.rsplit_once('.') else {
        panic!("method path {path:?} is not group.method");
    };
    let group = group(forge, group_path);
    let name = Name::new(name);
    let Some(method) = group.methods().find(|method| *method.name() == name) else {
        panic!("no method {path:?} in {:?}", group.methods().collect::<Vec<_>>());
    };
    method
}

/// Returns the schema names of every model, wherever it is placed, sorted.
pub fn models(forge: &Forge) -> Vec<&str> {
    let mut names: Vec<&str> = forge
        .models()
        .chain(forge.groups().flat_map(|group| group.models()))
        .map(|model| model.schema_name())
        .collect();
    names.sort_unstable();
    names
}

/// Returns the model with schema name `schema_name`, wherever it is
/// placed.
#[track_caller]
pub fn model<'f>(forge: &'f Forge, schema_name: &str) -> Model<'f> {
    let models = || forge.models().chain(forge.groups().flat_map(|group| group.models()));
    let Some(model) = models().find(|model| model.schema_name() == schema_name) else {
        panic!("no model {schema_name:?} in {:?}", models().collect::<Vec<_>>());
    };
    model
}

/// Returns the type of the JSON content of the first success response of
/// the method at `path`.
#[track_caller]
pub fn response_type<'f>(forge: &'f Forge, path: &str) -> Type<'f> {
    let method = method(forge, path);
    let Some(response) = method.responses().next() else {
        panic!("{method:?} has no success response");
    };
    let Some(json) = response.json() else {
        panic!("{response:?} has no JSON content");
    };
    json.ty()
}

/// Returns the field of `object` with wire name `wire_name`.
#[track_caller]
pub fn field<'f>(object: Object<'f>, wire_name: &str) -> Field<'f> {
    let Some(field) = object.fields().find(|field| field.wire_name() == wire_name) else {
        panic!("no field {wire_name:?} in {object:?}");
    };
    field
}

/// Returns the wire names of the fields of `object`, in order.
pub fn field_names(object: Object<'_>) -> Vec<&str> {
    object.fields().map(|field| field.wire_name()).collect()
}

/// Returns the scalar `ty` is.
#[track_caller]
pub fn scalar(ty: Type<'_>) -> Scalar {
    let Type::Scalar(scalar) = ty else {
        panic!("want a scalar, got {ty:?}");
    };
    scalar
}

/// Returns the values of the enum `ty` is.
#[track_caller]
pub fn values(ty: Type<'_>) -> Vec<EnumValue<'_>> {
    let Type::Enum(values) = ty else {
        panic!("want an enum, got {ty:?}");
    };
    values.values().collect()
}

/// Returns the element type of the array `ty` is.
#[track_caller]
pub fn elem(ty: Type<'_>) -> Type<'_> {
    let Type::Array(array) = ty else {
        panic!("want an array, got {ty:?}");
    };
    array.elem()
}

/// Returns the object `ty` is.
#[track_caller]
pub fn object(ty: Type<'_>) -> Object<'_> {
    let Type::Object(object) = ty else {
        panic!("want an object, got {ty:?}");
    };
    object
}

/// Returns the union `ty` is.
#[track_caller]
pub fn union(ty: Type<'_>) -> Union<'_> {
    let Type::Union(union) = ty else {
        panic!("want a union, got {ty:?}");
    };
    union
}

/// Returns the intersection `ty` is.
#[track_caller]
pub fn intersection(ty: Type<'_>) -> Intersection<'_> {
    let Type::Intersection(intersection) = ty else {
        panic!("want an intersection, got {ty:?}");
    };
    intersection
}

/// Returns the model `ty` is.
#[track_caller]
pub fn model_of(ty: Type<'_>) -> Model<'_> {
    let Type::Model(model) = ty else {
        panic!("want a model, got {ty:?}");
    };
    model
}

/// Returns the type other than null in `ty`, which must be a union of it
/// and [`Scalar::Null`].
#[track_caller]
pub fn non_null(ty: Type<'_>) -> Type<'_> {
    let members: Vec<Type> = union(ty).members().collect();
    let others: Vec<Type> = members
        .iter()
        .copied()
        .filter(|m| !matches!(m, Type::Scalar(Scalar::Null)))
        .collect();
    let [other] = others[..] else {
        panic!("want a union of one type and null, got {ty:?}");
    };
    assert_eq!(members.len(), 2, "want a union of one type and null, got {ty:?}");
    other
}

/// Returns what kind of type `ty` is, without its parts: the scalar, such
/// as `String` or `Number(Int)`, `Model(` and its schema name `)`, or the
/// name of the variant.
pub fn kind(ty: Type<'_>) -> String {
    match ty {
        Type::Scalar(scalar) => format!("{scalar:?}"),
        Type::Enum(_) => "Enum".to_string(),
        Type::Array(_) => "Array".to_string(),
        Type::Object(_) => "Object".to_string(),
        Type::Union(_) => "Union".to_string(),
        Type::Intersection(_) => "Intersection".to_string(),
        Type::Model(model) => format!("Model({})", model.schema_name()),
    }
}

/// Returns the [`kind`] of each member of the union or intersection `ty`
/// is, sorted, since members have no order.
#[track_caller]
pub fn kinds(ty: Type<'_>) -> Vec<String> {
    let mut kinds: Vec<String> = match ty {
        Type::Union(union) => union.members().map(kind).collect(),
        Type::Intersection(intersection) => intersection.members().map(kind).collect(),
        _ => panic!("want a union or intersection, got {ty:?}"),
    };
    kinds.sort();
    kinds
}
