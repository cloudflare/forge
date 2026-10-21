//! JSON Schemas (2020-12) of the arguments and responses of tools.
//!
//! A model is a `$ref` to `#/$defs/<key>`, so recursive models terminate.
//! Each model's schema is built once for every tool, and a tool's `$defs`
//! has only the models its schemas reach, so each tool's schema stands
//! alone.
//!
//! Arguments and responses are built separately, since a model differs
//! between them: arguments describe what a client sends, so read-only fields
//! are left out; responses describe what the API returns, so they keep them.
//! Response schemas carry no descriptions or defaults, since they are for
//! checking responses rather than showing to a model.

use std::collections::{BTreeMap, HashMap, HashSet};

use forge::{EnumValue, Field, Json, Model, Object, Scalar, Type};
use serde_json::{Map, Value, json};

/// The models a schema refers to.
pub(super) type Refs<'f> = HashSet<Model<'f>>;

/// Whether schemas describe what a client sends or what the API returns.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Direction {
    /// A tool's arguments.
    #[default]
    Input,
    /// A method's response bodies.
    Output,
}

/// Builds schemas, keeping each model's.
#[derive(Default)]
pub(super) struct Schemas<'f> {
    direction: Direction,
    /// The key of each model in `$defs`.
    keys: HashMap<Model<'f>, String>,
    /// Every key given out, so that each is unique.
    used: HashSet<String>,
    /// The schema of each model built so far, and the models it refers to.
    models: HashMap<Model<'f>, (Value, Refs<'f>)>,
}

impl<'f> Schemas<'f> {
    /// Returns a builder of the schemas of response bodies.
    pub(super) fn output() -> Schemas<'f> {
        Schemas {
            direction: Direction::Output,
            ..Schemas::default()
        }
    }

    /// Returns the schema of `t`, adding the models it refers to to `refs`.
    pub(super) fn ty(&mut self, t: Type<'f>, refs: &mut Refs<'f>) -> Value {
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
            Type::Model(model) => {
                refs.insert(model);
                json!({ "$ref": format!("#/$defs/{}", self.key(model)) })
            }
        }
    }

    /// Returns the schema of `field`: the schema of its type, with its
    /// description, default and deprecation for arguments.
    pub(super) fn field(&mut self, field: Field<'f>, refs: &mut Refs<'f>) -> Value {
        let mut schema = self.ty(field.ty(), refs);
        if self.direction == Direction::Input
            && let Value::Object(map) = &mut schema
        {
            if !field.description().is_empty() {
                map.insert("description".to_owned(), json!(field.description()));
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

    /// Returns the `$defs` of a schema that refers to `refs`: each model they
    /// refer to, directly or through other models, by key.
    pub(super) fn defs(&mut self, refs: &Refs<'f>) -> BTreeMap<String, Model<'f>> {
        let mut defs = BTreeMap::new();
        let mut queue: Vec<Model<'f>> = refs.iter().copied().collect();
        while let Some(model) = queue.pop() {
            let key = self.key(model);
            if defs.insert(key, model).is_some() {
                continue;
            }
            self.model(model);
            queue.extend(self.models[&model].1.iter().copied());
        }
        defs
    }

    /// Returns every model built so far, with its key and schema.
    pub(super) fn built(&self) -> impl Iterator<Item = (Model<'f>, &str, &Value)> {
        self.models
            .iter()
            .map(|(model, (schema, _))| (*model, self.keys[model].as_str(), schema))
    }

    /// Builds the schema of `model`, the first time.
    fn model(&mut self, model: Model<'f>) {
        if self.models.contains_key(&model) {
            return;
        }
        let mut refs = Refs::new();
        let mut schema = self.ty(model.ty(), &mut refs);
        if self.direction == Direction::Input
            && let Value::Object(map) = &mut schema
        {
            if !model.description().is_empty() && !map.contains_key("description") {
                map.insert("description".to_owned(), json!(model.description()));
            }
            if model.is_deprecated() {
                map.insert("deprecated".to_owned(), json!(true));
            }
        }
        self.models.insert(model, (schema, refs));
    }

    /// Returns the schema of `object`.
    fn object(&mut self, object: Object<'f>, refs: &mut Refs<'f>) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        let input = self.direction == Direction::Input;
        for field in object.fields().filter(|f| !(input && f.is_read_only())) {
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

    /// Returns the key of `model` in `$defs`: its schema name, with each
    /// character that a JSON Pointer or a URI fragment would need escaped
    /// replaced by `_`, and a number added if another model has it.
    fn key(&mut self, model: Model<'f>) -> String {
        if let Some(key) = self.keys.get(&model) {
            return key.clone();
        }
        let base: String = model
            .schema_name()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let base = if base.is_empty() { "model".to_owned() } else { base };
        let mut key = base.clone();
        let mut n = 2;
        while self.used.contains(&key) {
            key = format!("{base}_{n}");
            n += 1;
        }
        self.used.insert(key.clone());
        self.keys.insert(model, key.clone());
        key
    }
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
