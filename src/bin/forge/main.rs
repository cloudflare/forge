//! The `forge` command, which generates an SDK from an OpenAPI document
//! (or a self-contained OpenAPI Overlay document whose `extends` names one).
//!
//! ```text
//! forge generate openapi.json --target ts --out sdk
//! forge generate openapi.json --target capnweb --out server
//! forge generate openapi.json --target mcp --out tools
//! forge generate openapi.json --target wasm://plugin.wasm --out sdk
//! forge generate overlay.yaml --target ts --out sdk   # overlay drives the spec via its `extends`
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
#[command(version, subcommand_required = true)]
struct Args {
    /// Increase diagnostic logging on stderr (`-v` info, `-vv` debug, `-vvv` trace).
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    verbose: u8,
    /// Set the diagnostic log level on stderr (also configurable via `FORGE_LOG`).
    #[arg(long, value_enum, global = true, conflicts_with = "verbose")]
    log_level: Option<log::Level>,
    #[command(subcommand)]
    command: Command,
}

/// What `forge` does.
#[derive(clap::Subcommand)]
enum Command {
    /// Generate an SDK from an OpenAPI document or a self-contained Overlay
    /// document (with `extends`).
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
    /// The OpenAPI JSON document, an Overlay document whose `extends` names
    /// the spec, or `-` to read a spec from standard input.
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
    log::init(log::resolve(args.log_level, args.verbose));
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

/// Generates the SDK for `args.spec`, applying it as an overlay first when
/// the input is an Overlay document (with `extends`).
fn generate(args: GenerateArgs) -> Result<(), Err> {
    let spec = args.spec.as_path();
    let out = args.out.as_path();
    let preloaded = if spec == Path::new("-") {
        None
    } else {
        Some(fs::read(spec).map_err(|err| format!("{}: {err}", spec.display()))?)
    };
    let input_is_overlay = preloaded.as_deref().is_some_and(bytes_look_like_overlay);
    // Fast path: no preprocessing needed. This is the historical shape plus
    // the wasm-target rayon parallelism, reusing the already-read bytes so
    // the spec is never read from disk twice.
    if !input_is_overlay {
        return generate_from_path(spec, preloaded, args.target, out);
    }
    // Preprocess into an in-memory Value, then deserialize that into Forge
    // and hand to the chosen generator. This path does not parallelize the
    // read: overlay apply is fast enough that overlapping it with a wasm
    // plugin compile would complicate the code without a meaningful win.
    let doc = openapi::overlay::apply_extends(spec, preloaded)?;
    let label = doc.source_path().unwrap_or(spec).to_path_buf();
    let forge = read_value(&label, doc.into_value())?;
    run_plugin_on(&forge, args.target, out)
}

/// Peeks at top-level mapping keys of `bytes` to decide whether to treat the
/// input as an overlay (apply its `extends` before generating) or as a plain
/// spec. Uses a streaming visitor that skips all values via `IgnoredAny` so
/// sniffing a large OpenAPI spec allocates no DOM.
///
/// `overlay:` present AND `openapi:` absent means overlay. Otherwise the input
/// is treated as a plain spec — the generator will produce a real parse error
/// if the file is unusable.
fn bytes_look_like_overlay(bytes: &[u8]) -> bool {
    let content = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let keys = serde_json::from_slice::<TopLevelKeys>(content)
        .ok()
        .or_else(|| serde_saphyr::from_slice::<TopLevelKeys>(content).ok());
    matches!(
        keys,
        Some(TopLevelKeys {
            has_overlay: true,
            has_openapi: false,
        })
    )
}

/// Streaming deserializer that records only whether the top-level mapping
/// contains `overlay` and `openapi`, skipping every value with `IgnoredAny`.
struct TopLevelKeys {
    has_overlay: bool,
    has_openapi: bool,
}

impl<'de> serde::Deserialize<'de> for TopLevelKeys {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = TopLevelKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a top-level mapping")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut keys = TopLevelKeys {
                    has_overlay: false,
                    has_openapi: false,
                };
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    match key.as_ref() {
                        "overlay" => keys.has_overlay = true,
                        "openapi" => keys.has_openapi = true,
                        _ => {}
                    }
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(keys)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

/// Generator path that reads directly from `spec` (no overlay preprocessing).
fn generate_from_path(spec: &Path, preloaded: Option<Vec<u8>>, target: Target, out: &Path) -> Result<(), Err> {
    match target {
        Target::Ts => run_plugin(&ts::Generator, spec, preloaded, out),
        Target::Capnweb => run_plugin(&capnweb::Generator, spec, preloaded, out),
        Target::Mcp => run_plugin(&mcp::Generator, spec, preloaded, out),
        #[cfg(feature = "wasm")]
        Target::Wasm(path) => {
            // Compiling the plugin and reading the document are both slow,
            // so they run at the same time.
            let (plugin, forge) = rayon::join(
                || forge::wasm::WasmPlugin::from_file(&path),
                || read_preloaded(spec, preloaded),
            );
            let (plugin, forge) = (plugin?, forge?);
            forge::write(out, plugin.generate(&forge)?)
        }
    }
}

fn run_plugin(plugin: &impl Plugin, spec: &Path, preloaded: Option<Vec<u8>>, out: &Path) -> Result<(), Err> {
    forge::write(out, plugin.generate(&read_preloaded(spec, preloaded)?)?)
}

fn run_plugin_on(forge: &Forge, target: Target, out: &Path) -> Result<(), Err> {
    match target {
        Target::Ts => forge::write(out, ts::Generator.generate(forge)?),
        Target::Capnweb => forge::write(out, capnweb::Generator.generate(forge)?),
        Target::Mcp => forge::write(out, mcp::Generator.generate(forge)?),
        #[cfg(feature = "wasm")]
        Target::Wasm(path) => {
            let plugin = forge::wasm::WasmPlugin::from_file(&path)?;
            forge::write(out, plugin.generate(forge)?)
        }
    }
}

/// Reads the document at `path`, or from standard input when `path` is `-`.
fn read(path: &Path) -> Result<Forge, Err> {
    read_preloaded(path, None)
}

/// Like [`read`], reusing `preloaded` file bytes when already read from disk.
fn read_preloaded(path: &Path, preloaded: Option<Vec<u8>>) -> Result<Forge, Err> {
    let parse = || -> Result<Forge, Err> {
        let json = match preloaded {
            Some(bytes) => bytes,
            None if path == Path::new("-") => {
                let mut json = Vec::new();
                io::stdin().read_to_end(&mut json)?;
                json
            }
            None => fs::read(path)?,
        };
        Ok(serde_json::from_slice(&json)?)
    };
    parse().map_err(|err| format!("{}: {err}", path.display()).into())
}

/// Deserializes a preprocessed (overlay-applied) document into [`Forge`].
/// `source` is used only for the error label.
fn read_value(source: &Path, value: serde_json::Value) -> Result<Forge, Err> {
    serde_json::from_value(value).map_err(|err| format!("{}: {err}", source.display()).into())
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

        // Global logging flags work before or after the subcommand and conflict with each other.
        let v1 = parse(&["openapi", "overlay", "-v", "a.yaml"]).unwrap();
        assert_eq!(v1.verbose, 1);
        let v2 = parse(&["-vv", "openapi", "overlay", "a.yaml"]).unwrap();
        assert_eq!(v2.verbose, 2);
        let ll = parse(&["openapi", "overlay", "--log-level", "debug", "a.yaml"]).unwrap();
        assert_eq!(ll.log_level, Some(super::log::Level::Debug));
        assert!(parse(&["openapi", "overlay", "-v", "--log-level", "debug", "a.yaml"]).is_err());
        let norm_v = parse(&["normalize", "-v", "a.json"]).unwrap();
        assert_eq!(norm_v.verbose, 1);

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
