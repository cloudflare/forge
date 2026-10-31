//! JSON Schemas (2020-12) of the arguments and responses of tools.
//!
//! A model is a `$ref` to `#/$defs/<key>`, so recursive models terminate.
//! Each model's schema is a constant in its group's files, which every tool
//! that uses it shares, and a tool's `$defs` has only the models its
//! schemas reach, so each tool's schema stands alone. A model's key depends
//! only on the model, so each group's files are generated on their own.
//!
//! Arguments and responses are built separately, since a model differs
//! between them: arguments describe what a client sends, so read-only fields
//! are left out; responses describe what the API returns, so they keep them.
//! Response schemas carry no descriptions or defaults, since they are for
//! checking responses rather than showing to a model.

use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;

use forge::{EnumValue, Field, Json, Model, Object, Scalar, Type};
use serde_json::{Map, Value, json};

/// The models a schema refers to.
pub(super) type Refs<'f> = HashSet<Model<'f>>;

/// Whether schemas describe what a client sends or what the API returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Direction {
    /// A tool's arguments.
    Input,
    /// A method's response bodies.
    Output,
}

/// Builds the schemas of one direction.
#[derive(Clone, Copy)]
pub(super) struct Schemas {
    direction: Direction,
}

impl Schemas {
    /// Builds the schemas of arguments.
    pub(super) const INPUT: Schemas = Schemas {
        direction: Direction::Input,
    };
    /// Builds the schemas of response bodies.
    pub(super) const OUTPUT: Schemas = Schemas {
        direction: Direction::Output,
    };

    /// Returns the schema of `t`, adding the models it refers to to `refs`.
    pub(super) fn ty<'f>(self, t: Type<'f>, refs: &mut Refs<'f>) -> Value {
        match t {
            Type::Scalar(scalar) => scalar_schema(scalar),
            Type::Enum(e) => {
                let values: Vec<Value> = e
                    .values()
                    .map(|v| match v {
                        EnumValue::String(s) => json!(s),
                        EnumValue::Number(n) => number(n),
                        EnumValue::Boolean(b) => json!(b),
                    })
                    .collect();
                let kinds: HashSet<&str> = values.iter().map(kind).collect();
                match kinds.into_iter().collect::<Vec<_>>()[..] {
                    [only] => json!({ "type": only, "enum": values }),
                    _ => json!({ "enum": values }),
                }
            }
            Type::Array(array) => {
                let mut schema = Map::new();
                schema.insert("type".to_owned(), json!("array"));
                schema.insert("items".to_owned(), self.ty(array.elem(), refs));
                if let Some(min) = array.min_items() {
                    schema.insert("minItems".to_owned(), json!(min));
                }
                if let Some(max) = array.max_items() {
                    schema.insert("maxItems".to_owned(), json!(max));
                }
                Value::Object(schema)
            }
            Type::Object(object) => self.object(object, refs),
            Type::Union(union) => {
                let members: Vec<Value> = union.members().map(|m| self.ty(m, refs)).collect();
                let keyword = if union.is_exclusive() { "oneOf" } else { "anyOf" };
                json!({ keyword: members })
            }
            Type::Intersection(intersection) => {
                let members: Vec<Value> = intersection.members().map(|m| self.ty(m, refs)).collect();
                json!({ "allOf": members })
            }
            Type::Model(model) if is_scalar(model.ty()) => self.model(model),
            Type::Model(model) => {
                refs.insert(model);
                json!({ "$ref": format!("#/$defs/{}", key(model)) })
            }
        }
    }

    /// Returns the schema of `field`: the schema of its type, with its
    /// description, default and deprecation for arguments.
    pub(super) fn field<'f>(self, field: Field<'f>, refs: &mut Refs<'f>) -> Value {
        let mut schema = self.ty(field.ty(), refs);
        if self.direction == Direction::Input
            && let Value::Object(map) = &mut schema
        {
            let description = field.description().trim();
            if !description.is_empty() {
                map.insert("description".to_owned(), json!(description));
            }
            if let Some(default) = field.default() {
                map.insert("default".to_owned(), value(default));
            }
            if field.is_deprecated() {
                map.insert("deprecated".to_owned(), json!(true));
            }
        }
        schema
    }

    /// Returns the schema of `model` itself, which its constant holds. The
    /// models it refers to are `$ref`s.
    pub(super) fn model(self, model: Model<'_>) -> Value {
        let mut schema = self.ty(model.ty(), &mut Refs::new());
        if self.direction == Direction::Input
            && let Value::Object(map) = &mut schema
        {
            let description = model.description().trim();
            if !description.is_empty() && !map.contains_key("description") {
                map.insert("description".to_owned(), json!(description));
            }
            if model.is_deprecated() {
                map.insert("deprecated".to_owned(), json!(true));
            }
        }
        schema
    }

    /// Returns the `$defs` of a schema that refers to `refs`: each model they
    /// refer to, directly or through other models, by key.
    pub(super) fn defs<'f>(self, refs: &Refs<'f>) -> BTreeMap<String, Model<'f>> {
        let mut reached = Refs::new();
        for &model in refs {
            reach(Type::Model(model), self.direction, &mut reached);
        }
        reached.into_iter().map(|model| (key(model), model)).collect()
    }

    /// Returns the schema of `object`.
    fn object<'f>(self, object: Object<'f>, refs: &mut Refs<'f>) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for field in object.fields().filter(|&f| kept(f, self.direction)) {
            properties.insert(field.wire_name().to_owned(), self.field(field, refs));
            if field.is_required() {
                required.push(field.wire_name());
            }
        }
        let mut schema = Map::new();
        schema.insert("type".to_owned(), json!("object"));
        if !properties.is_empty() {
            schema.insert("properties".to_owned(), Value::Object(properties));
        }
        if !required.is_empty() {
            schema.insert("required".to_owned(), json!(required));
        }
        if let Some(extra) = object.extra()
            && !matches!(extra, Type::Scalar(Scalar::Unknown))
        {
            schema.insert("additionalProperties".to_owned(), self.ty(extra, refs));
        }
        Value::Object(schema)
    }
}

