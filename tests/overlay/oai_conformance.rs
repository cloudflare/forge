//! Official OAI Overlay-Specification conformance tests.
//!
//! The upstream repo ships per-version corpora of overlay documents at
//! `tests/v{1.0,1.1,1.2-dev}/{pass,fail}/`. A `pass` file is a schema-valid
//! overlay that implementations MUST accept; a `fail` file is forbidden by
//! the spec and MUST be rejected. See `oai_tests/README.md` for the vendored
//! commit SHA.
//!
//! We invoke each as `forge overlay <trivial-spec> --overlay <test>` in
//! Mode B. Mode B ignores `extends`, so tests whose `extends` URIs point at
//! files we don't have still parse cleanly. For Mode-A-only documents (ones
//! that only make sense when their `extends` resolves) this layer still
//! verifies document-level schema conformance — apply-time semantics are
//! covered by the hand-written tests elsewhere in this directory.
//!
//! ## Discrimination of negative fixtures
//!
//! A rejection is only credit for the fixture if it is an overlay-level
//! schema error. We require the stderr to:
//!
//! 1. NOT contain any of the generic pre-implementation CLI diagnostics
//!    forge emits before `overlay` is a registered subcommand (identical
//!    guard to `common::failed`'s `PRE_IMPL_MARKERS`).
//! 2. NOT look like a target-OpenAPI parse error, a missing-file I/O
//!    failure, or a panic — those don't demonstrate that the overlay was
//!    rejected for the reason the fixture is about.
//! 3. Contain at least one overlay-schema marker (`overlay`, `action`,
//!    `target`, `$ref`, `extends`, `$self`, `fields`, `components`, or
//!    `update` / `copy` / `remove`), so we know forge examined the overlay
//!    itself rather than tripping on something else.
//!
//! When any of these conditions fails, we report the fixture name together
//! with the complete stdout and stderr, so a regression in the official
//! corpus is immediately debuggable.

use std::fs;
use std::path::{Path, PathBuf};

use crate::common::{SPEC, dir, overlay, text};

/// Strings forge emits for the pre-implementation CLI, not for an overlay
/// rejection. Mirrors `common::PRE_IMPL_MARKERS` (kept private there).
const PRE_IMPL_MARKERS: &[&str] = &[
    "cannot be used with '<SPEC>'",
    "the following required arguments were not provided",
    "unrecognized subcommand",
    "unexpected argument 'overlay'",
    "unexpected argument \"overlay\"",
];

/// Strings that indicate the error came from somewhere other than the
/// overlay validator — a missing file, a target-spec parser, a panic. If
/// one of these appears in a `fail` fixture's stderr we consider it a
/// false negative, not real conformance.
const NON_OVERLAY_ERROR_MARKERS: &[&str] = &[
    "panicked at",
    "stack backtrace",
    "no such file or directory",
    "is a directory",
    "permission denied",
    "openapi document",
    "openapi spec",
    "invalid openapi",
];

/// Overlay-schema markers. A real overlay-level rejection mentions at
/// least one of these.
const OVERLAY_MARKERS: &[&str] = &[
    "overlay",
    "action",
    "target",
    "update",
    "copy",
    "remove",
    "extends",
    "$self",
    "$ref",
    "fields",
    "components",
    "info.title",
    "info.version",
    "jsonpath",
    "json path",
    "rfc 9535",
];

fn scenario_files(version: &str, kind: &str) -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/overlay/oai_tests")
        .join(version)
        .join(kind);
    let mut paths: Vec<_> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read {root:?}: {e}"))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("yaml"))
        .collect();
    paths.sort();
    paths
}

fn spec_for(tag: &str) -> PathBuf {
    let d = dir(&format!("oai/{}", tag.replace(['/', ' ', '.'], "_")));
    let p = d.join("spec.json");
    fs::write(&p, SPEC).unwrap();
    p
}

fn run_pass(version: &str) {
    let mut failures: Vec<String> = vec![];
    for ov in scenario_files(version, "pass") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-pass-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        if !out.status.success() {
            failures.push(format!(
                "{name}\n  stdout:\n{}\n  stderr:\n{}",
                text(&out.stdout),
                text(&out.stderr)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} OAI {version}/pass scenarios were rejected (MUST be accepted):\n---\n{}\n---",
        failures.len(),
        failures.join("\n---\n")
    );
}

#[derive(Default)]
struct FailReport {
    unexpectedly_accepted: Vec<String>,
    pre_impl: Vec<String>,
    non_overlay_error: Vec<String>,
    no_overlay_marker: Vec<String>,
}

fn run_fail(version: &str) {
    let mut report = FailReport::default();

    for ov in scenario_files(version, "fail") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-fail-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        let stdout = text(&out.stdout).to_owned();
        let stderr = text(&out.stderr).to_owned();
        let lower = stderr.to_lowercase();

        if out.status.success() {
            report
                .unexpectedly_accepted
                .push(format!("{name}\n  stdout:\n{stdout}\n  stderr:\n{stderr}"));
            continue;
        }

        if PRE_IMPL_MARKERS.iter().any(|m| stderr.contains(m)) {
            report.pre_impl.push(name);
            continue;
        }

        if NON_OVERLAY_ERROR_MARKERS.iter().any(|m| lower.contains(m)) {
            report.non_overlay_error.push(format!("{name}\n  stderr:\n{stderr}"));
            continue;
        }

        if !OVERLAY_MARKERS.iter().any(|m| lower.contains(m)) {
            report.no_overlay_marker.push(format!("{name}\n  stderr:\n{stderr}"));
        }
    }

    assert!(
        report.unexpectedly_accepted.is_empty(),
        "{} OAI {version}/fail scenarios were accepted (MUST be rejected):\n---\n{}\n---",
        report.unexpectedly_accepted.len(),
        report.unexpectedly_accepted.join("\n---\n")
    );
    assert!(
        report.pre_impl.is_empty(),
        "{} OAI {version}/fail scenarios failed with the generic pre-implementation \
         CLI error, not an overlay-specific rejection. The `overlay` subcommand is \
         almost certainly unimplemented. Affected files:\n{}",
        report.pre_impl.len(),
        report.pre_impl.join("\n")
    );
    assert!(
        report.non_overlay_error.is_empty(),
        "{} OAI {version}/fail scenarios failed with a non-overlay error (panic, \
         I/O error, target OpenAPI parse error) — the overlay validator did not \
         reach a decision about the overlay itself. These must not be counted as \
         conformance. Affected files:\n---\n{}\n---",
        report.non_overlay_error.len(),
        report.non_overlay_error.join("\n---\n")
    );
    assert!(
        report.no_overlay_marker.is_empty(),
        "{} OAI {version}/fail scenarios failed with stderr that doesn't name any \
         overlay-schema concept — the overlay validator may not have examined the \
         document. Affected files:\n---\n{}\n---",
        report.no_overlay_marker.len(),
        report.no_overlay_marker.join("\n---\n")
    );
}

#[test]
fn oai_v1_0_pass() {
    run_pass("v1.0");
}

#[test]
fn oai_v1_0_fail() {
    run_fail("v1.0");
}

#[test]
fn oai_v1_1_pass() {
    run_pass("v1.1");
}

#[test]
fn oai_v1_1_fail() {
    run_fail("v1.1");
}

#[test]
fn oai_v1_2_pass() {
    run_pass("v1.2-dev");
}

#[test]
fn oai_v1_2_fail() {
    run_fail("v1.2-dev");
}
