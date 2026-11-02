//! The `forge` command, which generates an SDK from an OpenAPI document.
//!
//! ```text
//! forge openapi.json --target ts --out sdk
//! forge openapi.json --target wasm://plugin.wasm --out sdk
//! forge normalize specs/*.json
//! ```

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use forge::{Err, Forge};

mod normalize;
mod ts;

/// Generates an SDK from an OpenAPI document.
#[derive(Parser)]
#[command(version, args_conflicts_with_subcommands = true)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    /// The OpenAPI JSON document, or - to read it from standard input.
    #[arg(required = true)]
    spec: Option<PathBuf>,
    /// The language of the SDK: `ts` for TypeScript, or `wasm://PATH` for
    /// the plugin compiled to a WebAssembly component at PATH.
    #[arg(long, value_parser = Target::parse, required = true)]
    target: Option<Target>,
    /// The directory to write the SDK to.
    #[arg(long, required = true)]
    out: Option<PathBuf>,
}

/// What `forge` does other than generate an SDK.
#[derive(clap::Subcommand)]
enum Command {
    /// Rewrite other tools' extensions into the native x-forge-* ones.
    ///
    /// One document is printed to standard output, and nothing is changed,
    /// unless --write is given, which rewrites the files in place. A document
    /// that has none is left as it is. A native key is never replaced: when a
    /// document says the same thing twice, the native key is kept.
    Normalize(normalize::Args),
}

/// What forge generates an SDK with.
#[derive(Clone)]
enum Target {
    /// The TypeScript generator.
    Ts,
    /// A plugin compiled to a WebAssembly component, at the path.
    #[cfg(feature = "wasm")]
    Wasm(PathBuf),
}

impl Target {
    fn parse(s: &str) -> Result<Target, String> {
        if s == "ts" {
            return Ok(Target::Ts);
        }
        let Some(path) = s.strip_prefix("wasm://") else {
            return Err("possible values: ts, wasm://PATH".to_owned());
        };
        if path.is_empty() {
            return Err("wasm:// needs the path of a plugin, as in wasm://plugin.wasm".to_owned());
        }
        #[cfg(feature = "wasm")]
        return Ok(Target::Wasm(PathBuf::from(path)));
        #[cfg(not(feature = "wasm"))]
        Err("this forge was built without wasm plugins; build it with `--features wasm`".to_owned())
    }
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("forge: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Does what `args` ask for.
fn run(args: Args) -> Result<(), Err> {
    if let Some(Command::Normalize(args)) = args.command {
        return normalize::run(args);
    }
    // They are required, which a command is the only way around.
    let (Some(spec), Some(target), Some(out)) = (args.spec, args.target, args.out) else {
        unreachable!("clap asks for a spec, a target and an out when there is no command");
    };
    generate(&spec, target, &out)
}

/// Generates the SDK for the document at `spec`, and writes it to `out`.
fn generate(spec: &Path, target: Target, out: &Path) -> Result<(), Err> {
    match target {
        Target::Ts => {
            let forge = read(spec)?;
            forge::write(out, forge::run(&forge, &ts::Generator)?)
        }
        #[cfg(feature = "wasm")]
        Target::Wasm(path) => {
            // Compiling the plugin and reading the document are both slow,
            // so they run at the same time.
            let (plugin, forge) = rayon::join(|| forge::wasm::WasmPlugin::from_file(&path), || read(spec));
            let (plugin, forge) = (plugin?, forge?);
            forge::write(out, forge::run(&forge, &plugin)?)
        }
    }
}

/// Reads the document at `path`, or from standard input when `path` is `-`.
fn read(path: &Path) -> Result<Forge, Err> {
    let parse = || -> Result<Forge, Err> {
        let json = if path == Path::new("-") {
            let mut json = Vec::new();
            io::stdin().read_to_end(&mut json)?;
            json
        } else {
            fs::read(path)?
        };
        Ok(serde_json::from_slice(&json)?)
    };
    parse().map_err(|err| format!("{}: {err}", path.display()).into())
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;
    use clap::Parser;
    use std::path::Path;

    use super::Args;
    use super::Command;

    #[test]
    fn args() {
        Args::command().debug_assert();
    }

    #[test]
    fn a_command_and_a_document_are_told_apart() {
        let parse = |args: &[&str]| Args::try_parse_from(std::iter::once("forge").chain(args.iter().copied()));

        let command = parse(&["normalize", "--check", "a.json"]).unwrap();
        assert!(matches!(command.command, Some(Command::Normalize(_))) && command.spec.is_none());

        let document = parse(&["./normalize", "--target", "ts", "--out", "sdk"]).unwrap();
        assert!(document.command.is_none() && document.spec.as_deref() == Some(Path::new("./normalize")));

        // What a command or a document needs is not waived for the other.
        assert!(parse(&["normalize"]).is_err());
        assert!(parse(&["a.json"]).is_err());
        assert!(parse(&["normalize", "--target", "ts", "a.json"]).is_err());
        assert!(parse(&["--target", "ts", "normalize", "a.json"]).is_err());
        assert!(parse(&[]).is_err());
    }
}
