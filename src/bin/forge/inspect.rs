//! `forge inspect`, which prints what forge reads in a document.

use std::io::{self, Write};
use std::path::PathBuf;

use forge::{Err, Forge, Method, Name};
use serde_json::{Value, json};

#[derive(clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: Command,
}

/// What `forge inspect` prints.
#[derive(clap::Subcommand)]
enum Command {
    /// Print the methods a document makes, as JSON.
    ///
    /// Each method has its group path and name, in kebab-case, as forge
    /// resolves them from x-forge-group-name, x-forge-method-name and the
    /// operationId, with its HTTP method and path. Other tools' extensions
    /// are not read: run `forge normalize` on the document first.
    Methods(Spec),
}

#[derive(clap::Args)]
struct Spec {
    /// The OpenAPI JSON document, or - to read it from standard input.
    spec: PathBuf,
}

pub fn run(args: Args) -> Result<(), Err> {
    match args.command {
        Command::Methods(Spec { spec }) => print(&methods(&super::read(&spec)?)),
    }
}

/// Prints `value` to standard output.
fn print(value: &Value) -> Result<(), Err> {
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, value)?;
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
