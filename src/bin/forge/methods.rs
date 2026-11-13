//! `forge methods`, which prints the methods a document makes.

use std::io::{self, Write};
use std::path::PathBuf;

use forge::{Err, Forge, Method, Name};
use serde_json::{Value, json};

#[derive(clap::Args)]
pub struct Args {
    /// The OpenAPI JSON document, or - to read it from standard input.
    spec: PathBuf,
}

pub fn run(args: Args) -> Result<(), Err> {
    let forge = super::read(&args.spec)?;
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &methods(&forge))?;
    writeln!(out)?;
    Ok(())
}

/// Returns every method of `forge` as JSON, in the order of
/// [`Forge::groups`], and by name within a group.
fn methods(forge: &Forge) -> Value {
    forge.groups().flat_map(|group| group.methods()).map(method).collect()
}

fn method(method: Method<'_>) -> Value {
    json!({
        "group": method.group().path().map(Name::kebab).collect::<Vec<_>>(),
        "name": method.name().kebab(),
        "method": method.http_method().as_str(),
        "path": method.path(),
        "hidden": method.is_hidden(),
        "deprecated": method.is_deprecated(),
        "availability": method.availability().map(|availability| availability.as_str()),
    })
}
