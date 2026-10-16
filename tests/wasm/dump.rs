//! Writes out everything a forge's public API gives, for tests/wasm.rs to
//! compare. It compiles against forge itself, and in the guest, with the
//! `dump` feature, against the copy of the API the guest reads through the
//! WIT, so two dumps that agree show the WIT carries all of it.

use std::fmt::Write;

use forge::{Content, Field, Forge, Group, Method, Model, Name, Object, Type};

/// Returns everything `forge` has, as text.
pub fn dump(forge: &Forge) -> String {
    let mut out = String::new();
    let o = &mut out;
    line(o, 0, format_args!("version {:?}", forge.version));
    line(o, 0, format_args!("description {:?}", forge.description));
    line(o, 0, format_args!("base url {:?}", forge.base_url));
    for model in forge.models() {
        self::model(o, 0, model);
    }
    for group in forge.groups() {
        self::group(o, group);
    }
    out
}

fn line(out: &mut String, depth: usize, args: std::fmt::Arguments<'_>) {
    let _ = writeln!(out, "{}{args}", "  ".repeat(depth));
}

fn name(name: &Name) -> String {
    name.words().join(" ")
}

fn group(o: &mut String, group: Group<'_>) {
    let path: Vec<String> = group.path().map(name).collect();
    line(o, 0, format_args!("group {path:?} {:?}", group.description()));
    let parent = group.parent().map(|parent| name(parent.name()));
    let children: Vec<String> = group.children().map(|child| name(child.name())).collect();
    let descendants: Vec<String> = group.descendants().map(|d| name(d.name())).collect();
    line(
        o,
        1,
        format_args!("parent {parent:?} children {children:?} descendants {descendants:?}"),
    );
    for model in group.models() {
        self::model(o, 1, model);
    }
    for method in group.methods() {
        self::method(o, method);
    }
}

fn model(o: &mut String, depth: usize, model: Model<'_>) {
    let group = model.group().map(|group| group.path().map(name).collect::<Vec<_>>());
    line(
        o,
        depth,
        format_args!(
            "model {:?} name {:?} group {group:?} description {:?} deprecated {}",
            model.schema_name(),
            name(model.name()),
            model.description(),
            model.is_deprecated(),
        ),
    );
    ty(o, depth + 1, None, model.ty());
}

fn method(o: &mut String, method: Method<'_>) {
    line(
        o,
        1,
        format_args!(
            "method {:?} {} {:?} in {:?}",
            name(method.name()),
            method.http_method().as_str(),
            method.path(),
            name(method.group().name()),
        ),
    );
    line(
        o,
        2,
        format_args!("summary {:?} description {:?}", method.summary(), method.description()),
    );
    line(
        o,
        2,
        format_args!(
            "deprecated {} availability {:?} hidden {} confirmation {:?}",
            method.is_deprecated(),
            method.availability().map(|a| a.as_str()),
            method.is_hidden(),
            method.confirmation(),
        ),
    );
    for (key, value) in method.extensions() {
        line(o, 2, format_args!("extension {key:?} = {value:?}"));
        assert_eq!(method.extension(key), Some(value));
    }
    if let Some(request) = method.request() {
        line(o, 2, format_args!("request"));
        ty(o, 3, Some(method), request);
    }
    if let Some(headers) = method.headers() {
        line(o, 2, format_args!("headers"));
        object(o, 3, Some(method), headers);
    }
    if let Some(body) = method.body() {
        line(
            o,
            2,
            format_args!(
                "body required {} description {:?}",
                body.is_required(),
                body.description()
            ),
        );
        let json = body.json().map(|c| c.media_type());
        line(o, 3, format_args!("json {json:?}"));
        for content in body.contents() {
            self::content(o, content);
        }
    }
    for (kind, responses) in [
        ("response", method.responses().collect::<Vec<_>>()),
        ("error", method.errors().collect()),
    ] {
        for response in responses {
            let json = response.json().map(|c| c.media_type());
            line(
                o,
                2,
                format_args!(
                    "{kind} {:?} {:?} json {json:?}",
                    response.status(),
                    response.description()
                ),
            );
            for content in response.contents() {
                self::content(o, content);
            }
        }
    }
}

fn content(o: &mut String, content: Content<'_>) {
    line(
        o,
        3,
        format_args!(
            "content {:?} json {} description {:?}",
            content.media_type(),
            content.is_json(),
            content.description(),
        ),
    );
    ty(o, 4, None, content.ty());
}

/// Writes `ty`, and the location in `method` of each field it has.
fn ty(o: &mut String, depth: usize, method: Option<Method<'_>>, ty: Type<'_>) {
    match ty {
        Type::Scalar(scalar) => line(
            o,
            depth,
            format_args!("{:?} format {:?}", scalar.kind(), scalar.format()),
        ),
        Type::Enum(values) => line(o, depth, format_args!("enum {:?}", values.values().collect::<Vec<_>>())),
        Type::Array(array) => {
            line(
                o,
                depth,
                format_args!(
                    "array min items {:?} max items {:?}",
                    array.min_items(),
                    array.max_items()
                ),
            );
            self::ty(o, depth + 1, method, array.elem());
        }
        Type::Object(object) => self::object(o, depth, method, object),
        Type::Union(union) => {
            line(o, depth, format_args!("union exclusive {}", union.is_exclusive()));
            if let Some(d) = union.discriminator() {
                let cases: Vec<&str> = d.cases().map(|(value, _)| value).collect();
                let default = d.default().map(|m| m.schema_name());
                line(
                    o,
                    depth + 1,
                    format_args!(
                        "discriminator {:?} {:?} cases {cases:?} default {default:?}",
                        d.wire_name(),
                        name(d.name())
                    ),
                );
                for (_, member) in d.cases() {
                    self::ty(o, depth + 2, method, member);
                }
            }
            for member in union.members() {
                self::ty(o, depth + 1, method, member);
            }
        }
        Type::Intersection(intersection) => {
            line(o, depth, format_args!("intersection"));
            for member in intersection.members() {
                self::ty(o, depth + 1, method, member);
            }
        }
        // A model is written once, where it is declared, so cycles end here.
        Type::Model(model) => line(o, depth, format_args!("model {:?}", model.schema_name())),
    }
}

fn object(o: &mut String, depth: usize, method: Option<Method<'_>>, object: Object<'_>) {
    line(o, depth, format_args!("object"));
    for field in object.fields() {
        self::field(o, depth + 1, method, field);
    }
    if let Some(extra) = object.extra() {
        line(o, depth + 1, format_args!("extra"));
        ty(o, depth + 2, method, extra);
    }
}

fn field(o: &mut String, depth: usize, method: Option<Method<'_>>, field: Field<'_>) {
    let location = method.and_then(|method| method.location(field));
    line(
        o,
        depth,
        format_args!(
            "field {:?} {:?} required {} deprecated {} read only {} sensitive {} default {:?} location {location:?} description {:?}",
            field.wire_name(),
            name(field.name()),
            field.is_required(),
            field.is_deprecated(),
            field.is_read_only(),
            field.is_sensitive(),
            field.default(),
            field.description(),
        ),
    );
    ty(o, depth + 1, method, field.ty());
}
