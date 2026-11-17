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
    /// Write the overlaid result to PATH. Without this flag the result is
    /// printed to standard output. If PATH is the same file as the spec in
    /// Mode B, it is rewritten atomically (temp file + rename) and left
    /// byte-identical when no action mutated it.
    #[arg(short = 'o', long = "out", value_name = "PATH")]
    out: Option<PathBuf>,
}

pub fn run(args: Args) -> Result<(), Err> {
    if args.inputs.is_empty() {
        return Err("no input given; `forge overlay` requires an overlay or a spec. \
             Usage: forge overlay <overlay>   (Mode A: overlay drives the spec via its `extends`)\n\
             \x20      forge overlay <spec> --overlay <overlay>...   (Mode B)"
            .into());
    }
    let out = args.out.as_deref();
    if args.overlays.is_empty() {
        if args.inputs.len() > 1 {
            return Err(
                "`forge overlay` takes exactly one positional argument in Mode A (the overlay). \
                 To apply more than one overlay use `forge overlay <spec> --overlay <overlay>...`"
                    .into(),
            );
        }
        run_mode_a(&args.inputs[0], out)
    } else {
        if args.inputs.len() > 1 {
            return Err("`forge overlay <spec> --overlay ...` takes exactly one positional spec".into());
        }
        run_mode_b(&args.inputs[0], &args.overlays, out)
    }
}

/// Mode A: `forge overlay <overlay>` — overlay drives the spec via `extends`.
fn run_mode_a(overlay_path: &Path, out: Option<&Path>) -> Result<(), Err> {
    let bytes = read_file(overlay_path)?;
    let format = Format::sniff(&bytes);

    // Sniff the raw top-level keys first: `Overlay::parse` rejects a spec's
    // `openapi` key as unknown, which would hide the helpful hint.
    if let Ok(raw) = Document::parse(&bytes, format)
        && let Some(obj) = raw.value().as_object()
        && !obj.contains_key("overlay")
    {
        return Err(disambiguation_error(overlay_path, obj.contains_key("openapi")));
    }
    let overlay = Overlay::parse(&bytes, format).map_err(|e| format!("{}: {e}", overlay_path.display()))?;
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
    emit(&doc, out, None)?;
    Ok(())
}

/// Mode B: `forge overlay <spec> --overlay <ov>...` — spec on CLI.
fn run_mode_b(spec_path: &Path, overlay_paths: &[PathBuf], out: Option<&Path>) -> Result<(), Err> {
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

    // In Mode B the spec file (when it is a real file, not stdin) is a
    // candidate for the in-place rewrite path. In Mode A there is no spec
    // file argument on the CLI to compare against.
    let spec_for_compare = (spec_path != Path::new("-")).then_some(spec_path);
    emit(&doc, out, spec_for_compare)?;
    Ok(())
}

/// Routes the applied document to `--out <path>` or stdout. When `out_path`
/// canonically equals `spec_path`, treats the write as an in-place rewrite:
/// skip the write entirely if nothing was mutated, otherwise replace the
/// file atomically via a temp file + rename in the same directory.
fn emit(doc: &Document, out_path: Option<&Path>, spec_path: Option<&Path>) -> Result<(), Err> {
    match out_path {
        None => write_stdout(doc),
        Some(path) => write_output(doc, path, spec_path),
    }
}

fn write_output(doc: &Document, out_path: &Path, spec_path: Option<&Path>) -> Result<(), Err> {
    let in_place = match spec_path {
        Some(sp) => same_file(sp, out_path),
        None => false,
    };

    if in_place {
        // Preserve bytes and mtime on a no-op, matching the old --write
        // guarantee. Any other --out path still gets written even on a
        // no-op, because the user asked for output there.
        if !doc.mutated() {
            return Ok(());
        }
        let bytes = doc.to_bytes()?;
        write_atomic(out_path, &bytes)?;
    } else {
        let bytes = doc.to_bytes()?;
        fs::write(out_path, &bytes).map_err(|e| format!("{}: {e}", out_path.display()))?;
    }
    Ok(())
}

/// True when both paths resolve to the same filesystem location. Canonical
/// comparison, so `./spec.yaml` and `spec.yaml` compare equal. When `out_path`
/// does not exist yet (the usual case), its parent directory is canonicalized
/// and the final component appended.
fn same_file(spec_path: &Path, out_path: &Path) -> bool {
    match (canonical_target(spec_path), canonical_target(out_path)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn canonical_target(path: &Path) -> io::Result<PathBuf> {
    if let Ok(c) = fs::canonicalize(path) {
        return Ok(c);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let parent_c = fs::canonicalize(parent)?;
    Ok(parent_c.join(file_name))
}

/// Writes `bytes` to a sibling temp file in the same directory as `path`,
/// then renames it over `path`. The rename is atomic on POSIX filesystems,
/// so a concurrent reader sees either the old or the new file, never a
/// partially-written one. On rename failure the temp file is cleaned up.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), Err> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let base = path
        .file_name()
        .ok_or_else(|| format!("{}: has no file name", path.display()))?
        .to_string_lossy();
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = dir.join(format!(".{base}.forge-overlay-{pid}-{nanos}.tmp"));

    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", path.display()).into());
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
