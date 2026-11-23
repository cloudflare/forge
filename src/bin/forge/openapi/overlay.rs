//! `forge openapi overlay`, which applies one or more OpenAPI Overlay documents
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

pub use document::Document;
use document::Format;
use parsed::Overlay;

/// Per-overlay action reports, tagged with the overlay's source path. One
/// entry per overlay that ran; each entry's `Vec` holds the reports in the
/// order the actions ran.
pub type TaggedReports = Vec<(PathBuf, Vec<apply::ActionReport>)>;

/// Arguments to `forge openapi overlay`.
#[derive(clap::Args)]
pub struct Args {
    /// With no `--overlay`, the single positional is an overlay whose
    /// `extends` names the spec to apply to. With one or more `--overlay`
    /// flags, the single positional is the OpenAPI spec (or `-` for standard
    /// input). With `--check`, each positional is an overlay to lint (or `-`
    /// for one overlay from standard input).
    inputs: Vec<PathBuf>,
    /// An overlay to apply, in order. When given, the positional is the spec
    /// rather than an overlay.
    #[arg(long = "overlay", value_name = "OVERLAY", conflicts_with = "check")]
    overlays: Vec<PathBuf>,
    /// Write the overlaid result to PATH. Without this flag the result is
    /// printed to standard output. If PATH is the same file as the spec, it is
    /// rewritten atomically (temp file + rename) and left byte-identical when
    /// no action mutated it.
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
        return Err(
            "no input given; `forge openapi overlay` requires an overlay or a spec. \
             Usage: forge openapi overlay <overlay>   (overlay's `extends` names the spec)\n\
             \x20      forge openapi overlay <spec> --overlay <overlay>...\n\
             \x20      forge openapi overlay --check <overlay>...   (lint only)"
                .into(),
        );
    }
    let first_is_overlay = args.overlays.is_empty();
    if args.inputs.len() > 1 {
        return Err(if first_is_overlay {
            "`forge openapi overlay` takes exactly one positional (the overlay). \
             To apply more than one overlay use `forge openapi overlay <spec> --overlay <overlay>...`"
                .into()
        } else {
            "`forge openapi overlay <spec> --overlay ...` takes exactly one positional spec".into()
        });
    }
    let first = args.inputs[0].as_path();
    let (doc, reports) = apply(first, first_is_overlay, None, &args.overlays)?;
    if args.explain {
        print_reports(&reports);
    }
    emit(&doc, args.out.as_deref(), doc.source_path())
}

/// Apply overlays to a spec and return the merged document plus per-overlay
/// action reports tagged with their source path. When `first_is_overlay`, the
/// `first` positional is an overlay whose `extends` names the spec; it is
/// applied before `rest`. Otherwise `first` IS the spec (or `-` for stdin).
/// When `preloaded` is `Some`, those bytes are used instead of re-reading
/// `first` from disk.
pub fn apply(
    first: &Path,
    first_is_overlay: bool,
    preloaded: Option<Vec<u8>>,
    rest: &[PathBuf],
) -> Result<(Document, TaggedReports), Err> {
    let (mut doc, first_overlay) = load_spec(first, first_is_overlay, preloaded)?;
    let mut tagged: TaggedReports = Vec::new();
    if let Some(ov) = first_overlay {
        let reports = ov.apply(&mut doc)?;
        tagged.push((first.to_path_buf(), reports));
    }
    tagged.extend(apply_overlays_to_doc(&mut doc, rest)?);
    Ok((doc, tagged))
}

/// Load the spec document that overlays apply to. When `first_is_overlay`,
/// parse `first` as an overlay, resolve its `extends` to a local file, load
/// that spec, enforce the 1.2 `$self`/`extends` identity check, and return
/// the parsed overlay for the caller to apply first. Otherwise `first` is
/// the spec itself.
fn load_spec(
    first: &Path,
    first_is_overlay: bool,
    preloaded: Option<Vec<u8>>,
) -> Result<(Document, Option<Overlay>), Err> {
    let first_bytes = match preloaded {
        Some(bytes) => bytes,
        None => read_file(first)?,
    };
    if !first_is_overlay {
        let spec_format = Format::sniff(&first_bytes);
        let display = if first == Path::new("-") {
            "stdin".to_owned()
        } else {
            first.display().to_string()
        };
        // Spec retrieval URI: the file path when there is one, otherwise CWD
        // (used by overlay apply to re-express rebased relative `$ref`s in
        // inserted content as paths relative to the spec's location).
        let spec_base = spec_base_uri(first).map_err(|e| format!("{display}: {e}"))?;
        let source_path = (first != Path::new("-")).then(|| first.to_path_buf());
        let doc = Document::parse(&first_bytes, spec_format)
            .map_err(|e| format!("{display}: {e}"))?
            .with_base_uri(Some(spec_base))
            .with_source_path(source_path);
        return Ok((doc, None));
    }

    let format = Format::sniff(&first_bytes);

    // Parse once: check top-level keys first so an OpenAPI spec passed in
    // Mode A gets the disambiguation hint rather than an "unknown key" error.
    let (raw_value, _) =
        document::parse_value(&first_bytes, format, "overlay as ").map_err(|e| format!("{}: {e}", first.display()))?;
    if let Some(obj) = raw_value.as_object()
        && !obj.contains_key("overlay")
    {
        return Err(disambiguation_error(first, obj.contains_key("openapi")));
    }
    let overlay = Overlay::from_value(&raw_value).map_err(|e| format!("{}: {e}", first.display()))?;
    overlay.diagnose_warnings();

    let extends = overlay
        .extends()
        .ok_or_else(|| "overlay has no `extends`: nothing names the spec to apply to".to_owned())?;

    // Overlay retrieval URI drives base-URI resolution; $self (per 1.2 rules)
    // is resolved against it, then extends against $self.
    let retrieval = uri::from_path(first)?;
    let base = overlay.resolve_base_uri(&retrieval)?;
    let spec_uri = uri::resolve_reference(&base, extends)
        .map_err(|e| format!("cannot resolve extends {extends:?} against {base}: {e}"))?;
    let spec_path = uri::to_path(&spec_uri)
        .map_err(|e| format!("extends resolves to {spec_uri}, which is not a local file: {e}"))?;

    let spec_bytes = fs::read(&spec_path).map_err(|e| format!("{}: {e}", spec_path.display()))?;
    let spec_format = Format::sniff(&spec_bytes);
    // Canonicalize the spec's base URI (via from_path) so the overlay's and
    // spec's bases live in the same canonical space. Using spec_uri directly
    // would skip symlink resolution and make relative_file_ref fall back to
    // absolute unnecessarily whenever $self or extends pointed through a
    // symlink.
    let spec_base = spec_base_uri(&spec_path).map_err(|e| format!("{}: {e}", spec_path.display()))?;
    let doc = Document::parse(&spec_bytes, spec_format)
        .map_err(|e| format!("{}: {e}", spec_path.display()))?
        .with_base_uri(Some(spec_base))
        .with_source_path(Some(spec_path));

    // 1.2 §Base URI rule 5: even though `extends` chose the file we loaded,
    // the spec may declare a `$self` identifier that disagrees (e.g. a URN) —
    // in which case the overlay was authored against a different document.
    // `apply_overlays_to_doc` enforces this for subsequent overlays; mirror
    // it here for the extends-driven first overlay.
    overlay
        .check_extends_identity(&spec_uri, &doc)
        .map_err(|e| format!("{}: {e}", first.display()))?;

    Ok((doc, Some(overlay.with_base_uri(Some(base)))))
}

