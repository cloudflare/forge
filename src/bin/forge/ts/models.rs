//! The models.ts of a group, following specs/04-model-declarations.md.

use std::collections::HashMap;

use forge::ts::{File, Ident, Module, p};
use forge::{Group, Model, Object, Type};

use super::codec::{declares_codec, model_codec};
use super::types::{Prec, doc, fields, has_fields, kept, member, typ};
use super::{path, sorted_models};

/// Returns the models.ts of `group`: each model, then the codecs of the
/// models. It reports a model whose name has no letters or digits, and two
/// models with the same name (specs/02-naming.md).
pub(super) fn models(group: Group<'_>) -> Result<File, Vec<String>> {
    let models = sorted_models(group);
    // TODO: Move both checks into the library, next to the method checks in
    // src/link.rs. It accepts a model whose name has no letters or digits,
    // and two models in a group with equal names, such as schemas `Pet` and
    // `pet`. Then this function, `group_files` and `generate` can't fail.
    let mut errs = Vec::new();
    let mut names: HashMap<String, Model<'_>> = HashMap::new();
    for &m in &models {
        let name = Ident::model(m).name.into_owned();
        if m.name().is_empty() {
            errs.push(format!(
                "schema {:?}: the name has no letters or digits",
                m.schema_name()
            ));
        } else if let Some(other) = names.get(&name) {
            errs.push(format!(
                "group {:?}: schemas {:?} and {:?} have the same name {name:?}",
                path(group),
                other.schema_name(),
                m.schema_name(),
            ));
        }
        names.insert(name, m);
    }
    if !errs.is_empty() {
        return Err(errs);
    }

    let mut f = File::new(Module::group(group).sub("models.ts"));
    for (i, &m) in models.iter().enumerate() {
        if i > 0 {
            p!(f);
        }
        model(&mut f, m);
    }
    for &m in &models {
        if declares_codec(m) {
            p!(f);
            model_codec(&mut f, m);
        }
    }
    Ok(f)
}

/// Declares `m`: an interface for an object with fields, and a type alias
/// for everything else.
fn model(f: &mut File, m: Model<'_>) {
    f.doc(&doc(m.description(), m.is_deprecated()));
    let ty = m.ty();
    match ty {
        Type::Object(object) if has_fields(ty) => {
            p!(f, "export interface ", m, " {");
            print_fields(f, object);
            p!(f, "}");
        }
        _ => p!(f, "export type ", m, " = ", typ(ty, Prec::Top), ";"),
    }
}

/// Prints the fields of `object`, each on a line of its own after its
/// documentation, and an index signature when it allows other keys.
pub(super) fn print_fields(f: &mut File, object: Object<'_>) {
    let mut open = object.extra().is_some();
    f.indent(|f| {
        for field in fields(object) {
            if !kept(field) {
                open = true;
                continue;
            }
            f.doc(&doc(field.description(), field.is_deprecated()));
            p!(f, member(field), ";");
        }
        if open {
            p!(f, "[key: string]: unknown;");
        }
    });
}
