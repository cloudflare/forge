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

use std::fs;
use std::path::{Path, PathBuf};

use crate::common::{SPEC, dir, overlay};

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
                "{name}:\n{}",
                std::str::from_utf8(&out.stderr).unwrap_or("<non-utf8>")
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

fn run_fail(version: &str) {
    let mut unexpectedly_accepted: Vec<String> = vec![];
    let mut pre_impl: Vec<String> = vec![];
    for ov in scenario_files(version, "fail") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-fail-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() {
            unexpectedly_accepted.push(name);
        } else if stderr.contains("cannot be used with '<SPEC>'") {
            // Pre-implementation generic Clap error — this corpus can't
            // discriminate until `forge overlay` exists.
            pre_impl.push(name);
        }
    }
    assert!(
        unexpectedly_accepted.is_empty(),
        "{} OAI {version}/fail scenarios were accepted (MUST be rejected):\n{}",
        unexpectedly_accepted.len(),
        unexpectedly_accepted.join("\n")
    );
    assert!(
        pre_impl.is_empty(),
        "{} OAI {version}/fail scenarios failed with the generic pre-implementation \
         CLI error, not an overlay-specific rejection. The `overlay` subcommand is \
         almost certainly unimplemented. Affected files:\n{}",
        pre_impl.len(),
        pre_impl.join("\n")
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
