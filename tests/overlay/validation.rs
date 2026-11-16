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
const UPDATE_MARKERS: &[&str] = &["update", "`update`", "\"update\""];
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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

        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
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

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
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

/// A1. A 1.1 overlay that uses the `copy` action (a 1.1-only feature not in
/// A1. A malformed version string is rejected. The spec requires a
/// three-component semver-like string; `1`, `1.0`, and `1.0.0-beta` are
/// all malformed.
#[test]
fn malformed_overlay_version_is_rejected() {
    for bad in ["1", "1.0", "1.0.0-beta", "", "one"] {
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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

/// A5. An action with neither `update` nor `remove: true` has no effect to
/// apply and is rejected. The spec is not explicit, so we lock down a
/// specific choice here: reject, since silent no-op hides mistakes.
#[test]
fn action_with_neither_update_nor_remove_is_rejected() {
    let (spec, ov) = files(
        "action-with-no-effect",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info"}]
}"#,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &markers([UPDATE_MARKERS, REMOVE_MARKERS, &["either", "neither"]]),
    );
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &markers([JSONPATH_MARKERS, TARGET_MARKERS]),
    );
}

/// H1 (continued). We implement RFC 9535 JSONPath. The older Goessner
/// variant writes filters with parentheses (`[?(...)]`), which RFC 9535
/// forbids. We reject this syntax with a message that points authors at
/// the fix.
#[test]
fn goessner_filter_syntax_is_rejected() {
    let (spec, ov) = files(
        "goessner-filter",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.paths[\"/a\"].get.parameters[?(@.name=='x')]", "remove": true}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    let err = failed(out);
    assert!(
        err.to_lowercase().contains("rfc 9535") || err.to_lowercase().contains("goessner") || err.contains("[?("),
        "message points at RFC 9535 vs. Goessner: {err}"
    );
}
