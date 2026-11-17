//! The `forge` command, which generates an SDK from an OpenAPI document.
//!
//! ```text
//! forge generate openapi.json --target ts --out sdk
//! forge generate openapi.json --target capnweb --out server
//! forge generate openapi.json --target mcp --out tools
//! forge generate openapi.json --target wasm://plugin.wasm --out sdk
//! forge normalize specs/*.json
//! ```

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use forge::{Err, Forge, Plugin};
use strum::{EnumString, VariantNames};

mod capnweb;
mod mcp;
mod normalize;
mod ts;

/// Generates an SDK from an OpenAPI document.
#[derive(Parser)]
#[command(version, subcommand_required = true, arg_required_else_help = true)]
struct Args {
    #[command(subcommand)]
    command: Command,
}

/// What `forge` does.
#[derive(clap::Subcommand)]
enum Command {
    /// Generate an SDK from an OpenAPI document.
    Generate(GenerateArgs),
    /// Rewrite other tools' extensions into the native x-forge-* ones.
    ///
    /// One document is printed to standard output, and nothing is changed,
    /// unless --write is given, which rewrites the files in place. A document
    /// that has none is left as it is. A native key is never replaced: when a
    /// document says the same thing twice, the native key is kept.
    Normalize(normalize::Args),
}

/// What `forge generate` is given.
#[derive(clap::Args)]
struct GenerateArgs {
    /// The OpenAPI JSON document, or - to read it from standard input.
    #[arg(required = true)]
    spec: PathBuf,
    /// The language of the SDK: `ts` for TypeScript, `capnweb` for a Cap'n
    /// Web server of the TypeScript SDK, which it imports from `#sdk`, `mcp`
    /// for the tools of an MCP server in TypeScript, or `wasm://PATH` for the
    /// plugin compiled to a WebAssembly component at PATH.
    #[arg(long, value_parser = Target::parse, required = true)]
    target: Target,
    /// The directory to write the SDK to.
    #[arg(long, required = true)]
    out: PathBuf,
}

/// What forge generates an SDK with.
#[derive(Clone, EnumString, VariantNames)]
#[strum(serialize_all = "lowercase")]
enum Target {
    /// The TypeScript generator.
    Ts,
    /// The Cap'n Web server generator.
    Capnweb,
    /// The MCP generator, which generates the tools of an MCP server in TypeScript.
    Mcp,
    /// A plugin compiled to a WebAssembly component, at the path.
    #[cfg(feature = "wasm")]
    #[strum(disabled)]
    Wasm(PathBuf),
}

const WASM_PREFIX: &str = "wasm://";

impl Target {
    fn parse(s: &str) -> Result<Target, String> {
        if let Ok(target) = s.parse::<Target>() {
            return Ok(target);
        }
        let Some(path) = s.strip_prefix(WASM_PREFIX) else {
            return Err(format!(
                "unrecognized target {s}, possible values: {}, or {WASM_PREFIX}PATH",
                Target::VARIANTS.join(", "),
            ));
        };
        if path.is_empty() {
            return Err(format!(
                "{WASM_PREFIX} needs the path of a plugin, as in {WASM_PREFIX}plugin.wasm"
            ));
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
    match args.command {
        Command::Generate(args) => generate(&args.spec, args.target, &args.out),
        Command::Normalize(args) => normalize::run(args),
    }
}

/// Generates the SDK for the document at `spec`, and writes it to `out`.
fn generate(spec: &Path, target: Target, out: &Path) -> Result<(), Err> {
    match target {
        Target::Ts => run_plugin(&ts::Generator, spec, out),
        Target::Capnweb => run_plugin(&capnweb::Generator, spec, out),
        Target::Mcp => run_plugin(&mcp::Generator, spec, out),
        #[cfg(feature = "wasm")]
        Target::Wasm(path) => {
            // Compiling the plugin and reading the document are both slow,
            // so they run at the same time.
            let (plugin, forge) = rayon::join(|| forge::wasm::WasmPlugin::from_file(&path), || read(spec));
            let (plugin, forge) = (plugin?, forge?);
            forge::write(out, plugin.generate(&forge)?)
        }
    }
}

fn run_plugin(plugin: &impl Plugin, spec: &Path, out: &Path) -> Result<(), Err> {
    forge::write(out, plugin.generate(&read(spec)?)?)
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
    fn subcommands_are_parsed() {
        let parse = |args: &[&str]| Args::try_parse_from(std::iter::once("forge").chain(args.iter().copied()));

        let normalize = parse(&["normalize", "--check", "a.json"]).unwrap();
        assert!(matches!(normalize.command, Command::Normalize(_)));

        let generate = parse(&["generate", "./a.json", "--target", "ts", "--out", "sdk"]).unwrap();
        let Command::Generate(g) = generate.command else {
            panic!("expected Generate");
        };
        assert_eq!(g.spec.as_path(), Path::new("./a.json"));

        // Each subcommand still requires its own arguments.
        assert!(parse(&["normalize"]).is_err());
        assert!(parse(&["generate"]).is_err());
        assert!(parse(&["generate", "a.json"]).is_err());
        assert!(parse(&["generate", "a.json", "--target", "ts"]).is_err());
        // The old root form is gone: a bare spec + flags is an error.
        assert!(parse(&["a.json", "--target", "ts", "--out", "sdk"]).is_err());
        // With nothing at all, clap prints help.
        assert!(parse(&[]).is_err());
    }
}
