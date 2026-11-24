//! Tests for overlay document validation (rules A1-A7 and H1):
//! required fields, invalid fields, the "target must select objects or
//! arrays" constraint from section 5, and the Overlay 1.1 policy.
//!
//! Every negative assertion goes through `failed_with(...)` so it cannot
//! pass against the current pre-implementation binary just because its
//! generic CLI error happens to contain a common word.

use crate::common::{SPEC, failed, failed_with, files, overlay};

// Markers that identify an overlay-document-level validation error. The
// implementation is free to pick exact wording; tests only require it to
// name one of these terms.
const DOC_MARKERS: &[&str] = &["overlay document", "overlay version", "overlay schema", "overlay:"];
const INFO_MARKERS: &[&str] = &["info.title", "info.version", "`info`", "info object", "\"info\""];
const ACTION_MARKERS: &[&str] = &["actions", "action", "\"actions\""];
const TARGET_MARKERS: &[&str] = &["target", "`target`", "\"target\""];
const REMOVE_MARKERS: &[&str] = &["remove", "`remove`", "\"remove\""];
const EXTENDS_MARKERS: &[&str] = &["extends", "`extends`", "\"extends\""];
const JSONPATH_MARKERS: &[&str] = &["jsonpath", "json path", "rfc 9535", "selector"];

/// Flattens several marker slices into a single `Vec<&str>` so it can be
/// handed to `failed_with`. Keeps call sites readable where the valid
/// markers span multiple categories.
fn markers<const N: usize>(groups: [&'static [&'static str]; N]) -> Vec<&'static str> {
    groups.iter().flat_map(|g| g.iter().copied()).collect()
}

/// A1. The overlay document MUST include an `overlay` version string.
#[test]
fn overlay_version_is_required() {
    let (spec, ov) = files(
        "missing-overlay-version",
        SPEC,
        r#"{
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &markers([DOC_MARKERS, &["missing", "required"]]),
    );
}

/// A1. `overlay` must be the 1.x version family. 2.0.0 is rejected with a
/// message that names the unsupported version.
#[test]
fn overlay_version_two_is_rejected() {
    let (spec, ov) = files(
        "overlay-version-2",
        SPEC,
        r#"{
  "overlay": "2.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let err = failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["unsupported", "version", "2.0"],
    );
    assert!(err.contains("2.0"), "names the unsupported major: {err}");
}

