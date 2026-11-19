//! Serializes a [`Forge`] into a single `capnstruct` binary buffer
//! ([`schema::ForgeDoc`]), shared by both the native WASM plugin host
//! (`host.rs`) and the in-process `@cloudflare/forge` WASM library
//! (`library.rs`).

use crate::arena::Str;
use crate::method::{ContentData, ResponseData};
use crate::types::{EnumData, FieldData, TypeData};
use crate::{
    Availability, Forge, GroupData, HttpMethod, Json, Location, MethodData, ModelData, Name, Number, Scalar,
};

use super::schema::{self, CapnBuilder, CapnSlice, CapnStr};

/// Packs the entire `forge` into a single 8-byte-aligned `capnstruct` buffer
/// whose root record is [`schema::ForgeDoc`]. Strings are deduplicated via
/// [`CapnBuilder::str_dedup`].
#[must_use]
pub fn pack_forge(forge: &Forge) -> Vec<u8> {
    let mut b = CapnBuilder::with_capacity(
        forge.types.len() * 64 + forge.methods.len() * 256 + forge.models.len() * 64,
    );
    let group_order: Vec<u32> = forge.groups().map(|group| group.id.0).collect();

    b.build_vec(|b| {
        let version = b.str(&forge.version);
        let description = b.str(&forge.description);
        let base_url = b.str(&forge.base_url);
        let group_order_slice = b.pack_slice(&group_order);
        let groups = b.build_slice(forge.groups.len(), |i, b| pack_group(b, &forge.groups[i]));
        let methods = b.build_slice(forge.methods.len(), |i, b| pack_method(b, forge, &forge.methods[i]));
        let models = b.build_slice(forge.models.len(), |i, b| pack_model(b, forge, &forge.models[i]));
        let types = b.build_slice(forge.types.len(), |i, b| pack_type(b, forge, &forge.types[i]));
        schema::ForgeDoc {
            version,
            description,
            baseUrl: base_url,
            groupOrder: group_order_slice,
            groups,
            methods,
            models,
            types,
        }
    })
}

fn pack_words(b: &mut CapnBuilder, name: &Name) -> CapnSlice<CapnStr> {
    let words = name.words();
    b.build_slice(words.len(), |i, b| b.str_dedup(&words[i]))
}

fn pack_group(b: &mut CapnBuilder, data: &GroupData) -> schema::GroupInfo {
    let name = pack_words(b, &data.name);
    let description = b.str(&data.description);
    let path_ids: Vec<u32> = data.path[1..].iter().map(|id| id.0).collect();
    let path = b.pack_slice(&path_ids);
    let parent = data.path.iter().rev().nth(1).map_or(schema::GroupInfo::PARENT_NULL, |id| id.0);
    let child_ids: Vec<u32> = data.groups.iter().map(|id| id.0).collect();
    let children = b.pack_slice(&child_ids);
    let method_ids: Vec<u32> = data.methods.iter().map(|id| id.0).collect();
    let methods = b.pack_slice(&method_ids);
    let model_ids: Vec<u32> = data.models.iter().map(|id| id.0).collect();
    let models = b.pack_slice(&model_ids);
    schema::GroupInfo {
        name,
        description,
        path,
        parent,
        children,
        methods,
        models,
    }
}

