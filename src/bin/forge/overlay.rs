//! `forge overlay`, which applies one or more OpenAPI Overlay documents
//! (v1.0, v1.1, v1.2) to an OpenAPI document.

mod action;
pub mod apply;
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

/// Per-overlay action reports, tagged with the overlay's source path. One
/// entry per overlay that ran; each entry's `Vec` holds the reports in the
/// order the actions ran.
pub type TaggedReports = Vec<(PathBuf, Vec<apply::ActionReport>)>;

/// Arguments to `forge overlay`.
#[derive(clap::Args)]
pub struct Args {
    /// In Mode A, the overlay document (its `extends` names the spec).
    /// In Mode B, the OpenAPI spec (or `-` for standard input). `--overlay`
    /// turns on Mode B. With `--check`, each positional is an overlay to
    /// lint (or `-` for one overlay from standard input).
    inputs: Vec<PathBuf>,
    /// An overlay to apply, in order. Switches on Mode B: the positional
    /// is then the spec, not an overlay.
    #[arg(long = "overlay", value_name = "OVERLAY", conflicts_with = "check")]
    overlays: Vec<PathBuf>,
    /// Write the overlaid result to PATH. Without this flag the result is
    /// printed to standard output. If PATH is the same file as the spec in
    /// Mode B, it is rewritten atomically (temp file + rename) and left
    /// byte-identical when no action mutated it.
    #[arg(short = 'o', long = "out", value_name = "PATH", conflicts_with = "check")]
    out: Option<PathBuf>,
    /// Lint the given overlay documents (no `--overlay`, no `--out`). Each
    /// positional is parsed and validated; nothing is applied, and `extends`
    /// is NOT resolved to a file on disk. Exits 0 when every overlay is
    /// valid; otherwise reports each file's diagnostics on stderr and exits
    /// non-zero. All files are checked, even when earlier ones fail.
    #[arg(long)]
    check: bool,
    /// Print one line to stderr per overlay action as it runs, naming the
    /// overlay, action index, verb, target, and how many nodes matched and
    /// mutated. Stdout (merged spec or generated SDK) is unchanged.
    #[arg(long, conflicts_with = "check")]
    explain: bool,
}

pub fn run(args: Args) -> Result<(), Err> {
    if args.check {
        return run_check(&args.inputs);
    }
    if args.inputs.is_empty() {
        return Err("no input given; `forge overlay` requires an overlay or a spec. \
             Usage: forge overlay <overlay>   (Mode A: overlay drives the spec via its `extends`)\n\
             \x20      forge overlay <spec> --overlay <overlay>...   (Mode B)\n\
             \x20      forge overlay --check <overlay>...   (lint only)"
            .into());
    }
    let out = args.out.as_deref();
    let explain = args.explain;
    if args.overlays.is_empty() {
        if args.inputs.len() > 1 {
            return Err(
                "`forge overlay` takes exactly one positional argument in Mode A (the overlay). \
                 To apply more than one overlay use `forge overlay <spec> --overlay <overlay>...`"
                    .into(),
            );
        }
        run_mode_a_path(&args.inputs[0], out, explain)
    } else {
        if args.inputs.len() > 1 {
            return Err("`forge overlay <spec> --overlay ...` takes exactly one positional spec".into());
        }
        run_mode_b_paths(&args.inputs[0], &args.overlays, out, explain)
    }
}

/// Mode A: `forge overlay <overlay>` — overlay drives the spec via `extends`.
pub fn run_mode_a_path(overlay_path: &Path, out: Option<&Path>, explain: bool) -> Result<(), Err> {
    let (doc, reports) = apply_mode_a(overlay_path)?;
    if explain {
        print_reports(std::slice::from_ref(&(overlay_path.to_path_buf(), reports)));
    }
    emit(&doc, out, None)
}

/// Mode B: `forge overlay <spec> --overlay <ov>...` — spec on CLI.
pub fn run_mode_b_paths(
    spec_path: &Path,
    overlay_paths: &[PathBuf],
    out: Option<&Path>,
    explain: bool,
) -> Result<(), Err> {
    let (doc, reports) = apply_mode_b(spec_path, overlay_paths)?;
    if explain {
        print_reports(&reports);
    }
    // In Mode B the spec file (when it is a real file, not stdin) is a
    // candidate for the in-place rewrite path. In Mode A there is no spec
    // file argument on the CLI to compare against.
    let spec_for_compare = (spec_path != Path::new("-")).then_some(spec_path);
    emit(&doc, out, spec_for_compare)
}

/// Apply the positional overlay (resolving its `extends`) and then every file
/// in `extra_overlays` in order, and return the merged document as a plain
/// `Value` plus per-overlay action reports tagged with their source path.
/// Used by the top-level `forge` when the positional is an overlay that
/// drives the spec via `extends`, with optional further `--overlay` flags
/// stacked after it.
pub fn apply_from_overlay_positional_explained(
    positional_overlay: &Path,
    extra_overlays: &[PathBuf],
) -> Result<(serde_json::Value, TaggedReports), Err> {
    let (mut doc, mut reports) = apply_mode_a(positional_overlay)?;
    let mut tagged: TaggedReports = vec![(positional_overlay.to_path_buf(), std::mem::take(&mut reports))];
    let more = apply_overlays_to_doc(&mut doc, extra_overlays)?;
    tagged.extend(more);
    Ok((doc.value().clone(), tagged))
}

