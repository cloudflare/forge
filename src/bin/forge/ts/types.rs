//! TypeScript types, following specs/03-schema-types.md.

use std::cell::Cell;
use std::collections::HashSet;

use forge::ts::{Fragment, Ident, frag, join};
use forge::{Discriminator, EnumValue, Field, Model, Number, Object, Scalar, Type};

use super::Transport;

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
        Type::Scalar(scalar) => frag!(scalar_type(scalar)),
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
        Scalar::String | Scalar::Uuid => "string",
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
        key(&field_name(field)),
        if field.is_required() { ": " } else { "?: " },
        typ(field.ty(), Prec::Top)
    )
}

/// Returns the documentation of a declaration, with `@deprecated` after it
/// when it is deprecated.
pub(crate) fn doc(text: &str, deprecated: bool) -> String {
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
    object.extra().unwrap_or(Type::Scalar(Scalar::Unknown))
}

/// Reports whether `t` is an object type with a property the SDK keeps. An
/// object without one is a map.
pub(super) fn has_fields(t: Type<'_>) -> bool {
    matches!(t, Type::Object(object) if object.fields().any(kept))
}

thread_local! {
    /// Whether the clients being printed on this thread are those of a
    /// provider, which keep every property that has a name, under its wire
    /// name. See [`with_transport`].
    static PROVIDER: Cell<bool> = const { Cell::new(false) };
}

/// Runs `print`, which prints the files of clients on `transport`, with the
/// rules of that transport for which properties are [`kept`] and what a
/// field is named ([`field_name`]).
///
/// The rules are not parameters because almost every function of the
/// printers would take it. Every file is printed on the thread that calls
/// this, so they are kept for that thread while `print` runs.
pub(super) fn with_transport<T>(transport: Transport, print: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            PROVIDER.set(self.0);
        }
    }
    let _restore = Restore(PROVIDER.replace(transport == Transport::Provider));
    print()
}

/// Reports whether the clients keep a property, or a query parameter. An
/// object that leaves out a property allows other keys.
///
/// The SDK keeps one whose wire name is valid (specs/02-naming.md), and
/// leaves out one such as `name.eq` or `@type`. The clients of a provider
/// keep every one that has a name, since a gatekeeper covers few operations
/// and is written against all of what they take and return.
pub(super) fn kept(field: Field<'_>) -> bool {
    valid_name(field.wire_name()) || PROVIDER.get() && !field.name().is_empty()
}

/// Returns the name of the field of the property that discriminates a
/// union, as [`field_name`] names a field.
pub(super) fn discriminator_name(d: Discriminator<'_>) -> String {
    if PROVIDER.get() {
        d.wire_name().to_owned()
    } else {
        d.name().camel()
    }
}

/// Returns the name of the field of a property, or of a parameter, in the
/// types of the clients.
///
/// The SDK names it in camel case, and its codecs rename it
/// (specs/09-case-conversion.md). The clients of a provider keep its wire
/// name: a gatekeeper is written against the documentation of the provider
/// and reads the same objects from its webhooks, and a property that the
/// document does not declare cannot be renamed, so a value would have some
/// names of each kind.
pub(super) fn field_name(field: Field<'_>) -> String {
    if PROVIDER.get() {
        field.wire_name().to_owned()
    } else {
        field.name().camel()
    }
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
            Type::Scalar(Scalar::Unknown) => true,
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
pub(crate) fn identifier(s: String) -> String {
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
pub(crate) fn key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js_string(name)
    }
}

/// Returns `s` as a string literal: quotes, backslashes, control characters,
/// U+2028 and U+2029 are escaped, and nothing else is.
pub(crate) fn js_string(s: &str) -> String {
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
