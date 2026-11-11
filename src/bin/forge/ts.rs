//! The TypeScript SDK generator, following the specs in specs/ts.
//!
//! Every group gets a client.ts, a models.ts and an index.ts in its
//! directory. The root also gets the runtime library, in `_/`.

use std::borrow::Cow;

use forge::ts::{self, Ident, Module, PREAMBLE};
use forge::{Err, Forge, Group, Model, Plugin};
use rayon::prelude::*;

pub(crate) mod client;
mod codec;
mod index;
mod models;
mod operation;
pub(crate) mod types;

/// Generates a TypeScript SDK.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the SDK, which sends requests with fetch.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        generate(forge, Transport::Fetch, &RUNTIME)
    }
}

/// What sends the requests of the clients, which decides what their
/// methods return and what their options are.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    /// The transport of the SDK, which sends requests with fetch. A method
    /// returns the body of its response.
    Fetch,
    /// A transport that sends requests through a provider, which has the
    /// URL of the API and its credentials. A method returns the body of its
    /// response with its status and headers.
    Provider,
}

/// Returns the files of the clients of `forge` on `transport`: the runtime
/// library, whose sources are `runtime` by path, then the files of each
/// group, which are generated in parallel.
pub(crate) fn generate(
    forge: &Forge,
    transport: Transport,
    runtime: &[(&str, &str)],
) -> Result<std::vec::IntoIter<File>, Err> {
    let mut files: Vec<File> = runtime
        .iter()
        .map(|&(path, source)| File::Runtime {
            path: RUNTIME_DIR.sub(path).as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        })
        .collect();
    let groups: Vec<Group<'_>> = forge.groups().collect();
    let per_group = groups
        .par_iter()
        .map(|&group| group_files(group, transport))
        .collect::<Result<Vec<_>, Err>>()?;
    files.extend(per_group.into_iter().flatten());
    Ok(files.into_iter())
}

/// Returns the client.ts, models.ts and index.ts of `group`. A group without
/// models has an empty models.ts, which isn't written.
fn group_files(group: Group<'_>, transport: Transport) -> Result<Vec<File>, Err> {
    let models = models::models(group).map_err(|errs| errs.join("\n"))?;
    Ok(vec![
        File::Ts(client::client(group, transport)),
        File::Ts(models),
        File::Ts(index::index(group, transport)),
    ])
}

/// A file of the SDK.
// TODO: Replace with `ts::File` once it can hold fixed content, such as a
// constructor that takes the text to write after the preamble.
pub enum File {
    /// A generated file.
    Ts(ts::File),
    /// A file with fixed content, such as one of the runtime library: its
    /// path, and its content after the preamble.
    Runtime { path: String, content: String },
}

impl forge::File for File {
    fn path(&self) -> &str {
        match self {
            File::Ts(f) => forge::File::path(f),
            File::Runtime { path, .. } => path,
        }
    }

    fn content(&self) -> Result<Cow<'_, [u8]>, Err> {
        match self {
            File::Ts(f) => forge::File::content(f),
            File::Runtime { content, .. } => Ok(Cow::Borrowed(content.as_bytes())),
        }
    }
}

/// Returns the names of the groups down to `group`, in camelCase and
/// separated by dots, for errors: empty for the root.
pub(crate) fn path(group: Group<'_>) -> String {
    group.path().map(|name| name.camel()).collect::<Vec<_>>().join(".")
}

/// Returns the models placed directly in `group`, sorted by schema name.
fn sorted_models(group: Group<'_>) -> Vec<Model<'_>> {
    let mut models: Vec<Model<'_>> = group.models().collect();
    models.sort_by_key(|m| m.schema_name());
    models
}

/// The directory of the runtime library.
const RUNTIME_DIR: Module = Module::new("_");

/// The module of the runtime library that exports it.
const RUNTIME_INDEX: Module = Module::new("_/index.ts");

/// Returns the identifier `name` that the runtime library exports.
fn runtime(name: &'static str) -> Ident {
    RUNTIME_INDEX.ident(name)
}

/// Returns the type of the options of a call.
fn request_options() -> Ident {
    runtime("RequestOptions").ty()
}

/// The sources of the runtime library, by path in lib/src
/// (specs/12-runtime-library.md).
const RUNTIME: [(&str, &str); 5] = [
    ("codec.ts", include_str!("ts/lib/src/codec.ts")),
    ("error.ts", include_str!("ts/lib/src/error.ts")),
    ("hooks/envelope.ts", include_str!("ts/lib/src/hooks/envelope.ts")),
    ("index.ts", include_str!("ts/lib/src/index.ts")),
    ("transport.ts", include_str!("ts/lib/src/transport.ts")),
];

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::RUNTIME;

    /// Every source of the runtime library is embedded.
    #[test]
    fn runtime_is_complete() {
        fn walk(dir: &Path, root: &Path, paths: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, paths);
                } else {
                    let rel = path.strip_prefix(root).unwrap();
                    let parts: Vec<_> = rel.iter().map(|part| part.to_str().unwrap()).collect();
                    paths.push(parts.join("/"));
                }
            }
        }
        let root: PathBuf = [env!("CARGO_MANIFEST_DIR"), "src/bin/forge/ts/lib/src"]
            .iter()
            .collect();
        let mut paths = Vec::new();
        walk(&root, &root, &mut paths);
        paths.sort();
        let embedded: Vec<&str> = RUNTIME.iter().map(|&(path, _)| path).collect();
        assert_eq!(paths, embedded);
    }
}
