//! Codecs, following specs/09-case-conversion.md.
//!
//! A type needs a codec when a value of it has a key to rename, or a date,
//! bytes or int64 value to convert, at any depth. A model's codec is
//! declared after the models of its file, unless it is a single other
//! codec, such as that of a date or of another model. Its uses then refer to
//! that codec instead, so that no codec is another codec declared later in
//! the file.

use std::collections::HashSet;

use forge::ts::{File, Fragment, Ident, frag, join, p};
use forge::{Discriminator, Field, Model, Number, Scalar, Type};

use super::types::{elem, fields, has_fields, js_string, kept, key};
use super::{RUNTIME_INDEX, runtime};

/// Reports whether model `m` declares a codec: it needs one, and its codec
/// is not a single other codec.
pub(super) fn declares_codec(m: Model<'_>) -> bool {
    needs_codec(m.ty(), &mut HashSet::new()) && codec_of(m) == own_codec(m)
}

/// Declares the codec of model `m`, which declares one: an object codec
/// with an entry on each line, or any other codec on one line.
pub(super) fn model_codec(f: &mut File, m: Model<'_>) {
    let ty = m.ty();
    let object = match ty {
        Type::Object(object) if has_fields(ty) => object,
        _ => {
            p!(f, "export const ", own_codec(m), " = ", codec(ty, false), ";");
            return;
        }
    };
    p!(f, "export const ", own_codec(m), " = ", runtime("object"), "([");
    f.indent(|f| {
        for field in fields(object) {
            let entry = entry(field);
            if !entry.is_empty() {
                p!(f, entry, ",");
            }
        }
    });
    p!(f, "]);");
}

/// Returns the codec of `t`, or an empty fragment when `t` needs none.
///
/// A model's codec is referred to through a function, `() => codec`, so
/// that codecs can refer to each other in any order. When `direct`, the
/// codec itself refers to the model's codec directly, as an operation does,
/// since it is built after the models it uses.
pub(super) fn codec(t: Type<'_>, direct: bool) -> Fragment {
    match t {
        Type::Scalar(scalar) => match scalar_codec(scalar.kind()) {
            Some(id) => frag!(id),
            None => frag!(),
        },
        Type::Model(m) if needs_codec(t, &mut HashSet::new()) => codec_ref(m, direct),
        Type::Array(array) => match codec(array.elem(), false) {
            elem if elem.is_empty() => elem,
            elem => frag!(runtime("array"), "(", elem, ")"),
        },
        Type::Object(object) if !has_fields(t) => match codec(elem(object), false) {
            elem if elem.is_empty() => elem,
            elem => frag!(runtime("map"), "(", elem, ")"),
        },
        Type::Object(object) => {
            let entries = join(", ", fields(object).into_iter().map(entry));
            if entries.is_empty() {
                entries
            } else {
                frag!(runtime("object"), "([", entries, "])")
            }
        }
        Type::Union(union) => match discriminated(t) {
            Some(d) => discriminator(d),
            None => members_codec(union.members(), "union", direct),
        },
        Type::Intersection(intersection) => members_codec(intersection.members(), "intersection", direct),
        Type::Model(_) | Type::Enum(_) => frag!(),
    }
}

/// Returns the codec of a union or intersection of `members`, which runtime
/// function `function` combines: the codec of the one member that needs
/// one, or of all of them that do.
pub(super) fn members_codec<'f>(
    members: impl IntoIterator<Item = Type<'f>>,
    function: &'static str,
    direct: bool,
) -> Fragment {
    let members: Vec<Type<'f>> = members
        .into_iter()
        .filter(|&m| needs_codec(m, &mut HashSet::new()))
        .collect();
    match members[..] {
        [] => frag!(),
        [only] => codec(only, direct),
        _ => {
            let codecs = join(", ", members.into_iter().map(|m| codec(m, false)));
            frag!(runtime(function), "([", codecs, "])")
        }
    }
}

/// Returns the codec of a scalar the runtime converts, or `None`.
fn scalar_codec(scalar: Scalar) -> Option<Ident> {
    let name = match scalar {
        Scalar::DateTime => "instant",
        Scalar::Date => "date",
        Scalar::Bytes => "bytes",
        Scalar::Number(Number::Int64) => "int64",
        // A JSON string with format `binary` is kept as the string it is
        // on the wire; see `scalar_type`.
        Scalar::Binary => return None,
        _ => return None,
    };
    Some(runtime(name))
}

/// Returns the entry of a property in an object codec: its wire name, then
/// its field name when it is renamed, then the codec of its value when it is
/// converted. It returns an empty fragment when neither is needed.
fn entry(field: Field<'_>) -> Fragment {
    let name = field.name().camel();
    let renamed = name != field.wire_name();
    let codec = codec(field.ty(), false);
    if !kept(field) || !renamed && codec.is_empty() {
        return frag!();
    }
    frag!(
        "[",
        join!(
            ", ",
            js_string(field.wire_name()),
            if renamed { js_string(&name) } else { "null".into() },
            codec
        ),
        "]"
    )
}

