//! The index.ts of a group, its public surface (specs/01-output-layout.md).

use std::collections::HashSet;

use forge::Group;
use forge::ts::{File, Ident, Module, p};

use super::client::{Role, request_name, response_name, skipped};
use super::{Transport, sorted_models};

/// Returns the index.ts of `group`: the errors and RequestOptions from the
/// runtime library, so that every entry point is complete, and the types of
/// a provider and of what a method returns when the transport is one, then
/// what creates each of its clients, unless a file of its own does, and
/// their types, then its models. A model named
/// like another export is exported with a `$` added.
pub(super) fn index(group: Group<'_>, transport: Transport, roles: &[Role]) -> File {
    let mut f = File::new(Module::group(group).sub("index.ts"));
    let depth = group.path().len();
    let mut runtime = format!("{}_/index.js", "../".repeat(depth));
    if depth == 0 {
        runtime.insert_str(0, "./");
    }
    let (errors, types): (&[&str], &[&str]) = match transport {
        Transport::Fetch => (&["ApiError"], &["RequestOptions"]),
        Transport::Provider => (
            &["ApiError", "DecodeError"],
            &[
                "Failure",
                "NotModified",
                "Provider",
                "ProviderRequest",
                "ProviderResponse",
                "RequestOptions",
                "Result",
            ],
        ),
    };
    let errors: Vec<String> = errors.iter().map(|&name| name.to_owned()).collect();
    export(&mut f, "export", &errors, &runtime);
    let types: Vec<String> = types.iter().map(|&name| name.to_owned()).collect();
    export(&mut f, "export type", &types, &runtime);

    let creates: Vec<String> = roles
        .iter()
        .filter(|role| role.entry.is_none())
        .map(|role| role.create.to_owned())
        .collect();
    export(&mut f, "export", &creates, "./client.js");
    let mut names: Vec<String> = roles.iter().map(|role| role.client.to_owned()).collect();
    names.push("ClientOptions".to_owned());
    for m in group.methods() {
        if !skipped(m) {
            names.push(request_name(m));
            names.push(response_name(m));
        }
    }
    export(&mut f, "export type", &names, "./client.js");

    let mut taken: HashSet<String> = errors.into_iter().collect();
    taken.extend(types);
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

/// Returns the file of `group` that exports what creates the client `role`,
/// and its type, or `None` when the group's index.ts does.
pub(super) fn entry(group: Group<'_>, role: &Role) -> Option<File> {
    let mut f = File::new(Module::group(group).sub(role.entry?));
    export(&mut f, "export", &[role.create.to_owned()], "./client.js");
    export(&mut f, "export type", &[role.client.to_owned()], "./client.js");
    Some(f)
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
