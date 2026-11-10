//! The index.ts of a group, its public surface (specs/01-output-layout.md).

use std::collections::HashSet;

use forge::Group;
use forge::ts::{File, Ident, Module, p};

use super::client::{request_name, response_name, skipped};
use super::sorted_models;

/// Returns the index.ts of `group`: ApiError and RequestOptions from the
/// runtime library, so that every entry point is complete, then
/// createClient and the types of its client, then its models. A model named
/// like another export is exported with a `$` added.
pub(super) fn index(group: Group<'_>) -> File {
    let mut f = File::new(Module::group(group).sub("index.ts"));
    let depth = group.path().len();
    let mut runtime = format!("{}_/index.js", "../".repeat(depth));
    if depth == 0 {
        runtime.insert_str(0, "./");
    }
    export(&mut f, "export", &["ApiError".to_owned()], &runtime);
    export(&mut f, "export type", &["RequestOptions".to_owned()], &runtime);

    export(&mut f, "export", &["createClient".to_owned()], "./client.js");
    let mut names = vec!["Client".to_owned(), "ClientOptions".to_owned()];
    for m in group.methods() {
        if !skipped(m) {
            names.push(request_name(m));
            names.push(response_name(m));
        }
    }
    export(&mut f, "export type", &names, "./client.js");

    let mut taken: HashSet<String> = ["ApiError", "RequestOptions"].map(String::from).into();
    taken.extend(names);
    let mut models = Vec::new();
    for m in sorted_models(group) {
        let name = Ident::model(m).name.into_owned();
        let mut alias = name.clone();
        while taken.contains(&alias) {
            alias.push('$');
        }
        taken.insert(alias.clone());
        models.push(if alias == name {
            name
        } else {
            format!("{name} as {alias}")
        });
    }
    export(&mut f, "export type", &models, "./models.js");
    f
}

/// Prints an export of `names` from the module at `spec`, with each name on
/// a line of its own when there is more than one. It prints nothing when
/// there are no names.
fn export(f: &mut File, keyword: &str, names: &[String], spec: &str) {
    match names {
        [] => {}
        [name] => p!(f, keyword, " { ", name, r#" } from ""#, spec, r#"";"#),
        names => {
            p!(f, keyword, " {");
            f.indent(|f| {
                for name in names {
                    p!(f, name, ",");
                }
            });
            p!(f, r#"} from ""#, spec, r#"";"#);
        }
    }
}
