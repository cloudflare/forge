//! Tests for the `forge overlay` CLI surface:
//! Mode A (overlay drives the spec via `extends`), Mode B (spec given on the
//! CLI with one or more `--overlay`), `--out`, multiple overlays applied in
//! order, `extends` resolution and HTTP rejection, output byte-fidelity, and
//! IO failure modes (missing files, malformed documents).

use std::fs;

use crate::common::{SPEC, SPEC_MINIFIED, dir, failed, failed_with, files, files_ext, forge, overlay, succeeded, text};

// --- Mode A: overlay drives the spec via `extends` -----------------------

/// Mode A. `forge overlay <overlay>` with no `--overlay` reads the overlay,
/// resolves its `extends` to a local file (relative to the overlay's own
/// location), and prints the overlaid spec to stdout.
#[test]
fn mode_a_extends_relative_path() {
    let dir = dir("mode-a-relative");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    fs::write(
        dir.join("overlay.json"),
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let out = overlay(&[dir.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode A. `extends` with an absolute `file://` URI is honored.
#[test]
fn mode_a_extends_file_uri() {
    let dir = dir("mode-a-file-uri");
    let spec_path = dir.join("spec.json");
    fs::write(&spec_path, SPEC).unwrap();
    let file_uri = format!("file://{}", spec_path.display());
    fs::write(
        dir.join("overlay.json"),
        format!(
            r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{file_uri}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
        ),
    )
    .unwrap();

    let out = overlay(&[dir.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode A. `file://` URIs with percent-encoded path segments round-trip to
/// the same local file (RFC 3986 §2.1 — path characters may be
/// percent-encoded).
#[test]
fn mode_a_extends_file_uri_percent_encoded() {
    let dir = dir("mode-a-file-uri-encoded");
    // A real path with a space in it, written as `%20` in the URI.
    let subdir = dir.join("a b");
    fs::create_dir_all(&subdir).unwrap();
    let spec_path = subdir.join("spec.json");
    fs::write(&spec_path, SPEC).unwrap();
    let encoded = spec_path.display().to_string().replace(' ', "%20");
    let file_uri = format!("file://{encoded}");
    fs::write(
        dir.join("overlay.json"),
        format!(
            r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{file_uri}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
        ),
    )
    .unwrap();

    let out = overlay(&[dir.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode A. Mode A with no `extends` in the overlay is an error: there is no
/// spec to apply to.
#[test]
fn mode_a_without_extends_is_rejected() {
    let dir = dir("mode-a-no-extends");
    fs::write(
        dir.join("overlay.json"),
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    failed_with(
        overlay(&[dir.join("overlay.json").to_str().unwrap()], ""),
        &["extends", "spec"],
    );
}

/// Mode A. `extends` with an `http://` or `https://` URL is a hard error for
/// security: we never fetch over the network.
#[test]
fn mode_a_extends_http_is_rejected() {
    for scheme in ["http", "https"] {
        let dir = dir(&format!("mode-a-{scheme}"));
        fs::write(
            dir.join("overlay.json"),
            format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{scheme}://example.com/openapi.json",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        )
        .unwrap();

        let err = failed_with(
            overlay(&[dir.join("overlay.json").to_str().unwrap()], ""),
            &["http", "extends", "network", "remote"],
        );
        assert!(err.to_lowercase().contains("http"), "{scheme}: names the scheme: {err}");
    }
}

/// Mode A. `extends` pointing to a path that does not exist is an error that
/// names the path.
#[test]
fn mode_a_extends_missing_file_names_the_path() {
    let dir = dir("mode-a-missing");
    fs::write(
        dir.join("overlay.json"),
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./does-not-exist.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap()], ""));
    assert!(err.contains("does-not-exist.json"), "names the missing path: {err}");
}

/// Mode A. `extends` without a leading `./` — a bare filename — is also a
/// valid relative URI reference per RFC 3986 and is resolved against the
/// overlay file's directory. Matches the OAI `remove-server` fixture
/// convention.
#[test]
fn mode_a_extends_bare_filename() {
    let dir = dir("mode-a-bare-filename");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    fs::write(
        dir.join("overlay.json"),
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();

    let out = overlay(&[dir.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode A. `--out <path>` writes the applied result to that file, exactly as
/// it would have been printed to stdout. The `extends`-resolved spec on disk
/// is read-only: it is not the "spec file" for in-place purposes, because
/// Mode A has no spec file on the CLI to compare against.
#[test]
fn mode_a_out_writes_to_path() {
    let dir = dir("mode-a-out");
    fs::write(dir.join("spec.json"), SPEC).unwrap();
    fs::write(
        dir.join("overlay.json"),
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    )
    .unwrap();
    let out_path = dir.join("applied.json");

    // Stdout baseline.
    let stdout_run = overlay(&[dir.join("overlay.json").to_str().unwrap()], "");
    succeeded(&stdout_run);

    let out = overlay(
        &[
            dir.join("overlay.json").to_str().unwrap(),
            "--out",
            out_path.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(out.stdout.is_empty(), "nothing is printed when --out is given");
    assert_eq!(
        fs::read(&out_path).unwrap(),
        stdout_run.stdout,
        "--out file matches what stdout would have produced"
    );
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&out_path).unwrap()).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

// --- Mode B: spec on the CLI, one or more `--overlay` files --------------

/// Mode B. `forge overlay <spec> --overlay <overlay>` applies the overlay
/// and prints the result to stdout. The spec file is left untouched.
#[test]
fn mode_b_applies_and_prints() {
    let (spec, ov) = files(
        "mode-b-stdout",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let before = fs::read_to_string(&spec).unwrap();

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);

    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
    assert_eq!(
        fs::read_to_string(&spec).unwrap(),
        before,
        "the spec file was not touched"
    );
}

/// Mode B. The spec may be `-` to read from standard input.
#[test]
fn mode_b_spec_from_stdin() {
    let dir = dir("mode-b-stdin");
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

    let out = overlay(&["-", "--overlay", ov.to_str().unwrap()], SPEC);
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode B. A missing spec file is an error that names the missing path.
#[test]
fn mode_b_missing_spec_file_names_the_path() {
    let dir = dir("mode-b-missing-spec");
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

    let missing = dir.join("absent-spec.json");
    let err = failed(overlay(
        &[missing.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("absent-spec.json"), "names the missing path: {err}");
}

/// Mode B. A missing overlay file is an error that names the missing path.
#[test]
fn mode_b_missing_overlay_file_names_the_path() {
    let (spec, _ov) = files(
        "mode-b-missing-overlay",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let missing_overlay = spec.with_file_name("absent-overlay.json");

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", missing_overlay.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("absent-overlay.json"), "names the missing path: {err}");
}

/// Mode B. A malformed JSON spec is a parse error that names the file and
/// something about JSON.
#[test]
fn mode_b_malformed_json_spec_is_rejected() {
    let dir = dir("mode-b-bad-json-spec");
    let spec = dir.join("spec.json");
    fs::write(&spec, "{this is not json").unwrap();
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

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("spec.json"), "names the file: {err}");
    assert!(
        err.to_lowercase().contains("json") || err.to_lowercase().contains("parse"),
        "names the problem: {err}"
    );
}

/// Mode B. A malformed YAML spec is a parse error that names the file and
/// something about YAML.
#[test]
fn mode_b_malformed_yaml_spec_is_rejected() {
    let (spec, ov) = files_ext(
        "mode-b-bad-yaml-spec",
        ("key: [unclosed\n  - broken: : :\n", "yaml"),
        (
            "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
            "yaml",
        ),
    );

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("spec.yaml"), "names the file: {err}");
    assert!(
        err.to_lowercase().contains("yaml") || err.to_lowercase().contains("parse"),
        "names the problem: {err}"
    );
}

/// Mode B. A malformed JSON overlay is a parse error.
#[test]
fn mode_b_malformed_json_overlay_is_rejected() {
    let dir = dir("mode-b-bad-json-overlay");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let ov = dir.join("overlay.json");
    fs::write(&ov, "{not valid").unwrap();

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("overlay.json"), "names the overlay file: {err}");
    assert!(
        err.to_lowercase().contains("json") || err.to_lowercase().contains("parse"),
        "names the problem: {err}"
    );
}

/// Mode B. A malformed YAML overlay is a parse error.
#[test]
fn mode_b_malformed_yaml_overlay_is_rejected() {
    let (spec, ov) = files_ext(
        "mode-b-bad-yaml-overlay",
        (SPEC, "json"),
        ("overlay: [\n  bad: :\n", "yaml"),
    );

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(err.contains("overlay.yaml"), "names the overlay file: {err}");
    assert!(
        err.to_lowercase().contains("yaml") || err.to_lowercase().contains("parse"),
        "names the problem: {err}"
    );
}

/// Mode B. A file with no extension is read by content sniffing: if the
/// first non-whitespace byte is `{` or `[` it is JSON, otherwise YAML. This
/// test locks down content-based detection over extension-based.
#[test]
fn mode_b_extensionless_file_uses_content_detection() {
    let dir = dir("mode-b-no-extension");
    let spec = dir.join("openapi");
    fs::write(&spec, SPEC).unwrap();
    let ov = dir.join("fix");
    fs::write(
        &ov,
        "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
    )
    .unwrap();

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    // Spec started with `{`, so output is JSON regardless of the file name.
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode B. `--out <spec>` — the out path canonically equals the spec file —
/// rewrites the spec in place.
#[test]
fn mode_b_out_matching_spec_rewrites_in_place() {
    let (spec, ov) = files(
        "mode-b-out-in-place",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);

    let doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(&spec).unwrap()).unwrap();
    assert_eq!(doc["info"]["description"], "d");
    assert!(out.stdout.is_empty(), "nothing is printed when --out is given");
}

/// Mode B. `--out <spec>` on a YAML spec keeps the spec in YAML.
#[test]
fn mode_b_out_matching_spec_preserves_yaml_format() {
    let (spec, ov) = files_ext(
        "mode-b-out-yaml",
        ("openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n", "yaml"),
        (
            "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
            "yaml",
        ),
    );

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);

    let rewritten = fs::read_to_string(&spec).unwrap();
    assert!(
        !rewritten.trim_start().starts_with('{'),
        "spec stayed YAML: {rewritten}"
    );
    assert!(rewritten.contains("description: d"), "overlay was applied: {rewritten}");
}

/// Mode B. `--out <other-path>` writes the applied result to a new file and
/// leaves the original spec byte-identical (and with its mtime unchanged).
#[test]
fn mode_b_out_to_different_path() {
    let (spec, ov) = files(
        "mode-b-out-other",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let before_bytes = fs::read(&spec).unwrap();
    let before_mtime = fs::metadata(&spec).unwrap().modified().unwrap();
    let out_path = spec.with_file_name("applied.json");

    // Stdout baseline for byte-equality.
    let stdout_run = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&stdout_run);

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            out_path.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert!(out.stdout.is_empty(), "nothing is printed when --out is given");
    assert_eq!(
        fs::read(&out_path).unwrap(),
        stdout_run.stdout,
        "--out file matches stdout output"
    );
    assert_eq!(fs::read(&spec).unwrap(), before_bytes, "original spec bytes preserved");
    assert_eq!(
        fs::metadata(&spec).unwrap().modified().unwrap(),
        before_mtime,
        "original spec mtime preserved"
    );
}

/// Mode B. `--out ./no/such/dir/out.yaml` fails cleanly without creating
/// anything.
#[test]
fn mode_b_out_to_nonexistent_parent_is_an_error() {
    let (spec, ov) = files(
        "mode-b-out-bad-parent",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    let bogus = spec.with_file_name("no").join("such").join("dir").join("out.yaml");

    let err = failed(overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            bogus.to_str().unwrap(),
        ],
        "",
    ));
    assert!(err.contains("out.yaml") || err.contains("no"), "names the path: {err}");
    assert!(!bogus.exists(), "out file was not created");
}

/// Mode B. `--out <spec>` is transactional: if any overlay fails to apply,
/// the spec file is left byte-identical and nothing is written to stdout. The
/// first overlay is valid and _would_ change the spec on its own; the
/// second has an invalid `target` that is rejected at apply time.
#[test]
fn mode_b_out_matching_spec_atomic_on_failure() {
    let dir = dir("mode-b-out-transactional");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let before = fs::read(&spec).unwrap();

    let good = dir.join("1.json");
    fs::write(
        &good,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "a", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "would-be-applied"}}]
}"#,
    )
    .unwrap();
    let bad = dir.join("2.json");
    fs::write(
        &bad,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "b", "version": "1"},
  "actions": [{"target": "$.info.title", "update": {"nope": "primitive-target"}}]
}"#,
    )
    .unwrap();

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            good.to_str().unwrap(),
            "--overlay",
            bad.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    let _ = failed(out.clone());
    assert_eq!(
        fs::read(&spec).unwrap(),
        before,
        "spec file is byte-identical on failure"
    );
    assert!(
        out.stdout.is_empty(),
        "no partial result on stdout: {}",
        text(&out.stdout)
    );
}

/// Mode B. `--out <spec>` with a no-op overlay (nothing mutated) skips the
/// write entirely, leaving the spec file byte-identical AND mtime-identical.
#[test]
fn mode_b_out_matching_spec_skips_write_on_noop() {
    let dir = dir("mode-b-out-noop");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC_MINIFIED).unwrap();
    let before = fs::read(&spec).unwrap();
    let before_mtime = fs::metadata(&spec).unwrap().modified().unwrap();

    let ov = dir.join("overlay.json");
    fs::write(
        &ov,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/missing\"].get", "update": {"summary": "s"}}]
}"#,
    )
    .unwrap();

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            spec.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    assert_eq!(fs::read(&spec).unwrap(), before, "bytes preserved on no-op");
    assert_eq!(
        fs::metadata(&spec).unwrap().modified().unwrap(),
        before_mtime,
        "mtime preserved on no-op (the write was skipped entirely)"
    );
}

/// Mode B. `-` for the spec + `--out <path>` writes the overlaid stdin spec
/// to the given path. There is no "spec file" to compare against, so the
/// path is simply written.
#[test]
fn stdin_spec_with_out_writes_to_path() {
    let dir = dir("stdin-out");
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
    let out_path = dir.join("applied.json");

    let out = overlay(
        &[
            "-",
            "--overlay",
            ov.to_str().unwrap(),
            "--out",
            out_path.to_str().unwrap(),
        ],
        SPEC,
    );
    succeeded(&out);
    assert!(out.stdout.is_empty(), "nothing is printed when --out is given");
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&out_path).unwrap()).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode B. `extends` in the overlay is ignored when a spec is on the CLI,
/// and the referenced file is NOT read — not even for validation. We prove
/// it by pointing `extends` at a path that does not exist and seeing the
/// command still succeed. Whether forge logs an info line about the
/// ignored extends is a style choice we deliberately don't pin.
#[test]
fn mode_b_extends_is_ignored_without_resolving() {
    let (spec, ov) = files(
        "mode-b-extends-ignored",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./does-not-exist-anywhere.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

// --- J1. Multiple `--overlay` files applied in order --------------------

#[test]
fn j1_multiple_overlays_apply_in_order() {
    let dir = dir("j1-two-overlays");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let first = dir.join("1.json");
    let second = dir.join("2.json");
    fs::write(
        &first,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "a", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "from-first"}}]
}"#,
    )
    .unwrap();
    fs::write(
        &second,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "b", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "from-second"}}]
}"#,
    )
    .unwrap();

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            first.to_str().unwrap(),
            "--overlay",
            second.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "from-second");
}