/// A1. `1.0.x`, `1.1.x`, and `1.2.x` are all fully supported and accepted
/// silently. Patch differences are ignored per section 3 of each spec.
#[test]
fn supported_overlay_versions_are_accepted_silently() {
    for version in ["1.0.0", "1.0.1", "1.1.0", "1.1.3", "1.2.0"] {
        let (spec, ov) = files(
            &format!("overlay-version-{version}"),
            SPEC,
            &format!(
                r#"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
        assert!(
            out.status.success(),
            "forge failed for {version}: {}",
            std::str::from_utf8(&out.stderr).unwrap()
        );
        let err = std::str::from_utf8(&out.stderr).unwrap();
        assert!(
            !err.to_lowercase().contains("warning") && !err.to_lowercase().contains("unsupported"),
            "{version} should not warn: {err}"
        );
    }
}

/// A1. A future `1.x` minor we don't know about yet is accepted with a
/// stderr warning: we still parse the document and apply the actions we
/// understand, but log that we may skip unknown features.
#[test]
fn future_overlay_minor_is_accepted_with_a_warning() {
    let (spec, ov) = files(
        "overlay-version-1-9",
        SPEC,
        r#"{
  "overlay": "1.9.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    assert!(
        out.status.success(),
        "forge failed: {}",
        std::str::from_utf8(&out.stderr).unwrap()
    );
    let err = std::str::from_utf8(&out.stderr).unwrap();
    assert!(
        err.to_lowercase().contains("1.9"),
        "warning mentions the version: {err}"
    );
    assert!(
        err.to_lowercase().contains("warn") || err.to_lowercase().contains("unsupported"),
        "{err}"
    );
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d", "the action was still applied");
}

/// A1. A malformed version string is rejected. The spec requires a
/// three-component semver-like string; `1`, `1.0`, and `1.0.0-beta` are
/// all malformed.
#[test]
fn malformed_overlay_version_is_rejected() {
    for bad in [
        "1",
        "1.0",
        "1.0.0-beta",
        "",
        "one",
        "01.00.00",
        "1.01.0",
        "1.0.00",
        "+1.0.0",
    ] {
        let (spec, ov) = files(
            &format!("bad-version-{}", bad.replace(['.', '-'], "_")),
            SPEC,
            &format!(
                r#"{{
  "overlay": "{bad}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([DOC_MARKERS, &["version"]]),
        );
    }
}

/// A1. `overlay` must be a string. A number, boolean, or null is rejected.
#[test]
fn non_string_overlay_version_is_rejected() {
    for bad in ["1.0", "true", "null"] {
        let (spec, ov) = files(
            &format!("non-string-version-{}", bad.replace('.', "_")),
            SPEC,
            &format!(
                r#"{{
  "overlay": {bad},
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["overlay", "string", "type"],
        );
    }
}

/// A2. `info.title` and `info.version` are both required.
#[test]
fn info_title_and_version_are_required() {
    for (name, info) in [
        ("missing-info-title", r#"{"version": "1"}"#),
        ("missing-info-version", r#"{"title": "fix"}"#),
        ("missing-info", r#"null"#),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {info},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            INFO_MARKERS,
        );
    }
}

/// A2. `info.title` and `info.version` must be strings.
#[test]
fn info_fields_must_be_strings() {
    for (name, info) in [
        ("info-title-number", r#"{"title": 1, "version": "1"}"#),
        ("info-version-number", r#"{"title": "t", "version": 1}"#),
        ("info-title-null", r#"{"title": null, "version": "1"}"#),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {info},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([INFO_MARKERS, &["string", "type"]]),
        );
    }
}

/// A3. `actions` is required and MUST contain at least one entry.
#[test]
fn actions_must_be_present_and_non_empty() {
    for (name, actions) in [("missing-actions", None), ("empty-actions", Some("[]"))] {
        let actions_line = actions.map(|a| format!(r#", "actions": {a}"#)).unwrap_or_default();
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}}{actions_line}
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            ACTION_MARKERS,
        );
    }
}

/// A3. `actions` must be an array, not an object or a scalar.
#[test]
fn actions_must_be_an_array() {
    for (name, actions) in [
        (
            "actions-object",
            r#"{"target": "$.info", "update": {"description": "d"}}"#,
        ),
        ("actions-null", "null"),
        ("actions-string", r#""fix""#),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": {actions}
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([ACTION_MARKERS, &["array", "type"]]),
        );
    }
}

/// A3. Each entry of `actions` must be an object.
#[test]
fn action_entries_must_be_objects() {
    let (spec, ov) = files(
        "action-entry-string",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": ["not an object"]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &markers([ACTION_MARKERS, &["object", "type"]]),
    );
}

/// A4. Each action requires a `target`.
#[test]
fn action_target_is_required() {
    let (spec, ov) = files(
        "missing-target",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"update": {"description": "d"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        TARGET_MARKERS,
    );
}

/// A4. `target` must be a string.
#[test]
fn target_must_be_a_string() {
    for (name, target) in [
        ("target-number", "1"),
        ("target-null", "null"),
        ("target-object", r#"{"path": "$.info"}"#),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": {target}, "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([TARGET_MARKERS, &["string", "type"]]),
        );
    }
}

/// A5. `remove` must be boolean.
#[test]
fn remove_must_be_boolean() {
    for (name, rm) in [
        ("remove-string", r#""true""#),
        ("remove-number", "1"),
        ("remove-null", "null"),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "remove": {rm}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([REMOVE_MARKERS, &["bool", "type"]]),
        );
    }
}

/// A5. `remove: false` paired with an `update` means "do the update": the
/// action still runs. This locks down that `remove: false` is a no-op flag.
#[test]
fn remove_false_with_update_still_updates() {
    let doc = crate::common::apply(
        "remove-false-with-update",
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "remove": false, "update": {"description": "d"}}]
}"#,
    );
    assert_eq!(doc["info"]["description"], "d");
}

/// A5. Only `target` is required on an Action Object; `update`, `copy`, and
/// `remove` are all optional. A target-only action is therefore a valid
/// no-op that MUST be accepted without modifying the input document. This
/// mirrors the official `oai_tests/v{1.0,1.1,1.2-dev}/pass/minimal.yaml`
/// fixtures.
#[test]
fn target_only_action_is_a_valid_noop() {
    for version in ["1.0.0", "1.1.0", "1.2.0"] {
        let doc = crate::common::apply(
            &format!("target-only-noop-{version}"),
            &format!(
                r#"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info"}}]
}}"#
            ),
        );

        assert_eq!(doc["info"]["title"], "t", "input document is unchanged ({version})");
        assert_eq!(doc["info"]["version"], "1", "input document is unchanged ({version})");
        assert!(
            doc["info"].get("description").is_none(),
            "no description was added ({version})"
        );
    }
}

/// A6. `extends` must be a string.
#[test]
fn extends_must_be_a_string() {
    for (name, ext) in [("extends-number", "1"), ("extends-object", r#"{"url": "./spec.json"}"#)] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": {ext},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        // Mode B ignores extends but still parses it; the type error should
        // surface either way.
        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &markers([EXTENDS_MARKERS, &["string", "type"]]),
        );
    }
}

/// A6. Unknown top-level keys outside the `x-*` extension pattern are an
/// error, to catch typos in overlay documents.
#[test]
fn unknown_top_level_key_is_rejected() {
    let (spec, ov) = files(
        "unknown-top-level",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "typoed_actions": [{"target": "$.info", "update": {"description": "d"}}],
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["unknown", "unrecognized", "typoed_actions"],
    );
}

/// A6. Unknown keys inside `info` are also rejected.
#[test]
fn unknown_info_key_is_rejected() {
    let (spec, ov) = files(
        "unknown-info-key",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1", "licence": "MIT"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["licence", "unknown", "unrecognized"],
    );
}

/// A6. Unknown keys inside an action are also rejected.
#[test]
fn unknown_action_key_is_rejected() {
    let (spec, ov) = files(
        "unknown-action-key",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}, "cond": true}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["cond", "unknown", "unrecognized"],
    );
}

/// A7. `x-*` extensions are allowed on the overlay object, info object, and
/// each action object, with arbitrary JSON values, and are ignored.
#[test]
fn x_extensions_are_accepted_everywhere_allowed() {
    let (spec, ov) = files(
        "x-extensions",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "x-author": "cf",
  "x-numbers": [1, 2, 3],
  "x-nested": {"a": {"b": true}},
  "info": {"title": "fix", "version": "1", "x-tag": "a", "x-list": [1, 2]},
  "actions": [{
    "target": "$.info",
    "update": {"description": "d"},
    "x-reason": "docs",
    "x-object": {"k": "v"}
  }]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    assert!(out.status.success(), "{}", std::str::from_utf8(&out.stderr).unwrap());
}

// --- H1: target/update type matrix (version-dispatched) ---------------

/// H1 (1.0). `update` targeting a primitive is rejected under 1.0: "the
/// result of the `target` JSONPath expression MUST be zero or more objects
/// or arrays (not primitive types or `null` values)" (1.0 §5).
#[test]
fn v10_update_targeting_a_primitive_is_rejected() {
    let (spec, ov) = files(
        "v10-primitive-target-update",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "update": "new title"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["primitive", "scalar", "object", "update", "target"],
    );
}

/// H1 (1.1+). `update` on a primitive target replaces the node. Added in
/// 1.1 §5: "If the `target` selects primitive nodes, the value of this
/// field MUST be a primitive value to replace each selected node."
#[test]
fn v11_update_targeting_a_primitive_replaces_it() {
    let doc = crate::common::apply(
        "v11-primitive-target-update",
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "update": "new title"}]
}"#,
    );

    assert_eq!(doc["info"]["title"], "new title");
    assert_eq!(doc["info"]["version"], "1", "siblings preserved");
}

