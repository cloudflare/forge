//! Tests for `--explain`: per-action diagnostics on stderr during overlay
//! apply, on both the `forge overlay` subcommand and the top-level `forge`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::common::{SPEC, dir, overlay, succeeded, text};

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

fn files(name: &str, spec: &str, ov: &str) -> (PathBuf, PathBuf) {
    let dir = dir(name);
    let spec_path = dir.join("spec.json");
    let ov_path = dir.join("overlay.json");
    fs::write(&spec_path, spec).unwrap();
    fs::write(&ov_path, ov).unwrap();
    (spec_path, ov_path)
}

/// A simple update reports `updated 1 node` on stderr.
#[test]
fn explain_update_reports_matched_and_mutated() {
    let (spec, ov) = files(
        "explain-update",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--explain"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("update"), "names the verb: {err}");
    assert!(err.contains("$.info"), "names the target: {err}");
    assert!(err.contains("updated 1 node"), "names the result: {err}");
    assert!(err.contains(":0"), "names the action index: {err}");
}

/// A target that matches nothing is reported as a no-op.
#[test]
fn explain_zero_match_action_reports_noop() {
    let (spec, ov) = files(
        "explain-noop",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/missing\"].get", "update": {"summary": "s"}}]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--explain"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("matched 0 nodes"), "no-op wording: {err}");
    assert!(err.to_lowercase().contains("no-op"), "no-op wording: {err}");
}

/// An overlay with three actions emits three explain lines, in order.
#[test]
fn explain_multi_action_lists_each_action() {
    let (spec, ov) = files(
        "explain-multi",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d"}},
    {"target": "$.info", "update": {"summary": "s"}},
    {"target": "$.paths[\"/missing\"].get", "update": {"summary": "x"}}
  ]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--explain"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    let lines: Vec<&str> = err.lines().filter(|l| l.contains(':')).collect();
    assert_eq!(lines.len(), 3, "three explain lines: {err}");
    let i0 = err.find(":0").unwrap();
    let i1 = err.find(":1").unwrap();
    let i2 = err.find(":2").unwrap();
    assert!(i0 < i1 && i1 < i2, "action indices in order: {err}");
}

/// A copy action reports both the source and target paths.
#[test]
fn explain_copy_reports_source() {
    let (spec, ov) = files(
        "explain-copy",
        SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"]", "copy": "$.paths[\"/a\"].get"}]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--explain"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("copy"), "names verb: {err}");
    // Both the source and the target JSONPath strings appear in the line.
    assert!(err.contains("$.paths[\"/a\"].get"), "names source: {err}");
    assert!(err.contains("$.paths[\"/a\"]"), "names target: {err}");
}

/// A remove action reports a removed-count.
#[test]
fn explain_remove_reports_count() {
    // Two operations under /a, then a remove that matches both.
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {"operationId": "aGet", "responses": {"200": {"description": "ok"}}},
      "post": {"operationId": "aPost", "responses": {"200": {"description": "ok"}}}
    }
  }
}"#;
    let (spec_path, ov) = files(
        "explain-remove",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"][\"get\",\"post\"]", "remove": true}]
}"#,
    );
    let out = overlay(
        &[
            spec_path.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--explain",
        ],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("remove"), "names verb: {err}");
    assert!(err.contains("removed 2 nodes"), "removed-count: {err}");
}

/// An overlay with a `$ref` reusable action reports `ref=<name>`.
#[test]
fn explain_ref_action_names_component() {
    let (spec, ov) = files(
        "explain-ref",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "setDescription": {"fields": {"update": {"description": "d"}}}
    }
  },
  "actions": [{"$ref": "#/components/actions/setDescription", "target": "$.info"}]
}"##,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--explain"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(
        err.contains("ref=setDescription"),
        "names the component by `ref=`: {err}"
    );
    assert!(err.contains("update"), "names the verb: {err}");
}

/// Top-level `forge <spec> --overlay ov --target ts --out dir --explain`
/// generates the SDK AND writes the action report to stderr.
#[test]
fn explain_top_level_generator_prints_to_stderr() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("explain").join("top-level");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // The spec needs x-forge-* so the TS generator can produce code.
    let spec_text = r#"{
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
    let spec = dir.join("spec.json");
    fs::write(&spec, spec_text).unwrap();
    let ov = dir.join("ov.json");
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
            "--explain",
        ],
        "",
    );
    succeeded(&out);
    assert!(out.stdout.is_empty(), "stdout empty: {}", text(&out.stdout));
    let err = text(&out.stderr);
    assert!(err.contains("update"), "stderr has explain line: {err}");
    assert!(err.contains("$.info"), "stderr names target: {err}");
    assert!(
        out_dir.join("index.ts").is_file(),
        "generator still produced SDK: {}",
        out_dir.display()
    );
}