/// Apply `overlays` in order to the spec at `spec_path` and return the merged
/// document as a plain `Value` plus per-overlay action reports tagged with
/// their source path. Used by the top-level `forge` when the positional is a
/// plain spec plus one or more `--overlay` flags.
pub fn apply_to_spec_explained(
    spec_path: &Path,
    overlays: &[PathBuf],
) -> Result<(serde_json::Value, TaggedReports), Err> {
    let (doc, reports) = apply_mode_b(spec_path, overlays)?;
    Ok((doc.value().clone(), reports))
}

/// Shared Mode A core: load the overlay, resolve its `extends`, parse the
/// spec it points at, and apply the overlay. Returns the merged `Document`
/// and the per-action reports from the overlay's apply.
fn apply_mode_a(overlay_path: &Path) -> Result<(Document, Vec<apply::ActionReport>), Err> {
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

    let reports = overlay.apply(&mut doc)?;
    Ok((doc, reports))
}

/// Shared Mode B core: parse the spec and apply each overlay in order,
/// returning the merged `Document` and per-overlay action reports.
fn apply_mode_b(spec_path: &Path, overlay_paths: &[PathBuf]) -> Result<(Document, TaggedReports), Err> {
    let spec_bytes = read_file(spec_path)?;
    let spec_format = Format::sniff(&spec_bytes);
    let display = if spec_path == Path::new("-") {
        "stdin".to_owned()
    } else {
        spec_path.display().to_string()
    };
    let mut doc = Document::parse(&spec_bytes, spec_format).map_err(|e| format!("{display}: {e}"))?;
    let reports = apply_overlays_to_doc(&mut doc, overlay_paths)?;
    Ok((doc, reports))
}

/// Load, validate, and apply `overlay_paths` to `doc` in order. All overlays
/// are parsed first so a bad one fails the chain before any mutation. The
/// 1.2 `$self`/`extends` identity check is applied against the target doc's
/// current `$self`, so it covers both Mode B and the top-level case where a
/// Mode A result is further extended with extra overlays. Returns per-overlay
/// action reports tagged with the originating overlay path.
fn apply_overlays_to_doc(doc: &mut Document, overlay_paths: &[PathBuf]) -> Result<TaggedReports, Err> {
    // Load and parse all overlays first (transactional validation).
    let mut parsed = Vec::with_capacity(overlay_paths.len());
    for p in overlay_paths {
        let bytes = read_file(p)?;
        let ov = Overlay::parse(&bytes, Format::sniff(&bytes)).map_err(|e| format!("{}: {e}", p.display()))?;
        ov.diagnose_warnings();

        // 1.2 §Base URI rule 5: extends vs target-spec $self. When BOTH the
        // overlay has extends AND we can compute a base URI from its $self,
        // and the target spec has a $self, the resolved extends identifier
        // must equal the target's $self (string equality).
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
    let mut tagged: TaggedReports = Vec::with_capacity(parsed.len());
    for (ov, path) in parsed.iter().zip(overlay_paths.iter()) {
        let reports = ov.apply(doc)?;
        tagged.push((path.clone(), reports));
    }
    Ok(tagged)
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

/// Lint each file in `inputs`: parse and validate without resolving `extends`
/// or applying to a spec. Reports per-file diagnostics to stderr prefixed
/// with the file path; continues through every file so CI gets every problem
/// in one run. `-` reads one overlay from standard input.
fn run_check(inputs: &[PathBuf]) -> Result<(), Err> {
    if inputs.is_empty() {
        return Err("--check requires at least one overlay file (or `-` for standard input)".into());
    }
    let mut failed = 0usize;
    for path in inputs {
        let display = if path == Path::new("-") {
            "stdin".to_owned()
        } else {
            path.display().to_string()
        };
        let bytes = match read_file(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("{display}: {e}");
                failed += 1;
                continue;
            }
        };
        let format = Format::sniff(&bytes);
        match Overlay::parse(&bytes, format) {
            Ok(ov) => {
                ov.diagnose_warnings();
            }
            Err(e) => {
                eprintln!("{display}: {e}");
                failed += 1;
            }
        }
    }
    if failed > 0 {
        let noun = if failed == 1 { "file" } else { "files" };
        return Err(format!("{failed} overlay {noun} failed lint").into());
    }
    Ok(())
}

/// Print one line per overlay action to stderr. Used when `--explain` is
/// given. Zero-match actions are still printed because that is the diagnostic
/// signal — the author usually wants to know when a filter matched nothing.
fn print_reports(tagged: &[(PathBuf, Vec<apply::ActionReport>)]) {
    use std::io::Write;
    let stderr = io::stderr();
    let mut lock = stderr.lock();
    for (path, reports) in tagged {
        let shown = path.display();
        for (i, r) in reports.iter().enumerate() {
            let _ = writeln!(lock, "{shown}:{i} {}", r.format());
        }
    }
    let _ = lock.flush();
}

/// Public alias for the top-level `forge` module.
pub fn print_reports_public(tagged: &[(PathBuf, Vec<apply::ActionReport>)]) {
    print_reports(tagged)
}
