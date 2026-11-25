//! Tests for global logging (`--log-level`, `FORGE_LOG`) on
//! `forge openapi overlay`.

use std::fs;
use std::process::{Command, Stdio};

use crate::common::{SPEC, dir, failed, files, overlay, succeeded, text};

/// At `--log-level debug`, a simple update logs verb, target, index, and result.
#[test]
fn debug_update_logs_matched_and_mutated() {
    let (spec, ov) = files(
        "log-update",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "debug"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("update"), "names the verb: {err}");
    assert!(err.contains("$.info"), "names the target: {err}");
    assert!(err.contains("updated 1 node"), "names the result: {err}");
    assert!(err.contains(":0"), "names the action index: {err}");
}

/// At `--log-level info`, a zero-match target is logged as a no-op alongside
/// the per-overlay summary, while normal matched actions stay at `debug`.
#[test]
fn info_logs_zero_match_noop_and_summary_without_matched_action_details() {
    let (spec, ov) = files(
        "log-info-noop",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d"}},
    {"target": "$.paths[\"/missing\"].get", "update": {"summary": "s"}}
  ]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "info"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("matched 0 nodes"), "no-op wording at info: {err}");
    assert!(err.to_lowercase().contains("no-op"), "no-op wording at info: {err}");
    assert!(err.contains("applied 2 actions"), "summary at info: {err}");
    assert!(
        !err.contains("updated 1 node"),
        "matched action detail is debug-only: {err}"
    );
}

/// At `--log-level debug`, an overlay with three actions logs each action in order.
#[test]
fn debug_multi_action_logs_each_action_in_order() {
    let (spec, ov) = files(
        "log-multi",
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
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "debug"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    let i0 = err.find(":0 ").unwrap();
    let i1 = err.find(":1 ").unwrap();
    let i2 = err.find(":2 ").unwrap();
    assert!(i0 < i1 && i1 < i2, "action indices in order: {err}");
}

/// At `--log-level debug`, a copy action logs both the source and target paths.
#[test]
fn debug_copy_logs_source() {
    let (spec, ov) = files(
        "log-copy",
        SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"]", "copy": "$.paths[\"/a\"].get"}]
}"#,
    );
    let out = overlay(
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "debug"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("copy"), "names verb: {err}");
    assert!(err.contains("$.paths[\"/a\"].get"), "names source: {err}");
    assert!(err.contains("$.paths[\"/a\"]"), "names target: {err}");
}

/// At `--log-level debug`, a remove action logs the removed count.
#[test]
fn debug_remove_logs_count() {
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
        "log-remove",
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
            ov.to_str().unwrap(),
            "--log-level",
            "debug",
        ],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(err.contains("remove"), "names verb: {err}");
    assert!(err.contains("removed 2 nodes"), "removed-count: {err}");
}

/// At `--log-level debug`, an overlay with a `$ref` reusable action logs `ref=<name>`.
#[test]
fn debug_ref_action_names_component() {
    let (spec, ov) = files(
        "log-ref",
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
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "debug"],
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

/// A copy action whose target selects zero nodes is a no-op even when its
/// source is structured and the target's parent exists. Logging must report
/// the zero match without claiming a copy occurred.
#[test]
fn info_structured_copy_with_zero_target_logs_noop() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "components": {"x-contact": {"name": "Ada", "email": "ada@example.com"}},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;
    let (spec_path, ov) = files(
        "log-copy-zero-target",
        spec,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.contact", "copy": "$.components[\"x-contact\"]"}]
}"#,
    );
    let out = overlay(
        &[spec_path.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "info"],
        "",
    );
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(
        err.contains("matched 0 nodes"),
        "zero-match copy reports its actual cardinality: {err}"
    );
    assert!(err.contains("no-op"), "zero-match copy is reported as a no-op: {err}");
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(doc["info"].get("contact").is_none(), "target was not materialized");
}

/// Mode A (`forge openapi overlay <overlay-with-extends> --log-level debug`)
/// logs both `extends` resolution and per-action details.
#[test]
fn debug_mode_a_overlay_logs_extends_and_actions() {
    let dir = dir("log-mode-a");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    let ov = dir.join("ov.json");
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

    let out = overlay(&[ov.to_str().unwrap(), "--log-level", "debug"], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
    let err = text(&out.stderr);
    assert!(err.contains("extends"), "logs extends resolution: {err}");
    assert!(err.contains("update"), "logs action verb: {err}");
    assert!(err.contains("$.info"), "logs action target: {err}");
}

/// `--log-level error` suppresses `warn` messages such as future `1.x` minor
/// overlay version warnings.
#[test]
fn log_level_error_suppresses_warnings() {
    let (spec, ov) = files(
        "log-level-error",
        SPEC,
        r#"{
  "overlay": "1.9.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "error"],
        "",
    );
    succeeded(&out);
    assert!(out.stderr.is_empty(), "warnings suppressed: {}", text(&out.stderr));
}

/// An unrecognized `--log-level` lists the valid level names.
#[test]
fn invalid_log_level_lists_possible_values() {
    let (spec, ov) = files(
        "log-level-invalid",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let err = failed(overlay(
        &[spec.to_str().unwrap(), ov.to_str().unwrap(), "--log-level", "verbose"],
        "",
    ));
    assert!(err.contains("unrecognized log level"), "{err}");
    assert!(err.contains("error, warn, info, debug, trace"), "{err}");
}

/// `FORGE_LOG=debug` configures logging when no CLI flag is given.
#[test]
fn forge_log_env_enables_debug_logging() {
    let (spec, ov) = files(
        "log-env",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = Command::new(env!("CARGO_BIN_EXE_forge"))
        .env("FORGE_LOG", "debug")
        .args(["openapi", "overlay", spec.to_str().unwrap(), ov.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    succeeded(&out);
    let err = text(&out.stderr);
    assert!(
        err.contains("updated 1 node"),
        "FORGE_LOG=debug emitted debug log: {err}"
    );
}
