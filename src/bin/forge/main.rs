//! The `forge` command, which generates an SDK from an OpenAPI document,
//! optionally preprocessed by one or more OpenAPI Overlay documents.
//!
//! ```text
//! forge openapi.json --target ts --out sdk
//! forge openapi.json --target capnweb --out server
//! forge openapi.json --target mcp --out tools
//! forge openapi.json --target wasm://plugin.wasm --out sdk
//! forge openapi.json --overlay a.yaml --overlay b.yaml --target ts --out sdk
//! forge overlay.yaml --target ts --out sdk               # overlay drives spec via its `extends`
//! forge overlay.yaml --overlay extra.yaml --target ts --out sdk
//! forge normalize specs/*.json
//! forge openapi overlay <spec-or-overlay> [--overlay <ov>]...   # print or write the merged spec
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
mod openapi;
mod ts;

/// Generate an SDK, apply an overlay, or run a subcommand.
#[derive(Parser)]
#[command(version, args_conflicts_with_subcommands = true)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    /// Input: an OpenAPI spec, or an Overlay document whose `extends` names
    /// the spec. `-` reads an OpenAPI spec from standard input.
    spec: Option<PathBuf>,
    /// Generate an SDK with this target. Requires --out.
    #[arg(long, value_parser = Target::parse)]
    target: Option<Target>,
    /// Output directory for the generated SDK. Required with --target.
    #[arg(long)]
    out: Option<PathBuf>,
    /// Apply this overlay to the spec before handing it to the generator.
    /// Repeat to apply more overlays in order.
    #[arg(long = "overlay", value_name = "OVERLAY")]
    overlay: Vec<PathBuf>,
    /// Print one line to stderr per overlay action as it runs: overlay path,
    /// action index, verb, target, and node counts. Only meaningful when one
    /// or more overlays are being applied (positional overlay or `--overlay`
    /// flags). Stdout and generated files are unchanged.
    #[arg(long)]
    explain: bool,
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
    /// OpenAPI-specific commands.
    Openapi(openapi::Args),
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

/// What a parsed [`Args`] resolves to at runtime.
enum Dispatch {
    Subcommand(Command),
    /// Generate an SDK. Preprocessing is optional: if `input_is_overlay` is
    /// true, the positional is actually an overlay with `extends` (apply it
    /// first); then apply any `--overlay` flags in order; then hand to the
    /// generator.
    GenerateSdk {
        input: PathBuf,
        input_is_overlay: bool,
        overlays: Vec<PathBuf>,
        target: Target,
        out: PathBuf,
        explain: bool,
    },
}

/// Does what `args` ask for.
fn run(args: Args) -> Result<(), Err> {
    match dispatch(args)? {
        Dispatch::Subcommand(Command::Normalize(a)) => normalize::run(a),
        Dispatch::Subcommand(Command::Openapi(a)) => openapi::run(a),
        Dispatch::GenerateSdk {
            input,
            input_is_overlay,
            overlays,
            target,
            out,
            explain,
        } => generate(&input, input_is_overlay, &overlays, target, &out, explain),
    }
}

/// Resolves `args` into one of the dispatch forms.
///
/// Priority:
/// 1. A subcommand wins.
/// 2. A positional means "generate an SDK", with both `--target` and `--out`
///    required; `--overlay` flags and an overlay-shaped positional are
///    preprocessing steps for the generator, not separate print modes.
/// 3. Nothing at all is a usage error.
fn dispatch(args: Args) -> Result<Dispatch, Err> {
    if let Some(command) = args.command {
        return Ok(Dispatch::Subcommand(command));
    }
    let Some(input) = args.spec else {
        return Err("no input given. Usage:\n\
             \x20 forge <spec> --target <TARGET> --out <DIR>\n\
             \x20 forge <spec> --overlay <OVERLAY>... --target <TARGET> --out <DIR>\n\
             \x20 forge <overlay> [--overlay <OVERLAY>]... --target <TARGET> --out <DIR>"
            .into());
    };
    let (target, out) = match (args.target, args.out) {
        (Some(t), Some(o)) => (t, o),
        (target, out) => {
            let mut missing: Vec<&str> = Vec::new();
            if target.is_none() {
                missing.push("--target <TARGET>");
            }
            if out.is_none() {
                missing.push("--out <OUT>");
            }
            return Err(format!(
                "SDK generation needs {}. Use `forge openapi overlay` if you want to apply an overlay \
                 and print or write the merged spec instead.",
                missing.join(" and ")
            )
            .into());
        }
    };
    let input_is_overlay = sniff_input_is_overlay(&input)?;
    Ok(Dispatch::GenerateSdk {
        input,
        input_is_overlay,
        overlays: args.overlay,
        target,
        out,
        explain: args.explain,
    })
}

