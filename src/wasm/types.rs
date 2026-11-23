//! Unified WebAssembly representation of a [`crate::Forge`].
//!
//! Both the plugin host ([`super::host`]) and the JavaScript library component
//! ([`super::library`]) bind the WIT `forge:plugin/forge` interface to the
//! types in this module, with [`ForgeWasm`] corresponding to the WIT `forge`
//! record.

#[cfg(feature = "wasm")]
use wasmtime::component::{ComponentType, Lower};

use crate::arena::Str;
use crate::method::{ContentData, ResponseData};
use crate::types::{EnumData, TypeData};
use crate::{
    Availability as CoreAvailability, Forge as CoreForge, GroupData, HttpMethod as CoreHttpMethod, Json as CoreJson,
    Location as CoreLocation, MethodData, ModelData, Name as CoreName, Number as CoreNumber, Scalar as CoreScalar,
};

pub type GroupId = u32;
pub type MethodId = u32;
pub type ModelId = u32;
pub type TypeId = u32;
pub type Name = Vec<String>;
pub type Json = String;

/// Value-based WebAssembly representation of a [`crate::Forge`].
///
/// Layered additively on top of [`crate::Forge`] via [`From<&crate::Forge>`],
/// holding all groups, methods, models, and types in flat indexable tables so
/// both the plugin host and the JavaScript library share one Rust type, one
/// WIT `forge` record, and one JavaScript `Forge` interface.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ForgeWasm {
    pub info: ForgeInfo,
    #[cfg_attr(feature = "wasm", component(name = "group-order"))]
    pub group_order: Vec<GroupId>,
    pub groups: Vec<GroupInfo>,
    pub methods: Vec<MethodInfo>,
    pub models: Vec<ModelInfo>,
    pub types: Vec<TypeInfo>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ForgeInfo {
    pub version: String,
    pub description: String,
    #[cfg_attr(feature = "wasm", component(name = "base-url"))]
    pub base_url: String,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct GroupInfo {
    pub name: Name,
    pub description: String,
    pub path: Vec<GroupId>,
    pub parent: Option<GroupId>,
    pub children: Vec<GroupId>,
    pub methods: Vec<MethodId>,
    pub models: Vec<ModelId>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(variant))]
pub enum HttpMethod {
    #[cfg_attr(feature = "wasm", component(name = "get"))]
    Get,
    #[cfg_attr(feature = "wasm", component(name = "put"))]
    Put,
    #[cfg_attr(feature = "wasm", component(name = "post"))]
    Post,
    #[cfg_attr(feature = "wasm", component(name = "delete"))]
    Delete,
    #[cfg_attr(feature = "wasm", component(name = "options"))]
    Options,
    #[cfg_attr(feature = "wasm", component(name = "head"))]
    Head,
    #[cfg_attr(feature = "wasm", component(name = "patch"))]
    Patch,
    #[cfg_attr(feature = "wasm", component(name = "trace"))]
    Trace,
    #[cfg_attr(feature = "wasm", component(name = "query"))]
    Query,
    #[cfg_attr(feature = "wasm", component(name = "connect"))]
    Connect,
    #[cfg_attr(feature = "wasm", component(name = "other"))]
    Other(String),
}

