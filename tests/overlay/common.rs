//! Shared helpers for `forge overlay` tests: process invocation, temp dirs,
//! and the two short documents the tests apply overlays to.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// The minimal OpenAPI document the tests overlay, with one GET operation
/// under `/a`. Pretty-printed with two-space indentation.
pub const SPEC: &str = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;

/// The same document on one line with no final newline, for byte-fidelity
/// checks.
pub const SPEC_MINIFIED: &str =
    r#"{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"operationId":"aGet","responses":{"200":{"description":"ok"}}}}}}"#;

/// A folder of its own to write files in for one test, which is empty when
/// returned.
pub fn dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("overlay").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs `forge overlay` with `args`, writing `stdin` to the process.
pub fn overlay(args: &[&str], stdin: &str) -> Output {
    forge(&[&["overlay"][..], args].concat(), stdin)
}

/// Runs `forge` with `args`, writing `stdin` to the process.
pub fn forge(args: &[&str], stdin: &str) -> Output {
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

/// Writes `spec` and `overlay` into `name`'s temp dir, and returns their
/// paths. The spec is `spec.json` and the overlay is `overlay.json`.
pub fn files(name: &str, spec: &str, overlay: &str) -> (PathBuf, PathBuf) {
    let dir = dir(name);
    let spec_path = dir.join("spec.json");
    let overlay_path = dir.join("overlay.json");
    fs::write(&spec_path, spec).unwrap();
    fs::write(&overlay_path, overlay).unwrap();
    (spec_path, overlay_path)
}

/// Writes `spec` and `overlay` into `name`'s temp dir with explicit file
/// extensions (e.g. `"yaml"` or `"json"`), and returns their paths.
pub fn files_ext(name: &str, spec: (&str, &str), overlay: (&str, &str)) -> (PathBuf, PathBuf) {
    let dir = dir(name);
    let spec_path = dir.join(format!("spec.{}", spec.1));
    let overlay_path = dir.join(format!("overlay.{}", overlay.1));
    fs::write(&spec_path, spec.0).unwrap();
    fs::write(&overlay_path, overlay.0).unwrap();
    (spec_path, overlay_path)
}

/// Applies `overlay_doc` to `SPEC` by writing both to a fresh temp dir and
/// running `forge overlay <spec> --overlay <overlay>`, returning the parsed
/// stdout JSON. Panics if the command fails.
pub fn apply(name: &str, overlay_doc: &str) -> serde_json::Value {
    let (spec_path, overlay_path) = files(name, SPEC, overlay_doc);
    let out = overlay(&[spec_path.to_str().unwrap(), "--overlay", overlay_path.to_str().unwrap()], "");
    succeeded(&out);
    serde_json::from_slice(&out.stdout).expect("stdout is JSON")
}

pub fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap()
}

#[track_caller]
pub fn succeeded(out: &Output) {
    assert!(out.status.success(), "forge failed: {}", text(&out.stderr));
}

#[track_caller]
pub fn failed(out: Output) -> String {
    assert!(!out.status.success(), "forge succeeded, stdout: {}", text(&out.stdout));
    String::from_utf8(out.stderr).unwrap()
}
