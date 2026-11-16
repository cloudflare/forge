//! Tests for overlay document validation (rules A1-A7 and H1):
//! required fields, invalid fields, and the "target must select objects or
//! arrays" constraint from section 5 of the Overlay specification.

use crate::common::{SPEC, failed, files, overlay};

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

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.contains("overlay"), "{err}");
    assert!(err.to_lowercase().contains("missing") || err.to_lowercase().contains("required"), "{err}");
}

/// A1. `overlay` must be the 1.x version family. 2.0.0 is rejected.
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

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.contains("2.0.0") || err.contains("overlay"), "{err}");
    assert!(err.to_lowercase().contains("unsupported") || err.to_lowercase().contains("version"), "{err}");
}

/// A1. `1.0.x` is accepted silently; patch differences are ignored per
/// section 3 of the specification.
#[test]
fn overlay_version_one_dot_zero_dot_x_is_accepted_silently() {
    for version in ["1.0.0", "1.0.1"] {
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
        assert!(out.status.success(), "forge failed for {version}: {}", std::str::from_utf8(&out.stderr).unwrap());
        let err = std::str::from_utf8(&out.stderr).unwrap();
        assert!(!err.to_lowercase().contains("warning"), "{version} should not warn: {err}");
    }
}

/// A1. `1.1.x` is a newer minor feature set we don't implement; we still
/// parse the document and apply the actions we understand, but log a
/// warning on stderr so authors know we may skip features.
#[test]
fn overlay_version_one_dot_one_is_accepted_with_a_warning() {
    let (spec, ov) = files(
        "overlay-version-1-1",
        SPEC,
        r#"{
  "overlay": "1.1.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    assert!(out.status.success(), "forge failed: {}", std::str::from_utf8(&out.stderr).unwrap());
    let err = std::str::from_utf8(&out.stderr).unwrap();
    assert!(err.to_lowercase().contains("1.1"), "warning mentions the version: {err}");
    assert!(err.to_lowercase().contains("warn") || err.to_lowercase().contains("unsupported"), "{err}");
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d", "the action was still applied");
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

        let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
        assert!(err.to_lowercase().contains("info"), "{name}: {err}");
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

        let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
        assert!(err.to_lowercase().contains("action"), "{name}: {err}");
    }
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

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.to_lowercase().contains("target"), "{err}");
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
  "action": [{"target": "$.info", "update": {"description": "d"}}]
}"#,
    );

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.contains("action"), "{err}");
}

/// A7. `x-*` extensions are allowed on the overlay object, info object, and
/// each action object, and are ignored.
#[test]
fn x_extensions_are_accepted_everywhere_allowed() {
    let (spec, ov) = files(
        "x-extensions",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "x-author": "cf",
  "info": {"title": "fix", "version": "1", "x-tag": "a"},
  "actions": [{"target": "$.info", "update": {"description": "d"}, "x-reason": "docs"}]
}"#,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    assert!(out.status.success(), "{}", std::str::from_utf8(&out.stderr).unwrap());
}

/// H1. `update` targeting a primitive or null is rejected: the spec says
/// "update... MUST be an object with the properties and values to merge
/// with the selected node" — merging into a primitive is meaningless.
/// `remove` on a primitive is handled separately in `remove.rs` (and is
/// allowed, per the official `remove-example` compliant set).
#[test]
fn update_targeting_a_primitive_is_rejected() {
    let (spec, ov) = files(
        "primitive-target-update",
        SPEC,
        r#"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info.title", "update": {"x": "y"}}]
}"#,
    );

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.to_lowercase().contains("object") || err.to_lowercase().contains("primitive"), "{err}");
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

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(err.to_lowercase().contains("jsonpath") || err.to_lowercase().contains("target"), "{err}");
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

    let err = failed(overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""));
    assert!(
        err.to_lowercase().contains("rfc") || err.to_lowercase().contains("goessner") || err.contains("[?("),
        "message points at RFC 9535 vs. Goessner: {err}"
    );
}
