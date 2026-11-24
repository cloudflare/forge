//! Tests the top-level `forge generate` CLI's overlay integration:
//!
//! - `forge generate` accepts self-contained inputs only: an OpenAPI spec, an
//!   overlay-with-`extends` (which resolves its spec, applies, then generates),
//!   or `-` for stdin (e.g. piped from `forge openapi overlay`).
//! - `--target` and `--out` are always required on `generate`.
//! - The `openapi overlay` subcommand prints the merged spec.

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

/// `forge generate <overlay-with-extends> --target ts --out <dir>` resolves
/// the overlay's `extends` to find the spec, applies the overlay, then runs
/// the generator against the merged document.
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
            "generate",
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

/// Overlay positional detection parses the complete document. Large action
/// payloads must not be mistaken for OpenAPI specs because an arbitrary
/// sniffing prefix ends before the document does.
#[test]
fn top_level_large_overlay_positional_generates_sdk() {
    let dir = dir("large-overlay-positional");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let overlay = format!(
        r#"{{
  "overlay": "1.1.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "spec.json",
  "x-padding": "{}",
  "actions": [{{"target": "$.info", "update": {{"description": "overlaid"}}}}]
}}"#,
        "x".repeat(70 * 1024)
    );
    let overlay_path = dir.join("overlay.json");
    fs::write(&overlay_path, overlay).unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            "generate",
            overlay_path.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(out_dir.join("index.ts").is_file(), "generator ran");
}

/// Overlay positional detection cannot rely on a bounded prefix. JSON and
/// YAML mapping key order is unconstrained, so `overlay:` may legally sit
/// past any fixed sniff window — and a truncated YAML prefix can parse
/// successfully, silently losing the `overlay:` key. The sniff must parse
/// the whole document.
#[test]
fn top_level_overlay_with_overlay_key_after_64kb_is_detected() {
    let dir = dir("overlay-key-after-64kb");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    // >64 KiB of leading YAML content (an `x-padding` string in `info`)
    // pushes the `overlay:` key past the historical 64 KiB sniff window.
    // Written as YAML so the prefix actually deserializes as a valid, if
    // smaller, mapping — the worst case the full-file sniff has to
    // defend against.
    let padding = "x".repeat(70 * 1024);
    let overlay_yaml = format!(
        "info:\n  title: fix\n  version: '1'\n  x-padding: '{padding}'\nextends: spec.json\nactions:\n  - target: $.info\n    update:\n      description: overlaid\noverlay: 1.1.0\n"
    );
    let overlay_path = dir.join("overlay.yaml");
    fs::write(&overlay_path, overlay_yaml).unwrap();
    let out_dir = dir.join("sdk");

    let out = forge(
        &[
            "generate",
            overlay_path.to_str().unwrap(),
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
        "generator ran — sniff detected the overlay key past the 64 KiB mark"
    );
}

/// Global `-vv` (`--log-level debug`) logs overlay execution on stderr when
/// `forge generate` processes a self-contained overlay (with `extends`).
#[test]
fn top_level_generate_overlay_logs_at_debug_level() {
    let dir = dir("generate-overlay-debug-log");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
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
            "generate",
            ov.to_str().unwrap(),
            "--target",
            "ts",
            "--out",
            out_dir.to_str().unwrap(),
            "-vv",
        ],
        "",
    );
    succeeded(&out);
    assert!(out_dir.join("index.ts").is_file(), "SDK was generated");
    let err = String::from_utf8(out.stderr).unwrap();
    assert!(err.contains("updated 1 node"), "debug log on stderr: {err}");
}

/// Composing `forge openapi overlay <spec> <a> <b>` into
/// `forge generate - --target ts --out <dir>` applies overlays in order and
/// generates the SDK from stdin.
#[test]
fn top_level_pipe_overlay_subcommand_into_generate_stdin() {
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

/// `forge generate <overlay-with-extends>` alone (no `--target`, no `--out`)
/// is rejected with a message that names the missing flags.
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

    let err = failed(forge(&["generate", overlay.to_str().unwrap()], ""));
    assert!(err.contains("--target"), "message names --target: {err}");
    assert!(err.contains("--out"), "message names --out: {err}");
}

/// `forge generate <spec>` with no flags is rejected and the message names
/// `--target`, same as any other missing-flag case.
#[test]
fn top_level_plain_spec_without_target_errors() {
    let dir = dir("plain-spec-no-target");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();

    let err = failed(forge(&["generate", spec.to_str().unwrap()], ""));
    assert!(err.contains("--target"), "message names --target: {err}");
}

/// Baseline: plain SDK generation (no overlay) still works through
/// `forge generate`.
#[test]
fn top_level_sdk_generation_without_overlay_still_works() {
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

/// The `overlay` subcommand prints the merged spec to stdout (or writes it
/// with `--out <FILE>`).
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
        &["openapi", "overlay", spec.to_str().unwrap(), ov.to_str().unwrap()],
        "",
    );
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}
