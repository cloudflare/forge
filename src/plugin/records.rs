//! Writes a forge's parts as the records of the WIT. The host that runs
//! plugins ([`super::wasm`]) and the library ([`super::library`]) share this
//! code.
//!
//! Each side generates its own bindings of the WIT, so the functions are a
//! macro. Expand it where `wit` names that side's bindings of the `forge`
//! interface. Each side looks ids up itself, and decides how to fail on an
//! id it never gave out.

macro_rules! records {
    () => {
        /// Writes a forge's parts as the records of this side's bindings.
        mod wit_records {
            use super::wit;
            use crate::arena::Str;
            use crate::method::{ContentData, ResponseData};
            use crate::plugin::records::json;
            use crate::types::{EnumData, FieldData, TypeData};
            use crate::{
                Availability, Forge, GroupData, HttpMethod, Location, MethodData, ModelData, Name, Number, Scalar,
            };

            pub(super) fn forge_info(forge: &Forge) -> wit::ForgeInfo {
                wit::ForgeInfo {
                    version: forge.version.clone(),
                    description: forge.description.clone(),
                    base_url: forge.base_url.clone(),
                }
            }

            pub(super) fn forge_counts(forge: &Forge) -> wit::ForgeCounts {
                wit::ForgeCounts {
                    groups: forge.groups.len() as u32,
                    methods: forge.methods.len() as u32,
                    models: forge.models.len() as u32,
                    types: forge.types.len() as u32,
                }
            }

            /// Returns every group, depth first, starting with the root.
            pub(super) fn group_ids(forge: &Forge) -> Vec<u32> {
                forge.groups().map(|group| group.id.0).collect()
            }

            pub(super) fn group_info(data: &GroupData) -> wit::GroupInfo {
                // As in `Group::path` and `Group::parent`: the stored path starts
                // with the root, and ends with the group.
                wit::GroupInfo {
                    name: words(&data.name),
                    description: data.description.clone(),
                    path: data.path[1..].iter().map(|id| id.0).collect(),
                    parent: data.path.iter().rev().nth(1).map(|id| id.0),
                    children: data.groups.iter().map(|id| id.0).collect(),
                    methods: data.methods.iter().map(|id| id.0).collect(),
                    models: data.models.iter().map(|id| id.0).collect(),
                }
            }

            pub(super) fn method_info(forge: &Forge, data: &MethodData) -> wit::MethodInfo {
                let s = |s: Str| forge.strings.get(s).to_owned();
                wit::MethodInfo {
                    name: words(&data.name),
                    group: data.group.0,
                    http_method: match &data.http_method {
                        HttpMethod::Get => wit::HttpMethod::Get,
                        HttpMethod::Put => wit::HttpMethod::Put,
                        HttpMethod::Post => wit::HttpMethod::Post,
                        HttpMethod::Delete => wit::HttpMethod::Delete,
                        HttpMethod::Options => wit::HttpMethod::Options,
                        HttpMethod::Head => wit::HttpMethod::Head,
                        HttpMethod::Patch => wit::HttpMethod::Patch,
                        HttpMethod::Trace => wit::HttpMethod::Trace,
                        HttpMethod::Query => wit::HttpMethod::Query,
                        HttpMethod::Connect => wit::HttpMethod::Connect,
                        HttpMethod::Other(method) => wit::HttpMethod::Other(method.clone()),
                    },
                    path: s(data.path),
                    summary: s(data.summary),
                    description: s(data.description),
                    deprecated: data.deprecated,
                    availability: data.availability.map(|availability| match availability {
                        Availability::Alpha => wit::Availability::Alpha,
                        Availability::Beta => wit::Availability::Beta,
                        Availability::Preview => wit::Availability::Preview,
                        Availability::GenerallyAvailable => wit::Availability::GenerallyAvailable,
                        Availability::Deprecated => wit::Availability::Deprecated,
                    }),
                    hidden: data.hidden,
                    confirmation: data.confirmation.map(s),
                    request: data.request.map(|id| id.0),
                    headers: data.headers.map(|id| id.0),
                    body: data.body.as_ref().map(|body| wit::BodyInfo {
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

            pub(super) fn model_info(forge: &Forge, data: &ModelData) -> wit::ModelInfo {
                wit::ModelInfo {
                    schema_name: forge.strings.get(data.schema_name).to_owned(),
                    name: words(&data.name),
                    group: data.group.0,
                    description: forge.strings.get(data.description).to_owned(),
                    deprecated: data.deprecated,
                    ty: data.ty.0,
                }
            }

            pub(super) fn type_info(forge: &Forge, data: &TypeData) -> wit::TypeInfo {
                let s = |s: Str| forge.strings.get(s).to_owned();
                match data {
                    TypeData::Scalar(scalar) => wit::TypeInfo::Scalar(match *scalar {
                        Scalar::Unknown => wit::Scalar::Unknown,
                        Scalar::Null => wit::Scalar::Null,
                        Scalar::Boolean => wit::Scalar::Boolean,
                        Scalar::String => wit::Scalar::String,
                        Scalar::Uuid => wit::Scalar::Uuid,
                        Scalar::Number(number) => wit::Scalar::Number(match number {
                            Number::Int => wit::Number::Int,
                            Number::Int8 => wit::Number::Int8,
                            Number::Int16 => wit::Number::Int16,
                            Number::Int32 => wit::Number::Int32,
                            Number::Int64 => wit::Number::Int64,
                            Number::Uint8 => wit::Number::Uint8,
                            Number::Uint16 => wit::Number::Uint16,
                            Number::Uint32 => wit::Number::Uint32,
                            Number::Uint64 => wit::Number::Uint64,
                            Number::Float => wit::Number::Float,
                            Number::Double => wit::Number::Double,
                        }),
                        Scalar::DateTime => wit::Scalar::DateTime,
                        Scalar::Date => wit::Scalar::Date,
                        Scalar::Bytes => wit::Scalar::Bytes,
                        Scalar::Binary => wit::Scalar::Binary,
                    }),
                    TypeData::Enum(values) => wit::TypeInfo::Enum(
                        forge
                            .values
                            .get(*values)
                            .iter()
                            .map(|value| match *value {
                                EnumData::String(value) => wit::EnumValue::String(s(value)),
                                EnumData::Number(value) => wit::EnumValue::Number(value),
                                EnumData::Boolean(value) => wit::EnumValue::Boolean(value),
                            })
                            .collect(),
                    ),
                    TypeData::Array(array) => wit::TypeInfo::Array(wit::ArrayInfo {
                        elem: array.elem.0,
                        min_items: array.min_items,
                        max_items: array.max_items,
                    }),
                    TypeData::Object(object) => wit::TypeInfo::Object(wit::ObjectInfo {
                        fields: forge
                            .fields
                            .get(object.fields)
                            .iter()
                            .map(|field| wit::FieldInfo {
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
                    TypeData::Union(union) => wit::TypeInfo::Union(wit::UnionInfo {
                        members: forge.members.get(union.members).iter().map(|id| id.0).collect(),
                        exclusive: union.exclusive,
                        discriminator: union.discriminator.as_ref().map(|data| wit::DiscriminatorInfo {
                            wire_name: s(data.wire_name),
                            name: words(&data.name),
                            cases: data.cases.iter().map(|&(value, id)| (s(value), id.0)).collect(),
                            default: data.default.map(|id| id.0),
                        }),
                    }),
                    TypeData::Intersection(members) => {
                        wit::TypeInfo::Intersection(forge.members.get(*members).iter().map(|id| id.0).collect())
                    }
                    TypeData::Model(id) => wit::TypeInfo::Model(id.0),
                }
            }

            /// Returns where `method` sends `field`, or `None` when `field`
            /// is not one of its parameters. A field from another object
            /// with the same name returns `None`, because only the
            /// parameters themselves match.
            pub(super) fn location(forge: &Forge, method: &MethodData, field: &FieldData) -> Option<wit::Location> {
                let Some(TypeData::Object(params)) = method.params.map(|id| &forge.types[id.index()]) else {
                    return None;
                };
                let params: &[FieldData] = forge.fields.get(params.fields);
                let i = params.iter().position(|param| std::ptr::eq(param, field))?;
                method.locations.get(i).map(|location| match *location {
                    Location::Path => wit::Location::Path,
                    Location::Query { exploded } => wit::Location::Query(exploded),
                })
            }

            fn words(name: &Name) -> Vec<String> {
                name.words().to_vec()
            }
            fn response(forge: &Forge, data: &ResponseData) -> wit::ResponseInfo {
                wit::ResponseInfo {
                    status: forge.strings.get(data.status).to_owned(),
                    description: forge.strings.get(data.description).to_owned(),
                    contents: contents(forge, &data.contents),
                    json: data.json,
                }
            }
            fn contents(forge: &Forge, contents: &[ContentData]) -> Vec<wit::ContentInfo> {
                contents
                    .iter()
                    .map(|data| wit::ContentInfo {
                        media_type: forge.strings.get(data.media_type).to_owned(),
                        ty: data.ty.0,
                        description: forge.strings.get(data.description).to_owned(),
                    })
                    .collect()
            }
        }
        use wit_records::*;
    };
}

pub(crate) use records;

use crate::Json;

/// Returns `value` as JSON text, which `JSON.parse` reads back as the same
/// value: an object's members in order, and a number as JavaScript writes
/// it when it is an integer it can hold exactly.
pub(crate) fn json(value: &Json) -> String {
    fn write(out: &mut String, value: &Json) {
        match value {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            // JSON can't write these, and reading JSON never makes them.
            Json::Number(n) if !n.is_finite() => out.push_str("null"),
            Json::Number(n) => {
                use std::fmt::Write;
                let _ = write!(out, "{n}");
            }
            Json::String(s) => string(out, s),
            Json::Array(elements) => {
                out.push('[');
                for (i, element) in elements.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(out, element);
                }
                out.push(']');
            }
            Json::Object(members) => {
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
