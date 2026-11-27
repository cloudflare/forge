//! The `forge` command, which generates an SDK from a prepared, self-contained
//! OpenAPI document.
//!
//! OpenAPI-to-OpenAPI transforms (`forge normalize`, `forge openapi overlay`,
//! and future transforms such as bundling) are separate commands and functions
//! that compose upstream of `forge generate` and `forge inspect` (for example,
//! piped through `-`). Keeping preparation separate matches the pure,
//! filesystem-free boundary of the Rust crate (`Forge`) and the WebAssembly
//! library (`@cloudflare/forge`).
//!
//! ```text
//! forge generate openapi.json --target ts --out sdk
//! forge generate openapi.json --target capnweb --out server
//! forge generate openapi.json --target mcp --out tools
//! forge generate openapi.json --target wasm://plugin.wasm --out sdk
//! forge normalize specs/*.json
//! forge inspect methods openapi.json
//! forge openapi overlay <overlay>                      # print or write the merged spec
//! forge openapi overlay <spec> <overlay>...
//! ```

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use forge::{Err, Forge, Plugin};
use strum::{EnumString, VariantNames};

mod capnweb;
mod file;
mod inspect;
mod log;
mod mcp;
mod normalize;
mod openapi;
mod ts;

/// Generate an SDK, apply an overlay, or run a subcommand.
#[derive(Parser)]
#[command(name = "forge", version, subcommand_required = true)]
struct Args {
    /// Set the diagnostic log level on stderr: `error`, `warn`, `info`,
    /// `debug`, or `trace` (also configurable via `FORGE_LOG`).
    #[arg(long, value_name = "LEVEL", value_parser = log::Level::parse, global = true)]
    log_level: Option<log::Level>,
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
    /// Print what forge reads in a document, as JSON.
    Inspect(inspect::Args),
    /// OpenAPI-specific commands.
    Openapi(openapi::Args),
}

/// What `forge generate` is given.
#[derive(clap::Args)]
struct GenerateArgs {
    /// The OpenAPI JSON document, or `-` to read it from standard input.
    spec: PathBuf,
    /// The language of the SDK: `ts` for TypeScript, `capnweb` for a Cap'n
    /// Web server of the TypeScript SDK, which it imports from `#sdk`, `mcp`
    /// for the tools of an MCP server in TypeScript, or `wasm://PATH` for the
    /// plugin compiled to a WebAssembly component at PATH.
    #[arg(long, value_parser = Target::parse)]
    target: Target,
    /// The directory to write the SDK to.
    #[arg(long)]
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
    // `forge` on its own is the help command: print the top-level help to
    // stdout and exit 0 so it reads cleanly in a pager or pipeline. Every
    // other invalid invocation keeps clap's error-to-stderr, exit-2 shape.
    if std::env::args_os().len() <= 1 {
        let mut cmd = <Args as clap::CommandFactory>::command();
        cmd.print_help().expect("write top-level help to stdout");
        println!();
        return ExitCode::SUCCESS;
    }
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(err) => {
            let _ = err.print();
            if let Some(hint) = hint_old_root_form(err.kind(), std::env::args().nth(1).as_deref()) {
                eprintln!();
                eprintln!("{hint}");
            }
            std::process::exit(if err.use_stderr() { 2 } else { 0 });
        }
    };
    log::init(log::resolve(args.log_level));
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("forge: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Returns a hint pointing at `forge generate` when clap rejected the first
/// argument as an unknown subcommand and it looks like a spec (a path with
/// `/` or `.`, a `wasm://` URL, or `-` for stdin). Clap already prints its
/// own "did you mean" hint for near-miss typos, so the migration hint is
/// skipped for bare words, the only case where the near-miss hint helps.
fn hint_old_root_form(kind: clap::error::ErrorKind, first_arg: Option<&str>) -> Option<&'static str> {
    if kind != clap::error::ErrorKind::InvalidSubcommand {
        return None;
    }
    let arg = first_arg?;
    let looks_like_spec = arg == "-" || arg.contains('.') || arg.contains('/') || arg.starts_with("wasm://");
    looks_like_spec.then_some(
        "note: the root form `forge <SPEC> --target --out` has been removed; use\n      `forge generate <SPEC> --target --out` instead.",
    )
}

