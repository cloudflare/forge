//! Tests for `forge overlay --check`: lint overlay documents without
//! resolving `extends` or applying to a spec.

use std::fs;

use crate::common::{SPEC, dir, failed, overlay, succeeded, text};

const VALID_1_0: &str = r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#;

/// A single valid overlay checks clean: exit 0, stdout and stderr empty.
#[test]
fn check_single_valid_overlay_exits_zero() {
    let dir = dir("check-valid-single");
    let ov = dir.join("overlay.json");
    fs::write(&ov, VALID_1_0).unwrap();

    let out = overlay(&["--check", ov.to_str().unwrap()], "");
    succeeded(&out);
    assert!(out.stdout.is_empty(), "no stdout: {}", text(&out.stdout));
    assert!(out.stderr.is_empty(), "no stderr: {}", text(&out.stderr));
}

/// A missing `info.title` fails lint; the file path is in the diagnostic.
#[test]
fn check_single_invalid_overlay_exits_nonzero() {
    let dir = dir("check-invalid-single");
    let ov = dir.join("broken.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let err = failed(overlay(&["--check", ov.to_str().unwrap()], ""));
    assert!(err.contains("broken.json"), "names the file: {err}");
    assert!(err.to_lowercase().contains("title"), "names the missing field: {err}");
}

/// Several valid files in one call all pass.
#[test]
fn check_multiple_valid_overlays() {
    let dir = dir("check-valid-multi");
    let a = dir.join("a.json");
    let b = dir.join("b.json");
    let c = dir.join("c.json");
    fs::write(&a, VALID_1_0).unwrap();
    fs::write(&b, VALID_1_0).unwrap();
    fs::write(&c, VALID_1_0).unwrap();

    let out = overlay(
        &["--check", a.to_str().unwrap(), b.to_str().unwrap(), c.to_str().unwrap()],
        "",
    );
    succeeded(&out);
    assert!(out.stderr.is_empty(), "no stderr: {}", text(&out.stderr));
}

/// When several files are given, every failing one is reported — not just
/// the first. CI should get every problem in one run.
#[test]
fn check_multiple_files_reports_all_problems() {
    let dir = dir("check-mixed");
    let valid = dir.join("good.json");
    let bad1 = dir.join("bad1.json");
    let bad2 = dir.join("bad2.json");
    fs::write(&valid, VALID_1_0).unwrap();
    // bad1: missing required `info`.
    fs::write(
        &bad1,
        r#"{
  "overlay": "1.0.0",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();
    // bad2: unknown top-level key.
    fs::write(
        &bad2,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "x", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}],
  "unknownkey": true
}"#,
    )
    .unwrap();

    let err = failed(overlay(
        &[
            "--check",
            valid.to_str().unwrap(),
            bad1.to_str().unwrap(),
            bad2.to_str().unwrap(),
        ],
        "",
    ));
    assert!(err.contains("bad1.json"), "reports bad1: {err}");
    assert!(err.contains("bad2.json"), "reports bad2: {err}");
}

/// `--check` + `--overlay` is a clean conflict error.
#[test]
fn check_rejects_overlay_flag() {
    let dir = dir("check-plus-overlay");
    let ov = dir.join("overlay.json");
    fs::write(&ov, VALID_1_0).unwrap();

    let out = overlay(
        &["--check", ov.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    );
    assert!(!out.status.success(), "command must fail");
    let err = text(&out.stderr).to_lowercase();
    assert!(
        err.contains("--overlay") || err.contains("cannot be used") || err.contains("conflict"),
        "names the conflict: {err}"
    );
}

/// `--check` + `--out` is a clean conflict error.
#[test]
fn check_rejects_out_flag() {
    let dir = dir("check-plus-out");
    let ov = dir.join("overlay.json");
    fs::write(&ov, VALID_1_0).unwrap();
    let out_path = dir.join("out.json");

    let out = overlay(
        &["--check", ov.to_str().unwrap(), "--out", out_path.to_str().unwrap()],
        "",
    );
    assert!(!out.status.success(), "command must fail");
    let err = text(&out.stderr).to_lowercase();
    assert!(
        err.contains("--out") || err.contains("cannot be used") || err.contains("conflict"),
        "names the conflict: {err}"
    );
}

/// `forge overlay --check -` lints one overlay from standard input.
#[test]
fn check_stdin() {
    let out = overlay(&["--check", "-"], VALID_1_0);
    succeeded(&out);
    assert!(out.stdout.is_empty(), "no stdout");
}

/// `extends` is not resolved during lint, so an overlay with a bogus extends
/// is still accepted when every other field is valid.
#[test]
fn check_does_not_fetch_extends() {
    let dir = dir("check-no-extends-fetch");
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./does-not-exist.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let out = overlay(&["--check", ov.to_str().unwrap()], "");
    succeeded(&out);
    // Shape: the real SPEC exists on disk in a different path, so we don't
    // need to touch it: the point is that the missing `extends` target is
    // ignored at lint time.
    let _ = SPEC;
}