/// Compute the retrieval URI for a spec path: a `file:` URI for a real file,
/// a CWD-based `file:` URI for stdin (so relative `$ref`s in inserted content
/// still rebase to a knowable location). Errors when the path can't be
/// expressed as a URI (non-UTF-8 bytes, unreadable CWD) rather than silently
/// returning None — a missing base disables `$ref` rebasing and leaks
/// absolute `file:///…` URIs into the merged output.
fn spec_base_uri(spec_path: &Path) -> Result<String, Err> {
    if spec_path == Path::new("-") {
        // Treat stdin as a synthetic file in CWD. `relative_file_ref`
        // resolves references against a document's parent directory, so
        // passing the directory itself would incorrectly use CWD's parent.
        // The sentinel filename carries a long random-looking suffix so a
        // real file of this name is vanishingly unlikely to be sitting in
        // CWD and silently collide with the stdin base in same-file ref
        // comparisons.
        let cwd = std::env::current_dir().map_err(|e| format!("cannot read current directory: {e}"))?;
        let cwd = fs::canonicalize(&cwd)
            .map_err(|e| format!("cannot canonicalize current directory {}: {e}", cwd.display()))?;
        uri::from_path(&cwd.join(".forge-stdin-openapi-b1a7d2e3f4c5"))
    } else {
        uri::from_path(spec_path)
    }
}

/// Load, validate, and apply `overlay_paths` to `doc` in order. All overlays
/// are parsed first so a bad one fails the chain before any mutation. The
/// 1.2 `$self`/`extends` identity check runs against the target doc's current
/// `$self`. Returns per-overlay action reports tagged with the originating
/// overlay path.
fn apply_overlays_to_doc(doc: &mut Document, overlay_paths: &[PathBuf]) -> Result<TaggedReports, Err> {
    // Load and parse all overlays first (transactional validation).
    let mut parsed = Vec::with_capacity(overlay_paths.len());
    for p in overlay_paths {
        let bytes = read_file(p)?;
        let ov = Overlay::parse(&bytes, Format::sniff(&bytes)).map_err(|e| format!("{}: {e}", p.display()))?;
        ov.diagnose_warnings();

        // Track the overlay's resolved base URI so apply can rebase relative
        // `$ref`s inside inserted content against it. Computed from the
        // overlay's retrieval URI, then resolved through any `$self`.
        let retrieval = uri::from_path(p)?;
        let base = ov.resolve_base_uri(&retrieval)?;

        // 1.2 §Base URI rule 5: extends vs target-spec $self. When BOTH the
        // overlay has extends AND we can compute a base URI from its $self,
        // and the target spec has a $self, the resolved extends identifier
        // must equal the target's $self (string equality).
        if let Some(extends) = ov.extends() {
            let resolved = uri::resolve_reference(&base, extends)
                .map_err(|e| format!("{}: cannot resolve extends: {e}", p.display()))?;
            ov.check_extends_identity(&resolved, doc)
                .map_err(|e| format!("{}: {e}", p.display()))?;
        }

        parsed.push(ov.with_base_uri(Some(base)));
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
        // Follow symlinks so an in-place rewrite through a symlink keeps the
        // link intact and atomically replaces its target (matching `forge normalize`).
        let target = fs::canonicalize(out_path).unwrap_or_else(|_| out_path.to_path_buf());
        write_atomic(&target, &bytes)?;
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

    fs::write(&tmp, bytes).map_err(|e| {
        // Clean up a partial temp file so a disk-full / EIO failure doesn't
        // leak a dot-prefixed artifact in the spec's directory across runs.
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", tmp.display())
    })?;
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
             `forge openapi overlay <spec> --overlay <overlay>` or add an `overlay` version key?"
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
pub fn print_reports(tagged: &[(PathBuf, Vec<apply::ActionReport>)]) {
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