/// H1 (1.1+). Updating a primitive target with a non-primitive value is a
/// type error — the 1.1 rule requires a primitive on the right-hand side.
#[test]
fn v11_update_targeting_a_primitive_with_object_is_rejected() {
    let (spec, ov) = files(
        "v11-primitive-target-with-object",
        SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "update": {"x": "y"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["primitive", "scalar", "update", "target"],
    );
}

/// H1. `update` on an object target MUST be an object. A scalar, array, or
/// null update is rejected.
#[test]
fn update_on_object_target_must_be_object() {
    for (name, update) in [
        ("object-update-scalar", r#""s""#),
        ("object-update-array", "[1, 2]"),
        ("object-update-null", "null"),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {update}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["update", "object", "target"],
        );
    }
}

/// H1 (continued). Invalid JSONPath syntax in `target` is a hard error with
/// a helpful message.
#[test]
fn invalid_jsonpath_is_rejected() {
    let (spec, ov) = files(
        "invalid-jsonpath",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$[unclosed", "update": {"x": "y"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &markers([JSONPATH_MARKERS, TARGET_MARKERS]),
    );
}

/// H1 (continued). RFC 9535 §2.3.5.1 allows parenthesized logical expressions
/// (`paren-expr`) at the top of a filter selector, so `[?(@.name == 'x')]` is
/// valid RFC 9535 JSONPath and MUST be accepted.
#[test]
fn rfc9535_parenthesized_filter_is_accepted() {
    let spec = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "parameters": [
          {"name": "x", "in": "query"},
          {"name": "y", "in": "query"}
        ],
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;
    let (spec, ov) = files(
        "rfc9535-paren-filter",
        spec,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get.parameters[?(@.name=='x')]", "remove": true}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let params = doc["paths"]["/a"]["get"]["parameters"].as_array().unwrap();
    assert_eq!(params.len(), 1);
    assert_eq!(params[0]["name"], "y");
}

/// H1 (continued). Non-RFC-9535 Goessner constructs (such as dot-bracket
/// `.['key']` and regex `=~`) are rejected with an RFC 9535 diagnostic.
#[test]
fn non_rfc9535_goessner_syntax_is_rejected() {
    for (name, target) in [
        ("dot-bracket", r#"$.paths.['/a'].get"#),
        ("regex-filter", r#"$.paths['/a'].get.parameters[?@.name =~ /x/]"#),
    ] {
        let (spec, ov) = files(
            &format!("non-rfc9535-{name}"),
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.0.0",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "{target}", "remove": true}}]
}}"#
            ),
        );

        let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
        assert!(
            err.to_lowercase().contains("rfc 9535"),
            "{name}: error should mention RFC 9535: {err}"
        );
    }
}

// --- Version-boundary tests ---------------------------------------------
//
// These lock down which features are visible in which minor version. The
// existing `v10_*` / `v11_*` / `v12_*` tests in `copy.rs`, `components.rs`,
// and `update.rs` cover the semantic forks; these tests cover the lighter
// weight schema-level dispatch.

/// §Info. `info.description` was added as a validated field in Overlay
/// 1.1. In 1.0 the Info Object's schema permits only `title`, `version`,
/// and `x-*` specification extensions, with `unevaluatedProperties: false`,
/// so a 1.0 overlay carrying `info.description` is schema-invalid even
/// though the upstream negative corpus ships no dedicated v1.0 fixture
/// for it.
#[test]
fn v10_info_description_is_rejected() {
    let (spec, ov) = files(
        "v10-info-description",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1", "description": "d"},
  "actions": [{"target": "$.info", "update": {"description": "x"}}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["description", "info", "1.0", "unknown", "unrecognized", "unevaluated"],
    );
}

/// §Info. `info.description` is accepted silently in 1.1 and 1.2.
#[test]
fn v11_and_v12_info_description_is_accepted() {
    for version in ["1.1.0", "1.2.0"] {
        let doc = crate::common::apply(
            &format!("info-description-{version}"),
            &format!(
                r#"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1", "description": "a *CommonMark* string"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );
        assert_eq!(doc["info"]["description"], "d", "action still applies ({version})");
    }
}

/// §Components. `$self`, `components`, and reusable `$ref` references are
/// 1.2-only. Each is rejected by 1.0 and 1.1. Uses a `file:` URI so the
/// rejection is unambiguously about `$self` being an unknown top-level
/// key, not about an http scheme (which would be rejected for a separate
/// reason — see `extends_with_http_scheme_is_rejected_in_every_version_and_mode`).
#[test]
fn v10_and_v11_reject_self_identifier() {
    for version in ["1.0.0", "1.1.0"] {
        let (spec, ov) = files(
            &format!("self-in-{version}"),
            SPEC,
            &format!(
                r#"{{
  "overlay": "{version}",
  "$self": "file:///identifiers/overlays/fix.json",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["$self", "unknown", "unrecognized", version],
        );
    }
}

/// §Components. `components` is 1.2-only; 1.0 and 1.1 reject it.
#[test]
fn v10_and_v11_reject_components_top_level_key() {
    for version in ["1.0.0", "1.1.0"] {
        let (spec, ov) = files(
            &format!("components-in-{version}"),
            SPEC,
            &format!(
                r#"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1"}},
  "components": {{"actions": {{"foo": {{"fields": {{"update": {{"x": 1}}}}}}}}}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["components", "unknown", "unrecognized", version],
        );
    }
}

/// §Components. The `$ref`-style reusable-action reference syntax is
/// 1.2-only; 1.0 and 1.1 reject it (both because `components` is unknown and
/// because `$ref` is an unknown action key).
#[test]
fn v10_and_v11_reject_dollar_ref_action_entry() {
    for version in ["1.0.0", "1.1.0"] {
        let (spec, ov) = files(
            &format!("ref-action-in-{version}"),
            SPEC,
            &format!(
                r##"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"$ref": "#/components/actions/foo", "target": "$.info"}}]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["$ref", "unknown", "unrecognized"],
        );
    }
}

/// §Section 3 of each spec. Patch releases within a supported minor expose
/// exactly the same feature set as `<minor>.0`. In particular, `1.1.9` MUST
/// accept `copy` and MUST reject `components`; `1.2.9` MUST accept both.
#[test]
fn patch_versions_share_minor_feature_set() {
    // 1.1.9 accepts copy (added in 1.1)...
    let doc_11 = crate::common::apply(
        "patch-v119-copy",
        r#"{
  "overlay": "1.1.9",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "src"}},
    {"target": "$.info.title", "copy": "$.info.description"}
  ]
}"#,
    );
    assert_eq!(doc_11["info"]["title"], "src", "1.1.9 behaves like 1.1.0 for copy");

    // ...but 1.1.9 rejects components, which is 1.2-only.
    let (spec, ov) = files(
        "patch-v119-components",
        SPEC,
        r#"{
  "overlay": "1.1.9",
  "info": {"title": "fix", "version": "1"},
  "components": {"actions": {"foo": {"fields": {"update": {"x": 1}}}}},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );
    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["components", "unknown", "unrecognized", "1.1"],
    );

    // 1.2.9 accepts both.
    let doc_12 = crate::common::apply(
        "patch-v129-components-and-copy",
        r##"{
  "overlay": "1.2.9",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {"setDesc": {"fields": {"update": {"description": "from-ref"}}}}
  },
  "actions": [
    {"$ref": "#/components/actions/setDesc", "target": "$.info"}
  ]
}"##,
    );
    assert_eq!(doc_12["info"]["description"], "from-ref");
}

/// Security. `extends` with an `http://` or `https://` scheme is rejected
/// in EVERY supported version AND both modes. Forge never opens a network
/// socket. (Mode A 1.0 is covered separately in `cli.rs`; this test
/// extends that guarantee to 1.1, 1.2, and Mode B.) We don't pin the
/// error wording — just that the command fails with an overlay-level
/// error (not the pre-impl clap error), names the offending field and
/// shows the URI so an operator can see what tripped the policy.
#[test]
fn extends_with_http_scheme_is_rejected_in_every_version_and_mode() {
    for version in ["1.0.0", "1.1.0", "1.2.0"] {
        for scheme in ["http", "https"] {
            let url = format!("{scheme}://example.com/openapi.json");
            let body = format!(
                r#"{{
  "overlay": "{version}",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{url}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            );

            // Mode B: `forge openapi overlay <spec> <ov>`.
            let (spec, ov) = files(&format!("mode-b-extends-{scheme}-{version}"), SPEC, &body);
            let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
            assert!(
                err.contains("extends"),
                "{scheme}/{version} Mode B names extends: {err}"
            );
            assert!(err.contains(&url), "{scheme}/{version} Mode B shows the URI: {err}");

            // Mode A: `forge openapi overlay <ov>`.
            let d = crate::common::dir(&format!("mode-a-extends-{scheme}-{version}"));
            std::fs::write(d.join("overlay.json"), &body).unwrap();
            let err = failed(overlay(&[d.join("overlay.json").to_str().unwrap()], ""));
            assert!(
                err.contains("extends"),
                "{scheme}/{version} Mode A names extends: {err}"
            );
            assert!(err.contains(&url), "{scheme}/{version} Mode A shows the URI: {err}");
        }
    }
}

/// Security. `$self` with `http://` or `https://` is rejected (1.2 only
/// — `$self` is 1.2-only; 1.0/1.1 reject it as an unknown top-level key
/// regardless of scheme). Rejection is independent of invocation mode.
#[test]
fn self_with_http_scheme_is_rejected_in_every_mode() {
    for scheme in ["http", "https"] {
        let url = format!("{scheme}://example.com/overlays/fix.json");
        // Mode B
        let (spec, ov) = files(
            &format!("mode-b-self-{scheme}"),
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "$self": "{url}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"##
            ),
        );
        let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
        assert!(err.contains("$self"), "{scheme} Mode B names $self: {err}");
        assert!(err.contains(&url), "{scheme} Mode B shows the URI: {err}");

        // Mode A
        let d = crate::common::dir(&format!("mode-a-self-{scheme}"));
        std::fs::write(d.join("spec.json"), SPEC).unwrap();
        std::fs::write(
            d.join("overlay.json"),
            format!(
                r##"{{
  "overlay": "1.2.0",
  "$self": "{url}",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "./spec.json",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"##
            ),
        )
        .unwrap();
        let err = failed(overlay(&[d.join("overlay.json").to_str().unwrap()], ""));
        assert!(err.contains("$self"), "{scheme} Mode A names $self: {err}");
        assert!(err.contains(&url), "{scheme} Mode A shows the URI: {err}");
    }
}

/// Security. Proves that forge issues ZERO network connections even
/// when offered an http(s) `extends`. We bind a TCP listener on a
/// loopback port and put its URL in `extends`. If forge attempts to
/// fetch, the listener's accept queue will show it. Forge must reject
/// before touching the network, so accept() returns `WouldBlock`.
#[test]
fn extends_http_is_rejected_before_any_network_connection() {
    use std::net::TcpListener;

    // Bind on 127.0.0.1:0 and extract the port the OS gave us.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();

    let url = format!("http://127.0.0.1:{port}/openapi.json");
    let (spec, ov) = files(
        "no-network-connection",
        SPEC,
        &format!(
            r#"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{url}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
        ),
    );

    let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
    assert!(err.contains("extends"), "error names extends: {err}");
    assert!(err.contains(&url), "error shows the URI: {err}");

    // Verify the listener's accept queue is empty — forge never connected.
    match listener.accept() {
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            // Correct: no connection was attempted.
        }
        Ok((_stream, peer)) => panic!(
            "forge connected to the loopback listener from {peer} — the security policy \
             did not reject BEFORE issuing the network connection"
        ),
        Err(e) => panic!("unexpected accept error: {e}"),
    }
}

