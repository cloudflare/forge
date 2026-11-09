//! The TypeScript SDK generator, following the specs in specs/ts.
//!
//! Every group gets a client.ts, a models.ts and an index.ts in its
//! directory. The root also gets the runtime library, in `_/`.

use std::borrow::Cow;

use forge::ts::{self, Ident, Module, PREAMBLE};
use forge::{Err, Forge, Group, Method, Model, Plugin};

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

    /// Returns the files of the root, and the runtime library.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let mut files = files(Node::Root(forge))?;
        files.extend(RUNTIME.iter().map(|&(path, source)| File::Runtime {
            path: RUNTIME_DIR.sub(path).as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        }));
        Ok(files.into_iter())
    }

    fn generate_group(&self, group: Group<'_>) -> Result<impl Iterator<Item = File>, Err> {
        Ok(files(Node::Group(group))?.into_iter())
    }
}

/// Returns the client.ts, models.ts and index.ts of `node`. A node without
/// models has an empty models.ts, which isn't written.
fn files(node: Node<'_>) -> Result<Vec<File>, Err> {
    let models = models::models(node).map_err(|errs| errs.join("\n"))?;
    Ok(vec![
        File::Ts(client::client(node)),
        File::Ts(models),
        File::Ts(index::index(node)),
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

/// The root, or a group: what has a client.ts, models.ts and index.ts.
// TODO: Remove once the library exposes the root as a `Group`, which
// `Plugin::generate` could pass in. Then every function here takes a
// `Group`.
#[derive(Clone, Copy)]
pub(crate) enum Node<'f> {
    Root(&'f Forge),
    Group(Group<'f>),
}

impl<'f> Node<'f> {
    /// Returns the directory of the node's files.
    pub(crate) fn dir(self) -> Module {
        match self {
            Node::Root(_) => Module::ROOT,
            Node::Group(group) => Module::group(group),
        }
    }

    /// Returns how many groups deep the node is: 0 for the root.
    fn depth(self) -> usize {
        match self {
            Node::Root(_) => 0,
            Node::Group(group) => group.path().len(),
        }
    }

    /// Returns the names of the groups down to the node, in camelCase and
    /// separated by dots, for errors.
    pub(crate) fn path(self) -> String {
        match self {
            Node::Root(_) => String::new(),
            Node::Group(group) => group.path().map(|name| name.camel()).collect::<Vec<_>>().join("."),
        }
    }

    /// Returns the methods directly in the node, sorted by name. The root
    /// has none.
    pub(crate) fn methods(self) -> Vec<Method<'f>> {
        match self {
            Node::Root(_) => Vec::new(),
            Node::Group(group) => group.methods().collect(),
        }
    }

    /// Returns the groups directly in the node, sorted by name.
    pub(crate) fn children(self) -> Vec<Group<'f>> {
        match self {
            Node::Root(forge) => forge.groups().filter(|g| g.parent().is_none()).collect(),
            Node::Group(group) => group.children().collect(),
        }
    }

    /// Returns the models placed directly in the node, sorted by schema
    /// name.
    fn models(self) -> Vec<Model<'f>> {
        let mut models: Vec<Model<'f>> = match self {
            Node::Root(forge) => forge.models().collect(),
            Node::Group(group) => group.models().collect(),
        };
        models.sort_by_key(|m| m.schema_name());
        models
    }
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
