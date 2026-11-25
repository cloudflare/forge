//! `forge openapi overlay`, which applies one or more OpenAPI Overlay documents
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

pub use document::Document;
use document::Format;
use parsed::Overlay;

/// Arguments to `forge openapi overlay`.
#[derive(clap::Args)]
pub struct Args {
    /// With one positional, treat it as an overlay whose `extends` names the
    /// spec to apply to. With two or more positionals, treat the first as the
    /// OpenAPI spec (or `-` for standard input) and the rest as overlays to
    /// apply in order.
    inputs: Vec<PathBuf>,
    /// Write the overlaid result to PATH. Without this flag the result is
    /// printed to standard output. If PATH is the same file as the spec, it is
    /// rewritten atomically (temp file + rename) and left byte-identical when
    /// no action mutated it.
    #[arg(short = 'o', long = "out", value_name = "PATH")]
    out: Option<PathBuf>,
}

pub fn run(args: Args) -> Result<(), Err> {
    let Some((first, rest)) = args.inputs.split_first() else {
        return Err(
            "no input given; `forge openapi overlay` requires an overlay or a spec. \
             Usage: forge openapi overlay <overlay>   (overlay's `extends` names the spec)\n\
             \x20      forge openapi overlay <spec> <overlay>..."
                .into(),
        );
    };
    let doc = if rest.is_empty() {
        apply_extends(first, None)?
    } else {
        apply_to_spec(first, rest)?
    };
    emit(&doc, args.out.as_deref(), doc.source_path())
}

/// Mode A: parse `overlay_path` as an overlay, resolve its `extends` to a local
/// spec file, enforce the 1.2 `$self`/`extends` identity check, and apply it.
/// When `preloaded` is `Some`, those bytes are used instead of re-reading
/// `overlay_path` from disk.
pub fn apply_extends(overlay_path: &Path, preloaded: Option<Vec<u8>>) -> Result<Document, Err> {
    let bytes = match preloaded {
        Some(bytes) => bytes,
        None => read_file(overlay_path)?,
    };
    let format = Format::sniff(&bytes);

    // Parse once: check top-level keys first so an OpenAPI spec passed in
    // Mode A gets the disambiguation hint rather than an "unknown key" error.
    let (raw_value, _) =
        document::parse_value(&bytes, format, "overlay as ").map_err(|e| format!("{}: {e}", overlay_path.display()))?;
    if let Some(obj) = raw_value.as_object()
        && !obj.contains_key("overlay")
    {
        return Err(disambiguation_error(overlay_path, &bytes));
    }
    let overlay = Overlay::from_value(&raw_value).map_err(|e| format!("{}: {e}", overlay_path.display()))?;
    overlay.diagnose_warnings();

    let extends = overlay
        .extends()
        .ok_or_else(|| "overlay has no `extends`: nothing names the spec to apply to".to_owned())?;

    // Overlay retrieval URI drives base-URI resolution; $self (per 1.2 rules)
    // is resolved against it, then extends against $self.
    let retrieval = retrieval_base_uri(overlay_path)?;
    let base = overlay.resolve_base_uri(&retrieval)?;
    let spec_uri = uri::resolve_reference(&base, extends)
        .map_err(|e| format!("cannot resolve extends {extends:?} against {base}: {e}"))?;
    let spec_path = uri::to_path(&spec_uri)
        .map_err(|e| format!("extends resolves to {spec_uri}, which is not a local file: {e}"))?;
    crate::log::debug!(
        "{}: extends {extends:?} -> {}",
        overlay_path.display(),
        spec_path.display()
    );

    let spec_bytes = fs::read(&spec_path).map_err(|e| format!("{}: {e}", spec_path.display()))?;
    let mut doc = parse_spec_document(&spec_path, &spec_bytes)?;

    // 1.2 §Base URI rule 5: even though `extends` chose the file we loaded,
    // the spec may declare a `$self` identifier that disagrees (e.g. a URN) —
    // in which case the overlay was authored against a different document.
    overlay
        .check_extends_identity(&spec_uri, &doc)
        .map_err(|e| format!("{}: {e}", overlay_path.display()))?;

    let reports = overlay.with_base_uri(Some(base)).apply(&mut doc)?;
    log_reports(overlay_path, &reports);
    Ok(doc)
}

/// Mode B: load `spec_path` (or `-` for stdin), validate all `overlay_paths`
/// up front, and apply them in order.
fn apply_to_spec(spec_path: &Path, overlay_paths: &[PathBuf]) -> Result<Document, Err> {
    let spec_bytes = read_file(spec_path)?;
    let mut doc = parse_spec_document(spec_path, &spec_bytes)?;
    apply_overlays_to_doc(&mut doc, overlay_paths)?;
    Ok(doc)
}

/// Parses `bytes` as an OpenAPI document and attaches its canonical retrieval
/// base URI (so relative `$ref`s inserted by overlays stay relative to the
/// spec) and on-disk source path (for in-place `--out` detection).
fn parse_spec_document(spec_path: &Path, bytes: &[u8]) -> Result<Document, Err> {
    let format = Format::sniff(bytes);
    let is_stdin = spec_path == Path::new("-");
    let display = if is_stdin {
        "stdin".to_owned()
    } else {
        spec_path.display().to_string()
    };
    let spec_base = retrieval_base_uri(spec_path).map_err(|e| format!("{display}: {e}"))?;
    let source_path = (!is_stdin).then(|| spec_path.to_path_buf());
    Ok(Document::parse(bytes, format)
        .map_err(|e| format!("{display}: {e}"))?
        .with_base_uri(Some(spec_base))
        .with_source_path(source_path))
}