/// Security. `extends` with a scheme outside the allow-list (`file:`, `urn:`,
/// relative) is rejected. These schemes don't trigger the HTTP-specific
/// network-refusal branch, but still can't resolve to a local spec file, so
/// the error must name both the field and the offending URI.
#[test]
fn extends_with_non_allowed_scheme_is_rejected() {
    for uri in [
        "ftp://example.com/openapi.json",
        "data:application/json,%7B%7D",
        "javascript:alert(1)",
    ] {
        let (spec, ov) = files(
            &format!("extends-scheme-{}", uri.split(':').next().unwrap()),
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{uri}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );
        let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
        assert!(err.contains("extends"), "{uri}: error names extends: {err}");
        assert!(err.contains(uri), "{uri}: error shows the URI: {err}");
    }
}

/// Security. `$self` with a scheme outside the allow-list is rejected the
/// same way `extends` is: the field and the URI are both named.
#[test]
fn self_with_non_allowed_scheme_is_rejected() {
    for uri in ["ftp://example.com/overlay.json", "data:application/json,%7B%7D"] {
        let (spec, ov) = files(
            &format!("self-scheme-{}", uri.split(':').next().unwrap()),
            SPEC,
            &format!(
                r#"{{
  "overlay": "1.2.0",
  "$self": "{uri}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
            ),
        );
        let err = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
        assert!(err.contains("$self"), "{uri}: error names $self: {err}");
        assert!(err.contains(uri), "{uri}: error shows the URI: {err}");
    }
}