/// J1 (continued). The second overlay observes the mutations from the
/// first — including a prior removal followed by recreation. This rules
/// out any "apply each overlay independently and merge" strategy.
#[test]
fn j1_second_overlay_observes_first_removal_and_recreation() {
    let dir = dir("j1-remove-recreate-across-overlays");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();

    let first = dir.join("1.json");
    fs::write(
        &first,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "a", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get", "remove": true}]
}"#,
    )
    .unwrap();
    let second = dir.join("2.json");
    // This overlay would be a no-op by itself (nothing to update). It only
    // matches because the first overlay removed `get`, so updating `/a`
    // adds a fresh `get`.
    fs::write(
        &second,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "b", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"]", "update": {"get": {"operationId": "reborn", "responses": {"200": {"description": "ok"}}}}}]
}"#,
    )
    .unwrap();

    let out = overlay(
        &[
            spec.to_str().unwrap(),
            "--overlay",
            first.to_str().unwrap(),
            "--overlay",
            second.to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["paths"]["/a"]["get"]["operationId"], "reborn");
}

// --- K. Output fidelity -------------------------------------------------

/// K1. A no-op overlay leaves the document byte-identical.
#[test]
fn k1_no_op_overlay_preserves_bytes() {
    let (spec, ov) = files(
        "k1-noop",
        SPEC_MINIFIED,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/missing\"].get", "update": {"summary": "s"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    assert_eq!(text(&out.stdout), SPEC_MINIFIED, "bytes preserved on no-op");
}

/// K2. Keys that were there stay in order; keys added by `update` appear
/// after the existing ones in their object.
#[test]
fn k2_key_order_is_preserved_and_additions_append() {
    let doc_bytes = {
        let (spec, ov) = files(
            "k2-key-order",
            SPEC,
            r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
        );
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        succeeded(&out);
        out.stdout
    };

    let text_out = std::str::from_utf8(&doc_bytes).unwrap();
    let title_pos = text_out.find("\"title\"").unwrap();
    let version_pos = text_out.find("\"version\"").unwrap();
    let description_pos = text_out.find("\"description\"").unwrap();
    assert!(title_pos < version_pos, "title stayed before version");
    assert!(version_pos < description_pos, "added key appended after existing ones");
}

// --- CLI argument parsing ------------------------------------------------

/// `forge overlay` is a recognized subcommand.
#[test]
fn subcommand_is_recognized() {
    let out = forge(&["overlay", "--help"], "");
    assert!(out.status.success(), "help failed: {}", text(&out.stderr));
    assert!(
        text(&out.stdout).to_lowercase().contains("overlay"),
        "{}",
        text(&out.stdout)
    );
}

/// At least one input must be given.
#[test]
fn no_input_is_rejected() {
    let err = failed(overlay(&[], ""));
    assert!(
        err.to_lowercase().contains("required") || err.to_lowercase().contains("usage: forge overlay"),
        "names the missing argument: {err}"
    );
}

/// `forge overlay` without `--overlay` treats the positional as an overlay
/// document. A positional that is not an overlay (e.g. an OpenAPI spec) is
/// rejected with a message pointing authors at `--overlay` or at adding an
/// `overlay` version key to their file. The exact suggested-fix wording is
/// intentionally loose; any phrasing that names `--overlay` or references
/// the missing `overlay` version key counts.
#[test]
fn positional_that_is_not_an_overlay_is_rejected() {
    let dir = dir("positional-is-spec");
    let spec_file = dir.join("spec.json");
    fs::write(&spec_file, SPEC).unwrap();

    failed_with(
        overlay(&[spec_file.to_str().unwrap()], ""),
        &["not an overlay", "--overlay", "overlay version", "overlay: ", "missing"],
    );
}

/// A positional that is neither an OpenAPI spec nor an Overlay document
/// (e.g. unrelated JSON) is rejected with a message that names both
/// possibilities, so authors know what the subcommand expected.
#[test]
fn positional_that_is_neither_spec_nor_overlay_is_rejected() {
    let dir = dir("positional-neither");
    let other = dir.join("other.json");
    fs::write(&other, r#"{"some": "unrelated", "document": true}"#).unwrap();

    let err = failed_with(overlay(&[other.to_str().unwrap()], ""), &["overlay", "openapi"]);
    assert!(
        err.to_lowercase().contains("overlay") && err.to_lowercase().contains("openapi"),
        "message names both possibilities: {err}"
    );
}

/// Mode A takes exactly one positional (the overlay). Two positionals with
/// no `--overlay` is ambiguous and rejected — Mode A has no notion of
/// "apply multiple overlays," because its first positional carries the
/// `extends` link.
#[test]
fn mode_a_rejects_two_positionals() {
    let dir = dir("mode-a-two-positionals");
    let spec = dir.join("spec.json");
    fs::write(&spec, SPEC).unwrap();
    let first = dir.join("1.json");
    let second = dir.join("2.json");
    for p in [&first, &second] {
        fs::write(
            p,
            r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
        )
        .unwrap();
    }

    failed_with(
        overlay(&[first.to_str().unwrap(), second.to_str().unwrap()], ""),
        &["--overlay", "positional", "one"],
    );
}

// --- YAML input/output -------------------------------------------------

/// A YAML spec + YAML overlay produce a YAML result on stdout. The format
/// of the output matches the format of the spec, so an overlay that fixes
/// a YAML OpenAPI document stays in YAML.
#[test]
fn yaml_spec_with_yaml_overlay_prints_yaml() {
    let (spec, ov) = files_ext(
        "yaml-yaml",
        ("openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n", "yaml"),
        (
            "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
            "yaml",
        ),
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    let body = text(&out.stdout);
    assert!(
        body.contains("description: d"),
        "YAML output includes the added key: {body}"
    );
    assert!(!body.trim_start().starts_with('{'), "output is not JSON: {body}");
}

/// A JSON spec + YAML overlay produce JSON on stdout. The spec's format
/// wins; the overlay is parsed as YAML.
#[test]
fn json_spec_with_yaml_overlay_prints_json() {
    let (spec, ov) = files_ext(
        "json-yaml",
        (SPEC, "json"),
        (
            "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
            "yaml",
        ),
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// A YAML spec + JSON overlay produce YAML on stdout. The spec's format
/// wins.
#[test]
fn yaml_spec_with_json_overlay_prints_yaml() {
    let (spec, ov) = files_ext(
        "yaml-json",
        ("openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n", "yaml"),
        (
            r#"{"overlay": "1.0.0", "info": {"title": "fix", "version": "1"}, "actions": [{"target": "$.info", "update": {"description": "d"}}]}"#,
            "json",
        ),
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    let body = text(&out.stdout);
    assert!(body.contains("description: d"), "YAML output: {body}");
}

/// Mode A on a YAML overlay file: `extends` is resolved relative to the
/// overlay path, and the resulting spec is printed in the spec's own
/// format.
#[test]
fn mode_a_with_yaml_overlay_and_yaml_extends() {
    let dir = dir("mode-a-yaml");
    fs::write(
        dir.join("spec.yaml"),
        "openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n",
    )
    .unwrap();
    fs::write(
        dir.join("overlay.yaml"),
        "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nextends: ./spec.yaml\nactions:\n  - target: $.info\n    update:\n      description: d\n",
    )
    .unwrap();

    let out = overlay(&[dir.join("overlay.yaml").to_str().unwrap()], "");
    succeeded(&out);
    let body = text(&out.stdout);
    assert!(body.contains("description: d"), "{body}");
}
