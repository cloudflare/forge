//! The `forge` command, which generates an SDK from an OpenAPI document.
//!
//! ```text
//! forge openapi.json --target ts --out sdk
//! forge openapi.json --target mcp --out server
//! forge openapi.json --target wasm://plugin.wasm --out sdk
//! ```

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use forge::{Err, Forge};

mod mcp;
mod ts;

/// Generates an SDK from an OpenAPI document.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// The OpenAPI JSON document, or - to read it from standard input.
    spec: PathBuf,
    /// The language of the SDK: `ts` for TypeScript, `mcp` for an MCP
    /// server in TypeScript, or `wasm://PATH` for the plugin compiled to a
    /// WebAssembly component at PATH.
    #[arg(long, value_parser = Target::parse)]
    target: Target,
    /// The directory to write the SDK to.
    #[arg(long)]
    out: PathBuf,
}

/// What forge generates an SDK with.
#[derive(Clone)]
enum Target {
    /// The TypeScript generator.
    Ts,
    /// The MCP server generator, which generates TypeScript.
    Mcp,
    /// A plugin compiled to a WebAssembly component, at the path.
    #[cfg(feature = "wasm")]
    Wasm(PathBuf),
}

impl Target {
    fn parse(s: &str) -> Result<Target, String> {
        match s {
            "ts" => return Ok(Target::Ts),
            "mcp" => return Ok(Target::Mcp),
            _ => {}
        }
        let Some(path) = s.strip_prefix("wasm://") else {
            return Err("possible values: ts, mcp, wasm://PATH".to_owned());
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

/// Generates the SDK that `args` ask for.
fn run(args: Args) -> Result<(), Err> {
    match args.target {
        Target::Ts => {
            let forge = read(&args.spec)?;
            forge::write(&args.out, forge::run(&forge, &ts::Generator)?)
        }
        Target::Mcp => {
            let forge = read(&args.spec)?;
            forge::write(&args.out, forge::run(&forge, &mcp::Generator)?)
        }
        #[cfg(feature = "wasm")]
        Target::Wasm(path) => {
            // Compiling the plugin and reading the document are both slow,
            // so they run at the same time.
            let (plugin, forge) = rayon::join(|| forge::wasm::WasmPlugin::from_file(&path), || read(&args.spec));
            let (plugin, forge) = (plugin?, forge?);
            forge::write(&args.out, forge::run(&forge, &plugin)?)
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

    use super::Args;

    #[test]
    fn args() {
        Args::command().debug_assert();
    }
}