/// Does what `args` ask for.
fn run(args: Args) -> Result<(), Err> {
    match args.command {
        Command::Generate(args) => generate(args),
        Command::Normalize(args) => normalize::run(args),
        Command::Inspect(args) => inspect::run(args),
        Command::Openapi(args) => openapi::run(args),
    }
}

/// Generates the SDK for the document at `args.spec`, and writes it to `args.out`.
fn generate(args: GenerateArgs) -> Result<(), Err> {
    let spec = args.spec.as_path();
    let out = args.out.as_path();
    match args.target {
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
    use super::hint_old_root_form;

    #[test]
    fn args() {
        Args::command().debug_assert();
    }

    #[test]
    fn the_migration_hint_fires_only_when_the_first_arg_looks_like_a_spec() {
        use clap::error::ErrorKind;

        // Spec-looking inputs get the hint.
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("openapi.json")).is_some());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("./a.json")).is_some());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("path/to/spec")).is_some());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("-")).is_some());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("wasm://plugin.wasm")).is_some());

        // A near-miss typo of a real subcommand doesn't look like a spec,
        // so clap's own "did you mean" hint is the only one shown.
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("generat")).is_none());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("normaliz")).is_none());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, Some("inspec")).is_none());

        // Other error kinds never trigger the hint.
        assert!(hint_old_root_form(ErrorKind::MissingRequiredArgument, Some("openapi.json")).is_none());
        assert!(hint_old_root_form(ErrorKind::InvalidSubcommand, None).is_none());
    }

    #[test]
    fn subcommands_are_parsed() {
        let parse = |args: &[&str]| Args::try_parse_from(std::iter::once("forge").chain(args.iter().copied()));

        let normalize = parse(&["normalize", "--check", "a.json"]).unwrap();
        assert!(matches!(normalize.command, Command::Normalize(_)));

        let inspect = parse(&["inspect", "methods", "a.json"]).unwrap();
        assert!(matches!(inspect.command, Command::Inspect(_)));

        let generate = parse(&["generate", "./a.json", "--target", "ts", "--out", "sdk"]).unwrap();
        let Command::Generate(g) = generate.command else {
            panic!("expected Generate");
        };
        assert_eq!(g.spec.as_path(), Path::new("./a.json"));

        let openapi = parse(&["openapi", "overlay", "a.yaml"]).unwrap();
        assert!(matches!(openapi.command, Command::Openapi(_)));
        let openapi_b = parse(&["openapi", "overlay", "spec.yaml", "a.yaml", "b.yaml"]).unwrap();
        assert!(matches!(openapi_b.command, Command::Openapi(_)));

        // Global `--log-level` works before or after the subcommand and is case-insensitive.
        let ll = parse(&["openapi", "overlay", "--log-level", "debug", "a.yaml"]).unwrap();
        assert_eq!(ll.log_level, Some(super::log::Level::Debug));
        let ll_upper = parse(&["--log-level", "INFO", "normalize", "a.json"]).unwrap();
        assert_eq!(ll_upper.log_level, Some(super::log::Level::Info));
        assert!(parse(&["openapi", "overlay", "-v", "a.yaml"]).is_err());
        assert!(parse(&["openapi", "overlay", "--log-level", "loud", "a.yaml"]).is_err());

        // Each subcommand still requires its own arguments.
        assert!(parse(&["normalize"]).is_err());
        assert!(parse(&["inspect"]).is_err());
        assert!(parse(&["inspect", "a.json"]).is_err());
        assert!(parse(&["inspect", "methods"]).is_err());
        assert!(parse(&["generate"]).is_err());
        assert!(parse(&["generate", "a.json"]).is_err());
        assert!(parse(&["generate", "a.json", "--target", "ts"]).is_err());
        // The old root form is gone: a bare spec + flags is an error, and
        // the removed `--target`/`--out` are not top-level flags any more.
        assert!(parse(&["a.json", "--target", "ts", "--out", "sdk"]).is_err());
        assert!(parse(&["normalize", "--target", "ts", "a.json"]).is_err());
        assert!(parse(&["--target", "ts", "normalize", "a.json"]).is_err());
        // With nothing at all, clap prints help.
        assert!(parse(&[]).is_err());
    }
}