/// Mode A. A `file://localhost/...` extends URI resolves to the same local
/// path as `file:///...` (RFC 8089: empty authority and `localhost` are the
/// two interoperable forms).
#[test]
fn mode_a_extends_file_localhost_authority_is_accepted() {
    let dir = crate::common::dir("mode-a-file-localhost");
    let spec_path = dir.join("spec.json");
    std::fs::write(&spec_path, SPEC).unwrap();
    let file_uri = format!("file://localhost{}", crate::common::encode_uri_path(&spec_path));
    std::fs::write(
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
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Mode A. A `file://host.example/...` extends URI names a remote host, not
/// a local file; forge refuses it rather than silently dropping the authority.
#[test]
fn mode_a_extends_file_remote_authority_is_rejected() {
    let dir = crate::common::dir("mode-a-file-remote-authority");
    let file_uri = "file://host.example/openapi.json";
    std::fs::write(
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

    let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap()], ""));
    assert!(err.contains(file_uri), "names the URI: {err}");
}

/// Mode A. A `file:/path` form (single slash, no authority) is a valid
/// RFC 8089 reference and resolves to `/path`.
#[test]
fn mode_a_extends_file_single_slash_is_accepted() {
    let dir = crate::common::dir("mode-a-file-single-slash");
    let spec_path = dir.join("spec.json");
    std::fs::write(&spec_path, SPEC).unwrap();
    // `file:` + absolute path on disk with no `//` authority marker.
    let file_uri = format!("file:{}", crate::common::encode_uri_path(&spec_path));
    std::fs::write(
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
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// A `urn:` extends passes scheme validation but cannot resolve to a local
/// file; Mode A rejects it at `extends`-resolution time with an error that
/// names the URI.
#[test]
fn mode_a_extends_urn_scheme_is_unresolvable() {
    let dir = crate::common::dir("mode-a-extends-urn");
    let urn = "urn:example:openapi";
    std::fs::write(
        dir.join("overlay.json"),
        format!(
            r#"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{urn}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
        ),
    )
    .unwrap();

    let err = failed(overlay(&[dir.join("overlay.json").to_str().unwrap()], ""));
    assert!(err.contains(urn), "names the URI: {err}");
}

/// Two `actions` entries that are byte-for-byte identical are rejected as
/// duplicates (per the OAI test corpus uniqueness rule).
#[test]
fn duplicate_identical_actions_are_rejected() {
    let (spec, ov) = files(
        "duplicate-actions-identical",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d"}},
    {"target": "$.info", "update": {"description": "d"}}
  ]
}"#,
    );
    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["duplicate", "unique"],
    );
}