/// Peeks at the positional input to decide whether to treat it as an overlay
/// (apply its `extends` before generating) or as a plain spec. Stdin cannot
/// be sniffed without consuming it, so `-` is always treated as a plain spec.
///
/// When sniffing is possible, `overlay:` present AND `openapi:` absent means
/// overlay. Otherwise the input is treated as a plain spec — the generator
/// will produce a real parse error if the file is unusable. Lenient on
/// unreadable files here because `--target` is present: the user has already
/// stated intent.
fn sniff_input_is_overlay(input: &Path) -> Result<bool, Err> {
    if input == Path::new("-") {
        return Ok(false);
    }
    let Ok(bytes) = read_head(input, 64 * 1024) else {
        return Ok(false);
    };
    let value: Option<serde_json::Value> = serde_json::from_slice(&bytes)
        .ok()
        .or_else(|| serde_yml::from_slice(&bytes).ok());
    let Some(top) = value.as_ref().and_then(|v| v.as_object()) else {
        return Ok(false);
    };
    let has_overlay = top.contains_key("overlay");
    let has_openapi = top.contains_key("openapi");
    // A document that is both, or neither, is treated as a spec. If the caller
    // actually meant it as an overlay-with-extends we have no way to tell and
    // the generator will raise a better error on its own content.
    Ok(has_overlay && !has_openapi)
}

/// Reads up to `limit` bytes from `path`, or from standard input when `path`
/// is `-`.
fn read_head(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(limit.min(8 * 1024));
    if path == Path::new("-") {
        io::stdin().take(limit as u64).read_to_end(&mut buf)?;
    } else {
        fs::File::open(path)?.take(limit as u64).read_to_end(&mut buf)?;
    }
    Ok(buf)
}

/// Generates the SDK for `input`, applying overlays beforehand when either
/// the positional is overlay-shaped or `overlays` is non-empty.
fn generate(
    input: &Path,
    input_is_overlay: bool,
    overlays: &[PathBuf],
    target: Target,
    out: &Path,
    explain: bool,
) -> Result<(), Err> {
    // Fast path: no preprocessing needed. This is the historical shape
    // (`forge spec.json --target ts --out sdk`) plus the wasm-target rayon
    // parallelism.
    if !input_is_overlay && overlays.is_empty() {
        return generate_from_path(input, target, out);
    }
    // Preprocess into an in-memory Value, then deserialize that into Forge
    // and hand to the chosen generator. This path does not parallelize the
    // read: overlay apply is fast enough that overlapping it with a wasm
    // plugin compile would complicate the code without a meaningful win.
    let value = if input_is_overlay {
        let (v, reports) = openapi::overlay::apply_from_overlay_positional_explained(input, overlays)?;
        if explain {
            openapi::overlay::print_reports_public(&reports);
        }
        v
    } else {
        let (v, reports) = openapi::overlay::apply_to_spec_explained(input, overlays)?;
        if explain {
            openapi::overlay::print_reports_public(&reports);
        }
        v
    };
    let forge = read_value(input, value)?;
    run_plugin_on(&forge, target, out)
}

/// Generator path that reads directly from `spec` (no overlay preprocessing).
fn generate_from_path(spec: &Path, target: Target, out: &Path) -> Result<(), Err> {
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

        // --target and --out are not clap-required any more (an overlay or
        // a lone-positional dispatch does not need them). The parse still
        // succeeds when they are absent — dispatch is what enforces the
        // per-mode requirements.
        assert!(parse(&["a.json"]).is_ok(), "lone positional parses");
        assert!(parse(&["a.json", "--overlay", "o.yaml"]).is_ok(), "overlay parses");
        assert!(
            parse(&["a.json", "--overlay", "o.yaml", "--overlay", "p.yaml"]).is_ok(),
            "multiple --overlay flags parse"
        );
        assert!(parse(&["--target", "ts", "normalize", "a.json"]).is_err());

        // Empty args now clap-parse (dispatch rejects them at runtime).
        assert!(parse(&[]).is_ok(), "empty args parse; dispatch rejects at runtime");

        // A subcommand still requires its own arguments.
        assert!(parse(&["normalize"]).is_err());
    }
}