fn pack_method(b: &mut CapnBuilder, forge: &Forge, data: &MethodData) -> schema::MethodInfo {
    let s = |id: Str| forge.strings.get(id);
    let name = pack_words(b, &data.name);
    let http_method = match &data.http_method {
        HttpMethod::Get => schema::HttpMethod::Get,
        HttpMethod::Put => schema::HttpMethod::Put,
        HttpMethod::Post => schema::HttpMethod::Post,
        HttpMethod::Delete => schema::HttpMethod::Delete,
        HttpMethod::Options => schema::HttpMethod::Options,
        HttpMethod::Head => schema::HttpMethod::Head,
        HttpMethod::Patch => schema::HttpMethod::Patch,
        HttpMethod::Trace => schema::HttpMethod::Trace,
        HttpMethod::Query => schema::HttpMethod::Query,
        HttpMethod::Connect => schema::HttpMethod::Connect,
        HttpMethod::Other(method) => schema::HttpMethod::Other(b.str_dedup(method)),
    };
    let path = b.str(s(data.path));
    let summary = b.str(s(data.summary));
    let description = b.str(s(data.description));
    let availability = match data.availability {
        None => schema::Availability::None,
        Some(Availability::Alpha) => schema::Availability::Alpha,
        Some(Availability::Beta) => schema::Availability::Beta,
        Some(Availability::Preview) => schema::Availability::Preview,
        Some(Availability::GenerallyAvailable) => schema::Availability::GenerallyAvailable,
        Some(Availability::Deprecated) => schema::Availability::Deprecated,
    };
    let confirmation = b.opt_str_dedup(data.confirmation.map(s));
    let param_locations = b.build_slice(data.locations.len(), |i, _| match data.locations[i] {
        Location::Path => schema::Location::Path,
        Location::Query { exploded } => schema::Location::Query(exploded),
    });
    let body = b.build_ref_opt(data.body.as_ref(), |b, body| {
        let body_desc = b.str(s(body.description));
        let contents = pack_contents(b, forge, &body.contents);
        schema::BodyInfo {
            required: body.required,
            _pad0: [0; 3],
            description: body_desc,
            contents,
            json: body.json.unwrap_or(schema::BodyInfo::JSON_NULL),
        }
    });
    let responses = b.build_slice(data.responses.len(), |i, b| pack_response(b, forge, &data.responses[i]));
    let errors = b.build_slice(data.errors.len(), |i, b| pack_response(b, forge, &data.errors[i]));
    let ext_slice = forge.extensions.get(data.extensions);
    let extensions = b.build_slice(ext_slice.len(), |i, b| {
        let (key, value) = &ext_slice[i];
        let k = b.str_dedup(key);
        let v_text = json(value);
        let v = b.str_dedup(&v_text);
        schema::Extension { key: k, value: v }
    });

    schema::MethodInfo {
        name,
        group: data.group.0,
        httpMethod: http_method,
        path,
        summary,
        description,
        deprecated: data.deprecated,
        availability,
        hidden: data.hidden,
        _pad0: [0; 1],
        confirmation,
        request: data.request.map_or(schema::MethodInfo::REQUEST_NULL, |id| id.0),
        paramsType: data.params.map_or(schema::MethodInfo::PARAMS_TYPE_NULL, |id| id.0),
        paramLocations: param_locations,
        headers: data.headers.map_or(schema::MethodInfo::HEADERS_NULL, |id| id.0),
        body,
        responses,
        errors,
        extensions,
    }
}

fn pack_model(b: &mut CapnBuilder, forge: &Forge, data: &ModelData) -> schema::ModelInfo {
    let schema_name = b.str(forge.strings.get(data.schema_name));
    let name = pack_words(b, &data.name);
    let description = b.str(forge.strings.get(data.description));
    schema::ModelInfo {
        schemaName: schema_name,
        name,
        group: data.group.0,
        description,
        deprecated: data.deprecated,
        _pad0: [0; 3],
        ty: data.ty.0,
    }
}

