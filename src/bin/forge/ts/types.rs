//! TypeScript types, following specs/03-schema-types.md.

use std::collections::HashSet;

use forge::ts::{Fragment, Ident, frag, join};
use forge::{EnumValue, Field, Model, Number, Object, Scalar, Type};

/// Where a type is printed, which decides whether a union or an
/// intersection needs parentheses. An intersection inside a union has them.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Prec {
    Top,
    Intersection,
    Array,
}

/// Returns `t` as part of a line.
///
/// ```text
/// p!(f, "export type ", m, " = ", typ(m.ty(), Prec::Top), ";");
/// ```
pub(super) fn typ(t: Type<'_>, prec: Prec) -> Fragment {
    match t {
        Type::Scalar(scalar) => frag!(scalar_type(scalar.kind())),
        Type::Model(m) => frag!(Ident::model(m).ty()),
        Type::Array(array) => frag!(typ(array.elem(), Prec::Array), "[]"),
        Type::Object(object) => object_type(object),
        Type::Enum(e) => {
            let values = join(" | ", e.values().map(literal));
            if e.values().len() > 1 && prec > Prec::Top {
                frag!("(", values, ")")
            } else {
                values
            }
        }
        Type::Union(union) => {
            let members = alternatives(union.members());
            if prec > Prec::Top {
                frag!("(", members, ")")
            } else {
                members
            }
        }
        Type::Intersection(intersection) => {
            let members = join(" & ", intersection.members().map(|m| typ(m, Prec::Intersection)));
            if prec >= Prec::Intersection {
                frag!("(", members, ")")
            } else {
                members
            }
        }
    }
}

fn scalar_type(scalar: Scalar) -> &'static str {
    match scalar {
        Scalar::Unknown => "unknown",
        Scalar::Null => "null",
        Scalar::Boolean => "boolean",
        Scalar::String => "string",
        Scalar::Number(Number::Int64) => "bigint",
        Scalar::Number(_) => "number",
        Scalar::DateTime => "Temporal.Instant",
        Scalar::Date => "Temporal.PlainDate",
        Scalar::Bytes => "Uint8Array",
        // Only JSON content reaches the SDK, and in JSON a string with
        // format `binary` is still a string on the wire, so it is kept
        // as one, with no codec.
        Scalar::Binary => "string",
    }
}

/// Returns an object type: its fields, and an index signature when it
/// allows other keys, or a map when it keeps no field.
fn object_type(object: Object<'_>) -> Fragment {
    if !has_fields(Type::Object(object)) {
        return frag!("{ [key: string]: ", typ(elem(object), Prec::Top), " }");
    }
    let mut open = object.extra().is_some();
    let mut members = Vec::new();
    for field in fields(object) {
        if kept(field) {
            members.push(member(field));
        } else {
            open = true;
        }
    }
    let mut out = frag!("{ ", join("; ", members));
    if open {
        out.text("; [key: string]: unknown");
    }
    out.text(" }");
    out
}

/// Returns `types` joined by ` | `. A union among them, which has a
/// discriminator, and an enum need no parentheses.
pub(super) fn alternatives<'f>(types: impl IntoIterator<Item = Type<'f>>) -> Fragment {
    join(
        " | ",
        types.into_iter().map(|t| match t {
            Type::Union(_) | Type::Enum(_) => typ(t, Prec::Top),
            _ => typ(t, Prec::Intersection),
        }),
    )
}

/// Returns a property of an object type, without the `;` after it.
pub(super) fn member(field: Field<'_>) -> Fragment {
    frag!(
        key(&field.name().camel()),
        if field.is_required() { ": " } else { "?: " },
        typ(field.ty(), Prec::Top)
    )
}

/// Returns the documentation of a declaration, with `@deprecated` after it
/// when it is deprecated.
pub(super) fn doc(text: &str, deprecated: bool) -> String {
    if !deprecated {
        return text.to_owned();
    }
    let text = text.trim();
    if text.is_empty() {
        "@deprecated".to_owned()
    } else {
        format!("{text}\n\n@deprecated")
    }
}

/// Returns the fields of `object`, sorted by wire name.
pub(super) fn fields(object: Object<'_>) -> Vec<Field<'_>> {
    let mut fields: Vec<Field<'_>> = object.fields().collect();
    fields.sort_by_key(|field| field.wire_name());
    fields
}

/// Returns the type of the values of a map, which is unknown when the map
/// does not say.
pub(super) fn elem(object: Object<'_>) -> Type<'_> {
    object.extra().unwrap_or(Type::Scalar(Scalar::Unknown.into()))
}

/// Reports whether `t` is an object type with a property the SDK keeps. An
/// object without one is a map.
pub(super) fn has_fields(t: Type<'_>) -> bool {
    matches!(t, Type::Object(object) if object.fields().any(kept))
}

/// Reports whether the SDK keeps a property: its name is valid
/// (specs/02-naming.md). An object that leaves out a property allows other
/// keys.
pub(super) fn kept(field: Field<'_>) -> bool {
    valid_name(field.wire_name())
}

/// Reports whether `t` is an object type with fields, a model of one, or a
/// composition of them. `seen` has the models already followed.
pub(super) fn object_like<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
    match t {
        Type::Object(_) => has_fields(t),
        Type::Model(m) => seen.insert(m) && object_like(m.ty(), seen),
        Type::Union(union) => union.members().all(|m| object_like(m, seen)),
        Type::Intersection(intersection) => intersection.members().all(|m| object_like(m, seen)),
        _ => false,
    }
}

/// Reports whether an empty object is a value of `t`.
pub(super) fn all_optional(t: Type<'_>) -> bool {
    fn walk<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
        match t {
            Type::Object(object) => !object.fields().any(|f| kept(f) && f.is_required()),
            Type::Scalar(scalar) if scalar.kind() == Scalar::Unknown => true,
            Type::Model(m) => seen.insert(m) && walk(m.ty(), seen),
            Type::Intersection(intersection) => intersection.members().all(|m| walk(m, seen)),
            Type::Union(union) => union.members().any(|m| walk(m, seen)),
            _ => false,
        }
    }
    walk(t, &mut HashSet::new())
}

/// Prefixes `s` with `_` if it starts with a digit, so it's a valid
/// identifier.
pub(super) fn identifier(s: String) -> String {
    if s.starts_with(|c: char| c.is_ascii_digit()) {
        format!("_{s}")
    } else {
        s
    }
}

/// Reports whether `s` is made only of letters, digits, `-` and `_`, and
/// has at least one letter or digit.
pub(super) fn valid_name(s: &str) -> bool {
    let mut alnum = false;
    for c in s.chars() {
        if c.is_alphabetic() || c.is_numeric() {
            alnum = true;
        } else if c != '-' && c != '_' {
            return false;
        }
    }
    alnum
}

/// Reports whether `s` is a JavaScript identifier made of ASCII letters,
/// digits, `_` and `$`.
pub(super) fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Returns a property name, quoted when it is not an identifier.
pub(super) fn key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js_string(name)
    }
}

/// Returns `s` as a string literal, escaped as Go's `encoding/json` does
/// without HTML escaping.
pub(super) fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Returns an enum value as a literal type.
fn literal(value: EnumValue<'_>) -> String {
    match value {
        EnumValue::String(s) => js_string(s),
        EnumValue::Number(n) => n.to_string(),
        EnumValue::Boolean(b) => b.to_string(),
    }
}
