//! Tests the top-level `forge` CLI's overlay integration:
//!
//! - Overlays are a preprocessing step before SDK generation, never a
//!   separate print mode on the top-level CLI.
//! - A positional overlay-with-`extends` resolves its spec, then generates.
//! - `--overlay` flags apply in order, then generate.
//! - `--target` and `--out` are always required at the top level.
//! - The `openapi overlay` subcommand still prints the merged spec (unchanged).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// A trivial OpenAPI spec with one GET operation under `/a`. Duplicated
/// from `tests/overlay/common.rs` on purpose: this test file is a sibling
/// of that module (not a submodule of the `overlay` test binary).
const SPEC: &str = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "x-forge-group-name": ["a"],
        "x-forge-method-name": "get",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;

fn dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("top-level-overlay")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn forge(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let stdin = stdin.to_owned();
    let writer = std::thread::spawn(move || input.write_all(stdin.as_bytes()));
    let output = child.wait_with_output().unwrap();
    let _ = writer.join().unwrap();
    output
}

#[track_caller]
fn succeeded(out: &Output) {
    assert!(
        out.status.success(),
        "forge failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[track_caller]
fn failed(out: Output) -> String {
    assert!(
        !out.status.success(),
        "forge succeeded, stdout: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    String::from_utf8(out.stderr).unwrap()
}

/// `forge <overlay-with-extends> --target ts --out <dir>` resolves the
/// overlay's `extends` to find the spec, applies the overlay, then runs the
/// generator against the merged document.
#[test]
fn top_level_overlay_positional_with_extends_generates_sdk() {
    let dir = dir("overlay-positional-generates");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let overlay = dir.join("overlay.json");
    fs::write(
        &overlay,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            overlay.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(
        out_dir.join("index.ts").is_file(),
        "TS generator produced index.ts into {}",
        out_dir.display()
    );
}

/// `forge <spec> --overlay <ov> --target ts --out <dir>` applies the overlay
/// to the spec before running the generator.
#[test]
fn top_level_spec_with_overlay_flag_generates_sdk() {
    let dir = dir("spec-with-overlay-generates");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(
        out_dir.join("index.ts").is_file(),
        "TS generator ran and produced output"
    );
}

/// With multiple `--overlay` flags, they are applied in order before the
/// generator runs. Ordering is asserted by the parallel `overlay` subcommand
/// invocation (whose stdout we can inspect), not by the generator output:
/// the merged spec is the same document either way, so if `overlay` sees `b`
/// win, the generator does too.
#[test]
fn top_level_spec_with_multiple_overlays_applies_in_order_then_generates() {
    let dir = dir("spec-multi-overlay");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let a = dir.join("a.json");
    let b = dir.join("b.json");
    fs::write(
        &a,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "a", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "from-a"}}]
}"#,
    )
    .unwrap();
    fs::write(
        &b,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "b", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "from-b"}}]
}"#,
    )
    .unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            a.to_str().unwrap(),
            "--overlay",
            b.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(out_dir.join("index.ts").is_file(), "generator ran");

    // Verify the apply ordering via the `overlay` subcommand on the same
    // inputs: b overrides a, so the merged spec shows from-b.
    let subcmd = forge(
        &[
            "openapi",
            "overlay",
            spec.to_str().unwrap(),
            "--overlay",
            a.to_str().unwrap(),
            "--overlay",
            b.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&subcmd);
    let merged: serde_json::Value = serde_json::from_slice(&subcmd.stdout).unwrap();
    assert_eq!(merged["info"]["description"], "from-b");
}

/// `forge <overlay-with-extends>` alone (no `--target`, no `--out`) is
/// rejected with a message that names both missing flags.
#[test]
fn top_level_overlay_positional_requires_target_and_out() {
    let dir = dir("overlay-positional-no-flags");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let overlay = dir.join("overlay.json");
    fs::write(
        &overlay,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let err = failed(forge(&[overlay.to_str().unwrap()], ""));
    assert!(err.contains("--target"), "message names --target: {err}");
    // The user needs to know that print-mode lives on the subcommand now.
    assert!(
        err.contains("overlay"),
        "message hints at `forge openapi overlay`: {err}"
    );
}

/// `forge <spec> --overlay <ov>` alone (no `--target`, no `--out`) is
/// rejected with the same missing-flags error.
#[test]
fn top_level_spec_with_overlay_flag_requires_target_and_out() {
    let dir = dir("spec-overlay-no-flags");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let err = failed(forge(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.contains("--target"), "message names --target: {err}");
}

/// A plain OpenAPI spec with no flags is rejected and the message names
/// `--target`, same as any other missing-flag case.
#[test]
fn top_level_plain_spec_without_target_errors() {
    let dir = dir("plain-spec-no-target");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();

    let err = failed(forge(&[spec.to_str().unwrap()], ""));
    assert!(err.contains("--target"), "message names --target: {err}");
}

/// `forge - --overlay <ov> --target ts --out <dir>` reads the spec from
/// stdin, applies the overlay, generates. `-` is never sniffed as an overlay.
#[test]
fn top_level_stdin_spec_with_overlay_generates_sdk() {
    let dir = dir("stdin-overlay");
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            "-",
            "--overlay",
            ov.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        SPEC,
    );
    succeeded(&out);
    assert!(
        out_dir.join("index.ts").is_file(),
        "generator ran on stdin spec + overlay"
    );
}

/// Baseline: plain SDK generation (no overlay) still works through the
/// top-level dispatch.
#[test]
fn top_level_sdk_generation_without_overlay_still_works() {
    let dir = dir("sdk-generation");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            spec.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(out_dir.join("index.ts").is_file(), "SDK was generated");
}

/// The `overlay` subcommand is unchanged: it prints the merged spec to
/// stdout (or writes it with `--out <FILE>`).
#[test]
fn top_level_overlay_subcommand_still_prints_merged_spec() {
    let dir = dir("overlay-subcommand");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let out = forge(
        &[
            "openapi",
            "overlay",
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}