#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(variant))]
pub enum Location {
    #[cfg_attr(feature = "wasm", component(name = "path"))]
    Path,
    #[cfg_attr(feature = "wasm", component(name = "query"))]
    Query(bool),
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ContentInfo {
    #[cfg_attr(feature = "wasm", component(name = "media-type"))]
    pub media_type: String,
    pub ty: TypeId,
    pub description: String,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct BodyInfo {
    pub required: bool,
    pub description: String,
    pub contents: Vec<ContentInfo>,
    pub json: Option<u32>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ResponseInfo {
    pub status: String,
    pub description: String,
    pub contents: Vec<ContentInfo>,
    pub json: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(enum))]
pub enum Availability {
    #[cfg_attr(feature = "wasm", component(name = "alpha"))]
    Alpha,
    #[cfg_attr(feature = "wasm", component(name = "beta"))]
    Beta,
    #[cfg_attr(feature = "wasm", component(name = "preview"))]
    Preview,
    #[cfg_attr(feature = "wasm", component(name = "generally-available"))]
    GenerallyAvailable,
    #[cfg_attr(feature = "wasm", component(name = "deprecated"))]
    Deprecated,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct MethodInfo {
    pub name: Name,
    pub group: GroupId,
    #[cfg_attr(feature = "wasm", component(name = "http-method"))]
    pub http_method: HttpMethod,
    pub path: String,
    pub summary: String,
    pub description: String,
    pub deprecated: bool,
    pub availability: Option<Availability>,
    pub hidden: bool,
    pub confirmation: Option<String>,
    pub request: Option<TypeId>,
    pub params: Option<TypeId>,
    pub locations: Vec<Location>,
    pub headers: Option<TypeId>,
    pub body: Option<BodyInfo>,
    pub responses: Vec<ResponseInfo>,
    pub errors: Vec<ResponseInfo>,
    pub extensions: Vec<(String, Json)>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ModelInfo {
    #[cfg_attr(feature = "wasm", component(name = "schema-name"))]
    pub schema_name: String,
    pub name: Name,
    pub group: GroupId,
    pub description: String,
    pub deprecated: bool,
    pub ty: TypeId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(enum))]
pub enum Number {
    #[cfg_attr(feature = "wasm", component(name = "int"))]
    Int,
    #[cfg_attr(feature = "wasm", component(name = "int8"))]
    Int8,
    #[cfg_attr(feature = "wasm", component(name = "int16"))]
    Int16,
    #[cfg_attr(feature = "wasm", component(name = "int32"))]
    Int32,
    #[cfg_attr(feature = "wasm", component(name = "int64"))]
    Int64,
    #[cfg_attr(feature = "wasm", component(name = "uint8"))]
    Uint8,
    #[cfg_attr(feature = "wasm", component(name = "uint16"))]
    Uint16,
    #[cfg_attr(feature = "wasm", component(name = "uint32"))]
    Uint32,
    #[cfg_attr(feature = "wasm", component(name = "uint64"))]
    Uint64,
    #[cfg_attr(feature = "wasm", component(name = "float"))]
    Float,
    #[cfg_attr(feature = "wasm", component(name = "double"))]
    Double,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(variant))]
pub enum Scalar {
    #[cfg_attr(feature = "wasm", component(name = "unknown"))]
    Unknown,
    #[cfg_attr(feature = "wasm", component(name = "null"))]
    Null,
    #[cfg_attr(feature = "wasm", component(name = "boolean"))]
    Boolean,
    #[cfg_attr(feature = "wasm", component(name = "string"))]
    String,
    #[cfg_attr(feature = "wasm", component(name = "number"))]
    Number(Number),
    #[cfg_attr(feature = "wasm", component(name = "date-time"))]
    DateTime,
    #[cfg_attr(feature = "wasm", component(name = "date"))]
    Date,
    #[cfg_attr(feature = "wasm", component(name = "bytes"))]
    Bytes,
    #[cfg_attr(feature = "wasm", component(name = "binary"))]
    Binary,
    #[cfg_attr(feature = "wasm", component(name = "uuid"))]
    Uuid,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(variant))]
pub enum EnumValue {
    #[cfg_attr(feature = "wasm", component(name = "string"))]
    String(String),
    #[cfg_attr(feature = "wasm", component(name = "number"))]
    Number(f64),
    #[cfg_attr(feature = "wasm", component(name = "boolean"))]
    Boolean(bool),
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct FieldInfo {
    #[cfg_attr(feature = "wasm", component(name = "wire-name"))]
    pub wire_name: String,
    pub name: Name,
    pub required: bool,
    pub ty: TypeId,
    pub description: String,
    pub deprecated: bool,
    #[cfg_attr(feature = "wasm", component(name = "read-only"))]
    pub read_only: bool,
    pub sensitive: bool,
    pub default: Option<Json>,
}

#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ArrayInfo {
    pub elem: TypeId,
    #[cfg_attr(feature = "wasm", component(name = "min-items"))]
    pub min_items: Option<u64>,
    #[cfg_attr(feature = "wasm", component(name = "max-items"))]
    pub max_items: Option<u64>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct ObjectInfo {
    pub fields: Vec<FieldInfo>,
    pub extra: Option<TypeId>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct DiscriminatorInfo {
    #[cfg_attr(feature = "wasm", component(name = "wire-name"))]
    pub wire_name: String,
    pub name: Name,
    pub cases: Vec<(String, TypeId)>,
    pub default: Option<ModelId>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(record))]
pub struct UnionInfo {
    pub members: Vec<TypeId>,
    pub exclusive: bool,
    pub discriminator: Option<DiscriminatorInfo>,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "wasm", derive(ComponentType, Lower))]
#[cfg_attr(feature = "wasm", component(variant))]
pub enum TypeInfo {
    #[cfg_attr(feature = "wasm", component(name = "scalar"))]
    Scalar(Scalar),
    #[cfg_attr(feature = "wasm", component(name = "enum"))]
    Enum(Vec<EnumValue>),
    #[cfg_attr(feature = "wasm", component(name = "array"))]
    Array(ArrayInfo),
    #[cfg_attr(feature = "wasm", component(name = "object"))]
    Object(ObjectInfo),
    #[cfg_attr(feature = "wasm", component(name = "union"))]
    Union(UnionInfo),
    #[cfg_attr(feature = "wasm", component(name = "intersection"))]
    Intersection(Vec<TypeId>),
    #[cfg_attr(feature = "wasm", component(name = "model"))]
    Model(ModelId),
}

impl From<&CoreForge> for ForgeWasm {
    fn from(forge: &CoreForge) -> Self {
        ForgeWasm {
            info: ForgeInfo {
                version: forge.version.clone(),
                description: forge.description.clone(),
                base_url: forge.base_url.clone(),
            },
            group_order: forge.groups().map(|group| group.id.0).collect(),
            groups: forge.groups.iter().map(group_info).collect(),
            methods: forge.methods.iter().map(|data| method_info(forge, data)).collect(),
            models: forge.models.iter().map(|data| model_info(forge, data)).collect(),
            types: forge.types.iter().map(|data| type_info(forge, data)).collect(),
        }
    }
}

fn group_info(data: &GroupData) -> GroupInfo {
    // As in `Group::path` and `Group::parent`: the stored path starts
    // with the root, and ends with the group.
    GroupInfo {
        name: words(&data.name),
        description: data.description.clone(),
        path: data.path[1..].iter().map(|id| id.0).collect(),
        parent: data.path.iter().rev().nth(1).map(|id| id.0),
        children: data.groups.iter().map(|id| id.0).collect(),
        methods: data.methods.iter().map(|id| id.0).collect(),
        models: data.models.iter().map(|id| id.0).collect(),
    }
}

fn method_info(forge: &CoreForge, data: &MethodData) -> MethodInfo {
    let s = |s: Str| forge.strings.get(s).to_owned();
    MethodInfo {
        name: words(&data.name),
        group: data.group.0,
        http_method: match &data.http_method {
            CoreHttpMethod::Get => HttpMethod::Get,
            CoreHttpMethod::Put => HttpMethod::Put,
            CoreHttpMethod::Post => HttpMethod::Post,
            CoreHttpMethod::Delete => HttpMethod::Delete,
            CoreHttpMethod::Options => HttpMethod::Options,
            CoreHttpMethod::Head => HttpMethod::Head,
            CoreHttpMethod::Patch => HttpMethod::Patch,
            CoreHttpMethod::Trace => HttpMethod::Trace,
            CoreHttpMethod::Query => HttpMethod::Query,
            CoreHttpMethod::Connect => HttpMethod::Connect,
            CoreHttpMethod::Other(method) => HttpMethod::Other(method.clone()),
        },
        path: s(data.path),
        summary: s(data.summary),
        description: s(data.description),
        deprecated: data.deprecated,
        availability: data.availability.map(|availability| match availability {
            CoreAvailability::Alpha => Availability::Alpha,
            CoreAvailability::Beta => Availability::Beta,
            CoreAvailability::Preview => Availability::Preview,
            CoreAvailability::GenerallyAvailable => Availability::GenerallyAvailable,
            CoreAvailability::Deprecated => Availability::Deprecated,
        }),
        hidden: data.hidden,
        confirmation: data.confirmation.map(s),
        request: data.request.map(|id| id.0),
        params: data.params.map(|id| id.0),
        locations: data
            .locations
            .iter()
            .map(|location| match *location {
                CoreLocation::Path => Location::Path,
                CoreLocation::Query { exploded } => Location::Query(exploded),
            })
            .collect(),
        headers: data.headers.map(|id| id.0),
        body: data.body.as_ref().map(|body| BodyInfo {
            required: body.required,
            description: s(body.description),
            contents: contents(forge, &body.contents),
            json: body.json,
        }),
        responses: data.responses.iter().map(|data| response(forge, data)).collect(),
        errors: data.errors.iter().map(|data| response(forge, data)).collect(),
        extensions: forge
            .extensions
            .get(data.extensions)
            .iter()
            .map(|(name, value)| (name.clone(), json(value)))
            .collect(),
    }
}

fn model_info(forge: &CoreForge, data: &ModelData) -> ModelInfo {
    ModelInfo {
        schema_name: forge.strings.get(data.schema_name).to_owned(),
        name: words(&data.name),
        group: data.group.0,
        description: forge.strings.get(data.description).to_owned(),
        deprecated: data.deprecated,
        ty: data.ty.0,
    }
}

fn type_info(forge: &CoreForge, data: &TypeData) -> TypeInfo {
    let s = |s: Str| forge.strings.get(s).to_owned();
    match data {
        TypeData::Scalar(scalar) => TypeInfo::Scalar(match *scalar {
            CoreScalar::Unknown => Scalar::Unknown,
            CoreScalar::Null => Scalar::Null,
            CoreScalar::Boolean => Scalar::Boolean,
            CoreScalar::String => Scalar::String,
            CoreScalar::Uuid => Scalar::Uuid,
            CoreScalar::Number(number) => Scalar::Number(match number {
                CoreNumber::Int => Number::Int,
                CoreNumber::Int8 => Number::Int8,
                CoreNumber::Int16 => Number::Int16,
                CoreNumber::Int32 => Number::Int32,
                CoreNumber::Int64 => Number::Int64,
                CoreNumber::Uint8 => Number::Uint8,
                CoreNumber::Uint16 => Number::Uint16,
                CoreNumber::Uint32 => Number::Uint32,
                CoreNumber::Uint64 => Number::Uint64,
                CoreNumber::Float => Number::Float,
                CoreNumber::Double => Number::Double,
            }),
            CoreScalar::DateTime => Scalar::DateTime,
            CoreScalar::Date => Scalar::Date,
            CoreScalar::Bytes => Scalar::Bytes,
            CoreScalar::Binary => Scalar::Binary,
        }),
        TypeData::Enum(values) => TypeInfo::Enum(
            forge
                .values
                .get(*values)
                .iter()
                .map(|value| match *value {
                    EnumData::String(value) => EnumValue::String(s(value)),
                    EnumData::Number(value) => EnumValue::Number(value),
                    EnumData::Boolean(value) => EnumValue::Boolean(value),
                })
                .collect(),
        ),
        TypeData::Array(array) => TypeInfo::Array(ArrayInfo {
            elem: array.elem.0,
            min_items: array.min_items,
            max_items: array.max_items,
        }),
        TypeData::Object(object) => TypeInfo::Object(ObjectInfo {
            fields: forge
                .fields
                .get(object.fields)
                .iter()
                .map(|field| FieldInfo {
                    wire_name: s(field.wire_name),
                    name: words(&forge.names[field.name.index()]),
                    required: field.required,
                    ty: field.ty.0,
                    description: s(field.description),
                    deprecated: field.deprecated,
                    read_only: field.read_only,
                    sensitive: field.sensitive,
                    default: field.default.map(|id| json(&forge.defaults[id.index()])),
                })
                .collect(),
            extra: object.extra.map(|id| id.0),
        }),
        TypeData::Union(union) => TypeInfo::Union(UnionInfo {
            members: forge.members.get(union.members).iter().map(|id| id.0).collect(),
            exclusive: union.exclusive,
            discriminator: union.discriminator.as_ref().map(|data| DiscriminatorInfo {
                wire_name: s(data.wire_name),
                name: words(&data.name),
                cases: data.cases.iter().map(|&(value, id)| (s(value), id.0)).collect(),
                default: data.default.map(|id| id.0),
            }),
        }),
        TypeData::Intersection(members) => {
            TypeInfo::Intersection(forge.members.get(*members).iter().map(|id| id.0).collect())
        }
        TypeData::Model(id) => TypeInfo::Model(id.0),
    }
}

fn words(name: &CoreName) -> Vec<String> {
    name.words().to_vec()
}

fn response(forge: &CoreForge, data: &ResponseData) -> ResponseInfo {
    ResponseInfo {
        status: forge.strings.get(data.status).to_owned(),
        description: forge.strings.get(data.description).to_owned(),
        contents: contents(forge, &data.contents),
        json: data.json,
    }
}

fn contents(forge: &CoreForge, contents: &[ContentData]) -> Vec<ContentInfo> {
    contents
        .iter()
        .map(|data| ContentInfo {
            media_type: forge.strings.get(data.media_type).to_owned(),
            ty: data.ty.0,
            description: forge.strings.get(data.description).to_owned(),
        })
        .collect()
}

/// Returns `value` as JSON text, which `JSON.parse` reads back as the same
/// value: an object's members in order, and a number as JavaScript writes
/// it when it is an integer it can hold exactly.
pub(crate) fn json(value: &CoreJson) -> String {
    fn write(out: &mut String, value: &CoreJson) {
        match value {
            CoreJson::Null => out.push_str("null"),
            CoreJson::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            // JSON can't write these, and reading JSON never makes them.
            CoreJson::Number(n) if !n.is_finite() => out.push_str("null"),
            CoreJson::Number(n) => {
                use std::fmt::Write;
                let _ = write!(out, "{n}");
            }
            CoreJson::String(s) => string(out, s),
            CoreJson::Array(elements) => {
                out.push('[');
                for (i, element) in elements.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(out, element);
                }
                out.push(']');
            }
            CoreJson::Object(members) => {
                out.push('{');
                for (i, (key, value)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    string(out, key);
                    out.push(':');
                    write(out, value);
                }
                out.push('}');
            }
        }
    }
    fn string(out: &mut String, s: &str) {
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    use std::fmt::Write;
                    let _ = write!(out, "\\u{:04x}", c as u32);
                }
                c => out.push(c),
            }
        }
        out.push('"');
    }
    let mut out = String::new();
    write(&mut out, value);
    out
}