/// Reports whether a schema of `direction` has `field`: arguments leave out
/// read-only fields, since a client doesn't send them.
fn kept(field: Field<'_>, direction: Direction) -> bool {
    direction == Direction::Output || !field.is_read_only()
}

/// Adds to `out` each model that a schema of `t` in `direction` refers to,
/// directly or through other models, without building any schema.
pub(super) fn reach<'f>(t: Type<'f>, direction: Direction, out: &mut Refs<'f>) {
    match t {
        Type::Scalar(_) | Type::Enum(_) => {}
        Type::Array(array) => reach(array.elem(), direction, out),
        Type::Object(object) => {
            for field in object.fields().filter(|&f| kept(f, direction)) {
                reach(field.ty(), direction, out);
            }
            if let Some(extra) = object.extra() {
                reach(extra, direction, out);
            }
        }
        Type::Union(union) => union.members().for_each(|m| reach(m, direction, out)),
        Type::Intersection(intersection) => intersection.members().for_each(|m| reach(m, direction, out)),
        Type::Model(model) if is_scalar(model.ty()) => {}
        Type::Model(model) => {
            if out.insert(model) {
                reach(model.ty(), direction, out);
            }
        }
    }
}

/// Reports whether `t` is a scalar or an enum, or a union or intersection of
/// them or of models that are, such as a nullable string or `allOf` an
/// identifier and `string`. A model of one is written inline where it is used
/// rather than as a `$ref`: its schema is about as small as the reference, and
/// it saves an entry in the `$defs` of every tool that uses it.
pub(super) fn is_scalar(t: Type<'_>) -> bool {
    scalar_within(t, 8)
}

/// [`is_scalar`], looking through at most `depth` models, so a model that
/// refers to itself ends the search.
fn scalar_within(t: Type<'_>, depth: u8) -> bool {
    match t {
        Type::Scalar(_) | Type::Enum(_) => true,
        Type::Union(union) => union.members().all(|m| scalar_within(m, depth)),
        Type::Intersection(intersection) => intersection.members().all(|m| scalar_within(m, depth)),
        Type::Model(model) => depth > 0 && scalar_within(model.ty(), depth - 1),
        Type::Array(_) | Type::Object(_) => false,
    }
}

/// Returns the key of `model` in `$defs`: its schema name, unique in the
/// document, with each byte other than an ASCII letter, digit, `_` or `-`
/// written as `.` and two hex digits, so the key needs no escaping in a
/// JSON Pointer or a URI fragment, and no two models share one.
pub(super) fn key(model: Model<'_>) -> String {
    let name = model.schema_name();
    let mut key = String::with_capacity(name.len());
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-') {
            key.push(char::from(b));
        } else {
            let _ = write!(key, ".{b:02X}");
        }
    }
    key
}

/// Returns the JSON Schema type of `value`, a value of an enum.
fn kind(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        _ => "number",
    }
}

/// Returns the schema of `scalar`.
fn scalar_schema(scalar: Scalar) -> Value {
    match scalar {
        Scalar::Unknown => json!({}),
        Scalar::Null => json!({ "type": "null" }),
        Scalar::Boolean => json!({ "type": "boolean" }),
        Scalar::String => json!({ "type": "string" }),
        Scalar::Uuid => json!({ "type": "string", "format": "uuid" }),
        Scalar::Number(n) if n.is_integer() => json!({ "type": "integer" }),
        Scalar::Number(_) => json!({ "type": "number" }),
        Scalar::DateTime => json!({ "type": "string", "format": "date-time" }),
        Scalar::Date => json!({ "type": "string", "format": "date" }),
        Scalar::Bytes => json!({ "type": "string", "contentEncoding": "base64" }),
        Scalar::Binary => json!({ "type": "string", "format": "binary" }),
    }
}

/// Returns `json` as a JSON value.
pub(super) fn value(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => json!(b),
        Json::Number(n) => number(*n),
        Json::String(s) => json!(s),
        Json::Array(values) => Value::Array(values.iter().map(value).collect()),
        Json::Object(entries) => Value::Object(entries.iter().map(|(k, v)| (k.clone(), value(v))).collect()),
    }
}

/// Returns `n` as a JSON number, without a fraction when it is an integer:
/// `1` rather than `1.0`.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 2f64.powi(53) {
        #[expect(clippy::cast_possible_truncation, reason = "n is an integer below 2^53")]
        return json!(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::number;

    #[test]
    fn numbers() {
        assert_eq!(number(1.0), json!(1));
        assert_eq!(number(-3.0), json!(-3));
        assert_eq!(number(1.5), json!(1.5));
    }
}