/// Compute the retrieval URI for a spec or overlay path: a `file:` URI for a
/// real file, or a trailing-slash CWD `file:` directory URI for stdin (so
/// relative references resolve against CWD without inventing a sentinel
/// filename that could collide with a real file). Errors when the path can't
/// be expressed as a URI (non-UTF-8 bytes, unreadable CWD) rather than
/// silently returning None — a missing base disables `$ref` rebasing and leaks
/// absolute `file:///…` URIs into the merged output.
fn retrieval_base_uri(path: &Path) -> Result<String, Err> {
    if path == Path::new("-") {
        let cwd = std::env::current_dir().map_err(|e| format!("cannot read current directory: {e}"))?;
        let cwd = fs::canonicalize(&cwd)
            .map_err(|e| format!("cannot canonicalize current directory {}: {e}", cwd.display()))?;
        let mut dir_uri = uri::from_path(&cwd)?;
        if !dir_uri.ends_with('/') {
            dir_uri.push('/');
        }
        Ok(dir_uri)
    } else {
        uri::from_path(path)
    }
}

/// Load, validate, and apply `overlay_paths` to `doc` in order. All overlays
/// are parsed first so a bad one fails the chain before any mutation. The
/// 1.2 `$self`/`extends` identity check runs against the target doc's current
/// `$self`.
fn apply_overlays_to_doc(doc: &mut Document, overlay_paths: &[PathBuf]) -> Result<(), Err> {
    // Load and parse all overlays first (transactional validation).
    let mut parsed = Vec::with_capacity(overlay_paths.len());
    for p in overlay_paths {
        let bytes = read_file(p)?;
        let ov = Overlay::parse(&bytes, Format::sniff(&bytes)).map_err(|e| format!("{}: {e}", p.display()))?;
        ov.diagnose_warnings();

        // Track the overlay's resolved base URI so apply can rebase relative
        // `$ref`s inside inserted content against it. Computed from the
        // overlay's retrieval URI, then resolved through any `$self`.
        let retrieval = retrieval_base_uri(p)?;
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
    for (ov, path) in parsed.iter().zip(overlay_paths.iter()) {
        let reports = ov.apply(doc)?;
        log_reports(path, &reports);
    }
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
        // Preserve bytes and mtime on a no-op, matching `forge normalize`.
        // Any other --out path still gets written even on a no-op, because
        // the user asked for output there.
        if !doc.mutated() {
            return Ok(());
        }
        let bytes = doc.to_bytes()?;
        // Follow symlinks so an in-place rewrite through a symlink keeps the
        // link intact and atomically replaces its target (matching `forge normalize`).
        let target = fs::canonicalize(out_path).unwrap_or_else(|_| out_path.to_path_buf());
        crate::file::replace_in_place(&target, &bytes).map_err(|e| format!("{}: {e}", out_path.display()))?;
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

fn disambiguation_error(path: &Path, bytes: &[u8]) -> Err {
    let shown = path.display();
    match crate::detect::detect(bytes) {
        crate::detect::SpecKind::OpenApi { .. } => format!(
            "{shown}: looks like an OpenAPI spec, not an Overlay document. Did you mean \
             `forge openapi overlay <spec> <overlay>` or add an `overlay` version key?"
        )
        .into(),
        other => match other.family_name() {
            Some(name) => {
                let article = if matches!(name.as_bytes().first(), Some(b'A' | b'E' | b'I' | b'O' | b'U')) {
                    "an"
                } else {
                    "a"
                };
                format!(
                    "{shown}: looks like {article} {name} document, not an Overlay document. \
                     Pass a single overlay document, or `<spec> <overlay>...`."
                )
                .into()
            }
            None => format!(
                "{shown}: not an overlay (missing `overlay` version key) and not an OpenAPI spec \
                 (missing `openapi` key). Pass a single overlay document, or `<spec> <overlay>...`."
            )
            .into(),
        },
    }
}

/// Log overlay action outcomes to stderr according to the active log level:
/// zero-match no-op actions and the per-overlay summary log at `info`, and
/// every matched action logs at `debug`.
fn log_reports(path: &Path, reports: &[apply::ActionReport]) {
    if !crate::log::enabled(crate::log::Level::Info) {
        return;
    }
    let shown = path.display();
    let mut mutated_actions = 0usize;
    for (i, r) in reports.iter().enumerate() {
        if r.mutated > 0 {
            mutated_actions += 1;
        }
        if r.matched == 0 {
            crate::log::info!("{shown}:{i} {}", r.format());
        } else {
            crate::log::debug!("{shown}:{i} {}", r.format());
        }
    }
    let total = reports.len();
    let noun = if total == 1 { "action" } else { "actions" };
    crate::log::info!("{shown}: applied {total} {noun} ({mutated_actions} mutated)");
}
