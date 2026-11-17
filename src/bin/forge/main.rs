//! The `forge` command, which generates an SDK from an OpenAPI document.
//!
//! ```text
//! forge generate openapi.json --target ts --out sdk
//! forge generate openapi.json --target capnweb --out server
//! forge generate openapi.json --target mcp --out tools
//! forge generate openapi.json --target wasm://plugin.wasm --out sdk
//! forge normalize specs/*.json
//! ```
//!
//! The root form, `forge openapi.json --target ts --out sdk`, is an alias
//! for `forge generate` kept for backward compatibility: it will be removed
//! in a breaking release. To preserve the alias in the corner case where the
//! spec is a file literally named `generate`, `forge generate --target …
//! --out …` with no positional spec falls back to the alias (see
//! [`parse_cli`]).

use std::ffi::OsString;
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
#[command(version, args_conflicts_with_subcommands = true, arg_required_else_help = true)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    /// The OpenAPI JSON document, or - to read it from standard input.
    ///
    /// Alias for `forge generate`, kept for backward compatibility.
    #[arg(required = true)]
    spec: Option<PathBuf>,
    /// The language of the SDK: `ts` for TypeScript, `capnweb` for a Cap'n
    /// Web server of the TypeScript SDK, which it imports from `#sdk`, `mcp`
    /// for the tools of an MCP server in TypeScript, or `wasm://PATH` for the
    /// plugin compiled to a WebAssembly component at PATH.
    #[arg(long, value_parser = Target::parse, required = true)]
    target: Option<Target>,
    /// The directory to write the SDK to.
    #[arg(long, required = true)]
    out: Option<PathBuf>,
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
    let args = match parse_cli(std::env::args_os()) {
        Ok(args) => args,
        Err(err) => err.exit(),
    };
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("forge: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Parses command-line arguments, with a backward-compatibility fallback:
/// `forge generate --target … --out …` with no positional spec previously
/// meant "generate an SDK for the file named `generate`" through the root
/// alias. Clap now matches `generate` as the subcommand name instead, so
/// that invocation fails with a missing `<SPEC>` error. When that happens,
/// we retry with `generate` moved to the end as the spec of the root alias,
/// which preserves the old behavior. `forge generate <spec> …` keeps its
/// new meaning, since the first parse succeeds.
fn parse_cli<I, T>(raw: I) -> Result<Args, clap::Error>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let raw: Vec<OsString> = raw.into_iter().map(Into::into).collect();
    let result = Args::try_parse_from(&raw);
    if let Err(err) = &result
        && raw.get(1).and_then(|a| a.to_str()) == Some("generate")
        && err.kind() == clap::error::ErrorKind::MissingRequiredArgument
    {
        let mut legacy = Vec::with_capacity(raw.len());
        legacy.push(raw[0].clone());
        legacy.extend(raw[2..].iter().cloned());
        legacy.push(OsString::from("generate"));
        if let Ok(args) = Args::try_parse_from(&legacy) {
            return Ok(args);
        }
    }
    result
}

/// Does what `args` ask for.
fn run(args: Args) -> Result<(), Err> {
    let (spec, target, out) = match args.command {
        Some(Command::Normalize(args)) => return normalize::run(args),
        Some(Command::Generate(args)) => (args.spec, args.target, args.out),
        None => {
            // They are required when there is no subcommand.
            let (Some(spec), Some(target), Some(out)) = (args.spec, args.target, args.out) else {
                unreachable!("clap asks for a spec, a target and an out when there is no command");
            };
            (spec, target, out)
        }
    };
    generate(&spec, target, &out)
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
    use super::parse_cli;

    #[test]
    fn args() {
        Args::command().debug_assert();
    }

    #[test]
    fn a_command_and_the_root_alias_are_told_apart() {
        let parse = |args: &[&str]| Args::try_parse_from(std::iter::once("forge").chain(args.iter().copied()));

        let normalize = parse(&["normalize", "--check", "a.json"]).unwrap();
        assert!(matches!(normalize.command, Some(Command::Normalize(_))) && normalize.spec.is_none());

        let generate = parse(&["generate", "./a.json", "--target", "ts", "--out", "sdk"]).unwrap();
        let Some(Command::Generate(g)) = generate.command else {
            panic!("expected Generate");
        };
        assert_eq!(g.spec.as_path(), Path::new("./a.json"));

        // The root alias still works: it's equivalent to `forge generate`.
        let alias = parse(&["./a.json", "--target", "ts", "--out", "sdk"]).unwrap();
        assert!(alias.command.is_none() && alias.spec.as_deref() == Some(Path::new("./a.json")));

        // What a command or the alias needs is not waived for the other.
        assert!(parse(&["normalize"]).is_err());
        assert!(parse(&["generate"]).is_err());
        assert!(parse(&["a.json"]).is_err());
        assert!(parse(&["generate", "a.json"]).is_err());
        assert!(parse(&["normalize", "--target", "ts", "a.json"]).is_err());
        assert!(parse(&["--target", "ts", "normalize", "a.json"]).is_err());
        // With nothing at all, clap prints help.
        assert!(parse(&[]).is_err());
    }

    #[test]
    fn generate_with_a_spec_runs_the_subcommand_and_without_a_spec_falls_back_to_the_alias() {
        let parse = |args: &[&str]| parse_cli(std::iter::once("forge").chain(args.iter().copied()));

        // A spec after `generate` is the subcommand form.
        let subcommand = parse(&["generate", "openapi.json", "--target", "ts", "--out", "sdk"]).unwrap();
        let Some(Command::Generate(g)) = subcommand.command else {
            panic!("expected Generate subcommand, got {:?}", subcommand.command.is_some());
        };
        assert_eq!(g.spec.as_path(), Path::new("openapi.json"));

        // No positional spec after `generate` means the legacy alias: the
        // spec is the file literally named `generate`.
        let alias = parse(&["generate", "--target", "ts", "--out", "sdk"]).unwrap();
        assert!(alias.command.is_none(), "expected the root alias, got a subcommand");
        assert_eq!(alias.spec.as_deref(), Some(Path::new("generate")));

        // `forge generate` alone is still an error: neither form has what it
        // needs.
        assert!(parse(&["generate"]).is_err());

        // `forge normalize` is unchanged.
        let normalize = parse(&["normalize", "--check", "a.json"]).unwrap();
        assert!(matches!(normalize.command, Some(Command::Normalize(_))));
    }
}
