//! Tests composing `forge openapi overlay` with `forge generate`:
//!
//! - `forge generate` reads OpenAPI JSON documents only (from a path or `-`).
//! - Overlays compose into `forge generate` via piping (`forge openapi overlay ... | forge generate - ...`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// A trivial OpenAPI spec with one GET operation under `/a`.
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

/// Composing Mode A (`forge openapi overlay <overlay-with-extends>`) into
/// `forge generate - --target ts --out <dir>` resolves `extends`, applies the
/// overlay, and generates the SDK from stdin.
#[test]
fn pipe_mode_a_overlay_into_generate_stdin() {
    let dir = dir("pipe-mode-a-to-generate");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let overlay = dir.join("overlay.yaml");
    fs::write(
        &overlay,
        "overlay: 1.1.0\ninfo:\n  title: fix\n  version: '1'\nextends: ./spec.json\nactions:\n  - target: $.info\n    update:\n      description: overlaid\n",
    )
    .unwrap();
    let out_dir = dir.join("sdk");

    let overlaid = forge(&["openapi", "overlay", overlay.to_str().unwrap()], "");
    succeeded(&overlaid);
    let merged_str = std::str::from_utf8(&overlaid.stdout).unwrap();
    let merged: serde_json::Value = serde_json::from_str(merged_str).unwrap();
    assert_eq!(merged["info"]["description"], "overlaid");

    let generated = forge(
        &["generate", "-", "--target", "ts", "--out", out_dir.to_str().unwrap()],
        merged_str,
    );
    succeeded(&generated);
    assert!(out_dir.join("index.ts").is_file(), "generator ran on piped spec");
}

/// Composing Mode B (`forge openapi overlay <spec> <a> <b>`) into
/// `forge generate - --target ts --out <dir>` applies overlays in order and
/// generates the SDK from stdin.
#[test]
fn pipe_mode_b_overlay_into_generate_stdin() {
    let dir = dir("pipe-overlay-to-generate");
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

    let subcmd = forge(
        &[
            "openapi",
            "overlay",
            spec.to_str().unwrap(),
            a.to_str().unwrap(),
            b.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&subcmd);
    let merged_str = std::str::from_utf8(&subcmd.stdout).unwrap();
    let merged: serde_json::Value = serde_json::from_str(merged_str).unwrap();
    assert_eq!(merged["info"]["description"], "from-b");

    let generated = forge(
        &["generate", "-", "--target", "ts", "--out", out_dir.to_str().unwrap()],
        merged_str,
    );
    succeeded(&generated);
    assert!(out_dir.join("index.ts").is_file(), "generator ran on piped spec");
}

/// `forge generate` only accepts OpenAPI documents; passing an overlay
/// directly fails rather than implicitly applying it.
#[test]
fn generate_rejects_overlay_input_directly() {
    let dir = dir("generate-rejects-overlay");
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

    let err = failed(forge(
        &[
            "generate",
            overlay.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    ));
    assert!(err.contains("no openapi version"), "{err}");
}

/// Baseline: plain SDK generation works through `forge generate`.
#[test]
fn sdk_generation_without_overlay_still_works() {
    let dir = dir("sdk-generation");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            "generate",
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