/// Returns the codec of a union that a property discriminates: the codec of
/// each case that needs one, by the value of the property.
fn discriminator(d: Discriminator<'_>) -> Fragment {
    let name = d.name().camel();
    let mut cases: Vec<(&str, Model<'_>)> = d
        .cases()
        .filter_map(|(value, ty)| match ty {
            Type::Model(m) if needs_codec(ty, &mut HashSet::new()) => Some((value, m)),
            _ => None,
        })
        .collect();
    cases.sort_by_key(|&(value, _)| value);
    let cases = join(
        ", ",
        cases
            .into_iter()
            .map(|(value, m)| frag!(key(value), ": ", codec_ref(m, false))),
    );
    frag!(
        runtime("discriminated"),
        "(",
        js_string(d.wire_name()),
        ", ",
        if name == d.wire_name() {
            "null".into()
        } else {
            js_string(&name)
        },
        ", { ",
        cases,
        " })",
    )
}

/// Returns the discriminator of `t` when its codec converts by it: every
/// member is a model, and a case needs a codec.
fn discriminated(t: Type<'_>) -> Option<Discriminator<'_>> {
    let Type::Union(union) = t else { return None };
    let d = union.discriminator()?;
    let models = union.members().all(|m| matches!(m, Type::Model(_)));
    let converts = d.cases().any(|(_, ty)| needs_codec(ty, &mut HashSet::new()));
    (models && converts).then_some(d)
}

/// Reports whether `t` needs a codec. `seen` has the models already looked
/// at, whose codecs are needed only for what else is reached.
pub(super) fn needs_codec<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
    match t {
        Type::Scalar(scalar) => scalar_codec(scalar.kind()).is_some(),
        Type::Model(m) => seen.insert(m) && needs_codec(m.ty(), seen),
        Type::Array(array) => needs_codec(array.elem(), seen),
        Type::Object(object) => {
            let converts = |field: Field<'f>, seen: &mut HashSet<Model<'f>>| {
                kept(field) && (field.name().camel() != field.wire_name() || needs_codec(field.ty(), seen))
            };
            for field in object.fields() {
                if converts(field, seen) {
                    return true;
                }
            }
            !has_fields(t) && needs_codec(elem(object), seen)
        }
        Type::Union(union) => union.members().any(|m| needs_codec(m, seen)),
        Type::Intersection(intersection) => intersection.members().any(|m| needs_codec(m, seen)),
        Type::Enum(_) => false,
    }
}

/// Refers to the codec of model `m`, which needs one: a codec of the
/// runtime library directly, and a model's through a function unless
/// `direct`.
fn codec_ref(m: Model<'_>, direct: bool) -> Fragment {
    let id = codec_of(m);
    if direct || id.module == RUNTIME_INDEX {
        frag!(id)
    } else {
        frag!("() => ", id)
    }
}

/// Returns the codec model `m` declares, named after it.
fn own_codec(m: Model<'_>) -> Ident {
    let id = Ident::model(m);
    id.module.ident(format!("{}Codec", id.name))
}

/// Returns the codec that stands for model `m`, which needs one: the single
/// codec its type is, or else its own.
fn codec_of(m: Model<'_>) -> Ident {
    target_codec(m, &mut HashSet::new())
}

fn target_codec<'f>(m: Model<'f>, visiting: &mut HashSet<Model<'f>>) -> Ident {
    if visiting.insert(m)
        && let Some(id) = single_codec(m.ty(), visiting)
    {
        return id;
    }
    own_codec(m)
}

/// Returns the codec of `t` when it is a single codec: that of a date,
/// bytes or int64 value, or of a model, or of the one member of a union or
/// intersection that needs a codec.
fn single_codec<'f>(t: Type<'f>, visiting: &mut HashSet<Model<'f>>) -> Option<Ident> {
    let members: Vec<Type<'f>> = match t {
        Type::Scalar(scalar) => return scalar_codec(scalar.kind()),
        Type::Model(m) => {
            return needs_codec(t, &mut HashSet::new()).then(|| target_codec(m, visiting));
        }
        Type::Union(_) if discriminated(t).is_some() => return None,
        Type::Union(union) => union.members().collect(),
        Type::Intersection(intersection) => intersection.members().collect(),
        _ => return None,
    };
    let mut converted = members.into_iter().filter(|&m| needs_codec(m, &mut HashSet::new()));
    let only = converted.next()?;
    if converted.next().is_some() {
        return None;
    }
    single_codec(only, visiting)
}
