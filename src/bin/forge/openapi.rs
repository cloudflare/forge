//! `forge openapi`, the subcommand group for verbs that operate on an
//! OpenAPI document. Future spec families (AsyncAPI, GraphQL) will live
//! alongside this one so the top-level command namespace stays flat.

mod overlay;

use forge::Err;

/// Arguments to `forge openapi`.
#[derive(clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: Command,
}

/// OpenAPI-specific subcommands.
#[derive(clap::Subcommand)]
enum Command {
    /// Apply one or more OpenAPI Overlay documents to a spec.
    ///
    /// With one positional argument, treat it as an overlay whose `extends`
    /// names the spec. With two or more positional arguments, treat the first
    /// as the spec (or `-` for standard input) and the rest as overlays to
    /// apply in order. Without `--out`, the result is printed to standard
    /// output; with `--out <PATH>` it is written to that file (if `<PATH>` is
    /// the spec itself, as an atomic in-place rewrite).
    Overlay(overlay::Args),
}

pub fn run(args: Args) -> Result<(), Err> {
    match args.command {
        Command::Overlay(a) => overlay::run(a),
    }
}
