//! Tests for the `forge overlay` CLI surface:
//! Mode A (overlay drives the spec via `extends`), Mode B (spec given on the
//! CLI with one or more `--overlay`), `--write`, multiple overlays applied in
//! order, `extends` resolution and HTTP rejection, and output byte-fidelity.

use std::fs;

use crate::common::{SPEC, SPEC_MINIFIED, dir, failed, files, files_ext, forge, overlay, succeeded, text};

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

    let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap()], ""));
    assert!(err.to_lowercase().contains("extends"), "{err}");
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

        let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap()], ""));
        assert!(err.to_lowercase().contains("http"), "{scheme}: {err}");
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
    assert!(err.contains("does-not-exist.json"), "{err}");
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

/// Mode A. `--write` is not meaningful: we are not told which file to
/// rewrite (the overlay is input, the spec is pulled from `extends` and is
/// just read). Reject with a message that names `--overlay` as the way to
/// get the spec-on-CLI semantics that `--write` expects.
#[test]
fn mode_a_with_write_is_rejected() {
    let dir = dir("mode-a-write");
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

    let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap(), "--write"], ""));
    assert!(
        err.to_lowercase().contains("write") || err.to_lowercase().contains("--overlay"),
        "{err}"
    );
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
    assert_eq!(fs::read_to_string(&spec).unwrap(), before, "the spec file was not touched");
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

/// Mode B. `--write` rewrites the spec file in place.
#[test]
fn mode_b_write_rewrites_spec_in_place() {
    let (spec, ov) = files(
        "mode-b-write",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap(), "--write"], "");
    succeeded(&out);

    let doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(&spec).unwrap()).unwrap();
    assert_eq!(doc["info"]["description"], "d");
    assert!(out.stdout.is_empty(), "nothing is printed when --write is given");
}

/// Mode B. `--write` with `-` for the spec is an error: standard input is
/// not a file to rewrite.
#[test]
fn mode_b_write_with_stdin_is_rejected() {
    let dir = dir("mode-b-write-stdin");
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

    let err = failed(overlay(&["-", "--overlay", ov.to_str().unwrap(), "--write"], SPEC));
    assert!(err.to_lowercase().contains("write") || err.contains('-'), "{err}");
}

/// Mode B. `extends` in the overlay is ignored when a spec is on the CLI,
/// and an info-level message says so.
#[test]
fn mode_b_extends_is_ignored_with_info_log() {
    let (spec, ov) = files(
        "mode-b-extends-ignored",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./other-spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    assert!(
        text(&out.stderr).to_lowercase().contains("extends"),
        "info log mentions extends: {}",
        text(&out.stderr)
    );
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
    assert!(text(&out.stdout).to_lowercase().contains("overlay"), "{}", text(&out.stdout));
}

/// At least one input must be given.
#[test]
fn no_input_is_rejected() {
    let err = failed(overlay(&[], ""));
    assert!(err.to_lowercase().contains("required") || err.contains('<'), "{err}");
}

/// `forge overlay` without `--overlay` treats the positional as an overlay
/// document. A positional that is not an overlay (e.g. an OpenAPI spec) is
/// rejected with a message pointing authors at `--overlay` or at adding
/// `overlay: "1.0.0"` to their file.
#[test]
fn positional_that_is_not_an_overlay_is_rejected() {
    let dir = dir("positional-is-spec");
    let spec_file = dir.join("spec.json");
    fs::write(&spec_file, SPEC).unwrap();

    let err = failed(overlay(&[spec_file.to_str().unwrap()], ""));
    assert!(
        err.to_lowercase().contains("overlay") || err.to_lowercase().contains("not an overlay"),
        "{err}"
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

    let err = failed(overlay(&[other.to_str().unwrap()], ""));
    assert!(
        err.to_lowercase().contains("overlay") || err.to_lowercase().contains("openapi"),
        "message names what was expected: {err}"
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

    let err = failed(overlay(&[first.to_str().unwrap(), second.to_str().unwrap()], ""));
    assert!(
        err.to_lowercase().contains("unexpected")
            || err.to_lowercase().contains("one")
            || err.to_lowercase().contains("--overlay"),
        "{err}"
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
        (
            "openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n",
            "yaml",
        ),
        (
            "overlay: '1.0.0'\ninfo:\n  title: fix\n  version: '1'\nactions:\n  - target: $.info\n    update:\n      description: d\n",
            "yaml",
        ),
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    let body = text(&out.stdout);
    assert!(body.contains("description: d"), "YAML output includes the added key: {body}");
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
        (
            "openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n",
            "yaml",
        ),
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
    fs::write(dir.join("spec.yaml"), "openapi: 3.0.3\ninfo:\n  title: t\n  version: '1'\npaths: {}\n").unwrap();
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
