//! `forge overlay`, which applies one or more OpenAPI Overlay documents
//! (v1.0, v1.1, v1.2) to an OpenAPI document.

mod action;
mod apply;
mod document;
mod parsed;
mod path;
mod uri;

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use forge::Err;

use document::{Document, Format};
use parsed::Overlay;

/// Arguments to `forge overlay`.
#[derive(clap::Args)]
pub struct Args {
    /// In Mode A, the overlay document (its `extends` names the spec).
    /// In Mode B, the OpenAPI spec (or `-` for standard input). `--overlay`
    /// turns on Mode B.
    inputs: Vec<PathBuf>,
    /// An overlay to apply, in order. Switches on Mode B: the positional
    /// is then the spec, not an overlay.
    #[arg(long = "overlay", value_name = "OVERLAY")]
    overlays: Vec<PathBuf>,
    /// Rewrite the spec file in place instead of printing to stdout.
    /// Mode B only.
    #[arg(short, long)]
    write: bool,
}

pub fn run(args: Args) -> Result<(), Err> {
    if args.inputs.is_empty() {
        return Err("no input given; `forge overlay` requires an overlay or a spec. \
             Usage: forge overlay <overlay>   (Mode A: overlay drives the spec via its `extends`)\n\
             \x20      forge overlay <spec> --overlay <overlay>...   (Mode B)"
            .into());
    }
    if args.overlays.is_empty() {
        if args.inputs.len() > 1 {
            return Err(
                "`forge overlay` takes exactly one positional argument in Mode A (the overlay). \
                 To apply more than one overlay use `forge overlay <spec> --overlay <overlay>...`"
                    .into(),
            );
        }
        run_mode_a(&args.inputs[0], args.write)
    } else {
        if args.inputs.len() > 1 {
            return Err("`forge overlay <spec> --overlay ...` takes exactly one positional spec".into());
        }
        run_mode_b(&args.inputs[0], &args.overlays, args.write)
    }
}

/// Mode A: `forge overlay <overlay>` — overlay drives the spec via `extends`.
fn run_mode_a(overlay_path: &Path, write: bool) -> Result<(), Err> {
    if write {
        return Err("--write is only meaningful in Mode B (with --overlay): \
             Mode A has no spec file on the command line to rewrite"
            .into());
    }
    let bytes = read_file(overlay_path)?;
    let overlay =
        Overlay::parse(&bytes, Format::sniff(&bytes)).map_err(|e| format!("{}: {e}", overlay_path.display()))?;

    // Disambiguate mode A input: must be an overlay. If it has `overlay`
    // version key we accept; otherwise suggest the user.
    if overlay.is_spec_shaped() {
        return Err(disambiguation_error(overlay_path, true));
    }
    if !overlay.has_overlay_key() {
        return Err(disambiguation_error(overlay_path, false));
    }
    overlay.diagnose_warnings();

    let extends = overlay
        .extends()
        .ok_or_else(|| "overlay has no `extends` in Mode A: nothing names the spec to apply to".to_owned())?;

    // Mode A base URI is overlay retrieval URI (file:); then per 1.2 rules
    // $self is resolved against it and extends against $self.
    let retrieval = uri::from_path(overlay_path)?;
    let base = overlay.resolve_base_uri(&retrieval)?;
    let spec_uri = uri::resolve_reference(&base, extends)
        .map_err(|e| format!("cannot resolve extends {extends:?} against {base}: {e}"))?;

    // Reject non-file schemes (http/https are rejected earlier by security
    // layer; here we also reject urn: etc. as unresolvable).
    let spec_path = uri::to_path(&spec_uri)
        .map_err(|e| format!("extends resolves to {spec_uri}, which is not a local file: {e}"))?;

    let spec_bytes = fs::read(&spec_path).map_err(|e| format!("{}: {e}", spec_path.display()))?;
    let spec_format = Format::sniff(&spec_bytes);
    let mut doc = Document::parse(&spec_bytes, spec_format).map_err(|e| format!("{}: {e}", spec_path.display()))?;

    overlay.apply(&mut doc)?;
    write_stdout(&doc)?;
    Ok(())
}

/// Mode B: `forge overlay <spec> --overlay <ov>...` — spec on CLI.
fn run_mode_b(spec_path: &Path, overlay_paths: &[PathBuf], write: bool) -> Result<(), Err> {
    if write && spec_path == Path::new("-") {
        return Err("--write cannot be used when the spec is read from standard input (`-`)".into());
    }

    let spec_bytes = read_file(spec_path)?;
    let spec_format = Format::sniff(&spec_bytes);
    let display = if spec_path == Path::new("-") {
        "stdin".to_owned()
    } else {
        spec_path.display().to_string()
    };
    let mut doc = Document::parse(&spec_bytes, spec_format).map_err(|e| format!("{display}: {e}"))?;

    // Load and parse all overlays first (transactional validation).
    let mut parsed = Vec::with_capacity(overlay_paths.len());
    for p in overlay_paths {
        let bytes = read_file(p)?;
        let ov = Overlay::parse(&bytes, Format::sniff(&bytes)).map_err(|e| format!("{}: {e}", p.display()))?;
        ov.diagnose_warnings();

        // 1.2 §Base URI rule 5: Mode B extends vs target-spec $self.
        // When BOTH the overlay has extends AND we can compute a base URI
        // from its $self, and the target spec has a $self, the resolved
        // extends identifier must equal the target's $self (string equality).
        if let Some(extends) = ov.extends()
            && ov.version_supports_components()
            && let Some(target_self) = doc.value().get("$self").and_then(|v| v.as_str())
        {
            let retrieval = uri::from_path(p)?;
            let base = ov.resolve_base_uri(&retrieval)?;
            let resolved = uri::resolve_reference(&base, extends)
                .map_err(|e| format!("{}: cannot resolve extends: {e}", p.display()))?;
            if resolved != target_self {
                return Err(format!(
                    "{}: overlay's resolved extends identifier {resolved:?} does not match \
                     the target spec's $self {target_self:?}: the overlay was written \
                     against a different document",
                    p.display()
                )
                .into());
            }
        }

        parsed.push(ov);
    }

    // Apply in order; first failure stops the chain and nothing is written.
    for ov in &parsed {
        ov.apply(&mut doc)?;
    }

    if write {
        // In --write, only touch the file if we actually mutated it.
        if doc.mutated() {
            fs::write(spec_path, doc.to_bytes()?).map_err(|e| format!("{}: {e}", spec_path.display()))?;
        }
    } else {
        write_stdout(&doc)?;
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>, Err> {
    if path == Path::new("-") {
        let mut v = Vec::new();
        io::stdin().read_to_end(&mut v)?;
        Ok(v)
    } else {
        fs::read(path).map_err(|e| format!("{}: {e}", path.display()).into())
    }
}

fn write_stdout(doc: &Document) -> Result<(), Err> {
    let bytes = doc.to_bytes()?;
    let mut out = io::stdout().lock();
    out.write_all(&bytes)?;
    out.flush()?;
    Ok(())
}

fn disambiguation_error(path: &Path, is_spec: bool) -> Err {
    let shown = path.display();
    if is_spec {
        format!(
            "{shown}: looks like an OpenAPI spec, not an Overlay document. Did you mean \
             `forge overlay <spec> --overlay <overlay>` or add an `overlay` version key?"
        )
        .into()
    } else {
        format!(
            "{shown}: not an overlay (missing `overlay` version key) and not an OpenAPI spec \
             (missing `openapi` key). Expected either, but with `--overlay` to pass an overlay."
        )
        .into()
    }
}