#[cfg(test)]
mod tests {
    use super::json;
    use crate::Json;

    /// Reads `text` as forge reads JSON.
    fn read(text: &str) -> Json {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn json_is_text_that_reads_back_as_the_value() {
        for text in [
            "null",
            "true",
            "false",
            "0",
            "-0",
            "1",
            "-12.5",
            "1e21",
            "0.0000001",
            "9007199254740993",
            r#""""#,
            r#""a \"quoted\" \\ line\nand\ttab\u0001 é 😀""#,
            "[]",
            "{}",
            r#"[1, [2, {"a": null}], "x"]"#,
            // Members keep their order, and a repeated key its last value
            // in the place of the first, as forge reads them.
            r#"{"b": 1, "a": {"z": [], "y": false}, "b": 2}"#,
        ] {
            let value = read(text);
            assert_eq!(read(&json(&value)), value, "{text} wrote {}", json(&value));
        }
    }

    #[test]
    fn json_is_compact_and_ordered() {
        assert_eq!(
            json(&read(r#"{ "b" : [1, 2.5], "a": "x" }"#)),
            r#"{"b":[1,2.5],"a":"x"}"#
        );
        assert_eq!(json(&read("1.0")), "1");
        assert_eq!(json(&read(r#""\u0001""#)), r#""\u0001""#);
    }
}