/// Dedup compares actions by JSON value, not by textual spelling. Two
/// actions whose source JSON has keys in a different order are equal as JSON
/// values and must be rejected as duplicates.
#[test]
fn duplicate_actions_with_different_key_order_are_rejected() {
    let (spec, ov) = files(
        "duplicate-actions-key-order",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d", "x-note": "a"}},
    {"update": {"x-note": "a", "description": "d"}, "target": "$.info"}
  ]
}"#,
    );
    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["duplicate", "unique"],
    );
}

/// Security. Non-local `file://` authorities and malformed URIs in `extends`
/// or `$self` are rejected upfront during parsing — not only in Mode A, but
/// also in Mode B.
#[test]
fn mode_b_rejects_remote_file_authority_and_malformed_uris() {
    for (tag, field, uri) in [
        ("extends-remote-file", "extends", "file://evil.example/openapi.json"),
        ("self-remote-file", "$self", "file://evil.example/overlay.json"),
        ("extends-malformed", "extends", "http ://example.com/openapi.json"),
        ("self-malformed", "$self", "file://[bad"),
    ] {
        let body = format!(
            r#"{{
  "overlay": "1.2.0",
  "{field}": "{uri}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"#
        );
        let (spec, ov) = files(&format!("upfront-uri-{tag}"), SPEC, &body);

        // Mode B
        let err_b = failed(overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""));
        assert!(err_b.contains(field), "{tag} Mode B names {field}: {err_b}");
        assert!(err_b.contains(uri), "{tag} Mode B shows URI: {err_b}");
    }
}

/// Two actions targeting the same node with the same body may legitimately
/// differ in `description` or `x-*` extensions (the latter are user-defined
/// metadata). The duplicate-action detector keys on `(target, verb body)`,
/// not whole-action equality, so these parse and both apply.
#[test]
fn actions_differing_only_in_description_are_not_duplicates() {
    let (spec, ov) = files(
        "actions-differ-description",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d"}, "description": "first"},
    {"target": "$.info", "update": {"description": "d"}, "description": "second"}
  ]
}"#,
    );
    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// Same shape, but with a vendor extension differing instead of `description`.
#[test]
fn actions_differing_only_in_x_extension_are_not_duplicates() {
    let (spec, ov) = files(
        "actions-differ-x-extension",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [
    {"target": "$.info", "update": {"description": "d"}, "x-origin": "manual"},
    {"target": "$.info", "update": {"description": "d"}, "x-origin": "generated"}
  ]
}"#,
    );
    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    crate::common::succeeded(&out);
}