fn pack_type(b: &mut CapnBuilder, forge: &Forge, data: &TypeData) -> schema::TypeInfo {
    let s = |id: Str| forge.strings.get(id);
    match data {
        TypeData::Scalar(scalar) => schema::TypeInfo::Scalar(match scalar {
            Scalar::Unknown => schema::Scalar::Unknown,
            Scalar::Null => schema::Scalar::Null,
            Scalar::Boolean => schema::Scalar::Boolean,
            Scalar::String => schema::Scalar::String,
            Scalar::DateTime => schema::Scalar::DateTime,
            Scalar::Date => schema::Scalar::Date,
            Scalar::Bytes => schema::Scalar::Bytes,
            Scalar::Binary => schema::Scalar::Binary,
            Scalar::Uuid => schema::Scalar::Uuid,
            Scalar::Number(number) => schema::Scalar::Number(match number {
                Number::Int => schema::NumberKind::Int,
                Number::Int8 => schema::NumberKind::Int8,
                Number::Int16 => schema::NumberKind::Int16,
                Number::Int32 => schema::NumberKind::Int32,
                Number::Int64 => schema::NumberKind::Int64,
                Number::Uint8 => schema::NumberKind::Uint8,
                Number::Uint16 => schema::NumberKind::Uint16,
                Number::Uint32 => schema::NumberKind::Uint32,
                Number::Uint64 => schema::NumberKind::Uint64,
                Number::Float => schema::NumberKind::Float,
                Number::Double => schema::NumberKind::Double,
            }),
        }),
        TypeData::Enum(values) => {
            let vals = forge.values.get(*values);
            let packed = b.build_slice(vals.len(), |i, b| match vals[i] {
                EnumData::String(value) => schema::EnumValue::String(b.str_dedup(s(value))),
                EnumData::Number(value) => schema::EnumValue::Number(value),
                EnumData::Boolean(value) => schema::EnumValue::Boolean(value),
            });
            schema::TypeInfo::Enum(packed)
        }
        TypeData::Array(array) => schema::TypeInfo::Array(schema::ArrayInfo {
            elem: array.elem.0,
            _pad0: [0; 4],
            minItems: array.min_items.unwrap_or(schema::ArrayInfo::MIN_ITEMS_NULL),
            maxItems: array.max_items.unwrap_or(schema::ArrayInfo::MAX_ITEMS_NULL),
        }),
        TypeData::Object(object) => {
            let fields_slice = forge.fields.get(object.fields);
            let fields = b.build_slice(fields_slice.len(), |i, b| pack_field(b, forge, &fields_slice[i]));
            schema::TypeInfo::Object(schema::ObjectInfo {
                fields,
                extra: object.extra.map_or(schema::ObjectInfo::EXTRA_NULL, |id| id.0),
            })
        }
        TypeData::Union(union) => {
            let member_ids: Vec<u32> = forge.members.get(union.members).iter().map(|id| id.0).collect();
            let members = b.pack_slice(&member_ids);
            let discriminator = b.build_ref_opt(union.discriminator.as_ref(), |b, disc| {
                let wire_name = b.str_dedup(s(disc.wire_name));
                let name = pack_words(b, &disc.name);
                let cases = b.build_slice(disc.cases.len(), |i, b| {
                    let (val, ty) = disc.cases[i];
                    schema::DiscriminatorCase {
                        value: b.str_dedup(s(val)),
                        ty: ty.0,
                    }
                });
                schema::DiscriminatorInfo {
                    wireName: wire_name,
                    name,
                    cases,
                    defaultModel: disc.default.map_or(schema::DiscriminatorInfo::DEFAULT_MODEL_NULL, |id| id.0),
                }
            });
            schema::TypeInfo::Union(schema::UnionInfo {
                members,
                exclusive: union.exclusive,
                _pad0: [0; 3],
                discriminator,
            })
        }
        TypeData::Intersection(members) => {
            let member_ids: Vec<u32> = forge.members.get(*members).iter().map(|id| id.0).collect();
            schema::TypeInfo::Intersection(b.pack_slice(&member_ids))
        }
        TypeData::Model(id) => schema::TypeInfo::Model(id.0),
    }
}

fn pack_field(b: &mut CapnBuilder, forge: &Forge, field: &FieldData) -> schema::FieldInfo {
    let s = |id: Str| forge.strings.get(id);
    let wire_name = b.str_dedup(s(field.wire_name));
    let name = pack_words(b, &forge.names[field.name.index()]);
    let description = b.str(s(field.description));
    let default = b.opt_str_dedup(field.default.map(|id| json(&forge.defaults[id.index()])).as_deref());
    schema::FieldInfo {
        wireName: wire_name,
        name,
        description,
        default,
        ty: field.ty.0,
        required: field.required,
        deprecated: field.deprecated,
        readOnly: field.read_only,
        sensitive: field.sensitive,
    }
}

fn pack_response(b: &mut CapnBuilder, forge: &Forge, data: &ResponseData) -> schema::ResponseInfo {
    let s = |id: Str| forge.strings.get(id);
    let status = b.str_dedup(s(data.status));
    let description = b.str(s(data.description));
    let contents = pack_contents(b, forge, &data.contents);
    schema::ResponseInfo {
        status,
        description,
        contents,
        json: data.json.unwrap_or(schema::ResponseInfo::JSON_NULL),
    }
}

fn pack_contents(b: &mut CapnBuilder, forge: &Forge, contents: &[ContentData]) -> CapnSlice<schema::ContentInfo> {
    let s = |id: Str| forge.strings.get(id);
    b.build_slice(contents.len(), |i, b| {
        let data = &contents[i];
        schema::ContentInfo {
            mediaType: b.str_dedup(s(data.media_type)),
            ty: data.ty.0,
            description: b.str(s(data.description)),
        }
    })
}

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
