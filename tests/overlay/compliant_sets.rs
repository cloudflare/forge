//! The OAI `compliant-sets/` corpus, run as a black box.
//!
//! Each scenario under `tests/overlay/compliant_sets/<name>/` is a triple of
//! `openapi.yaml`, `overlay.yaml`, and `output.yaml`. For each scenario we
//! apply the overlay to the spec and assert the result is structurally equal
//! to the expected output.
//!
//! Two scenarios (`remove-property`, `remove-server`) use the Goessner
//! `[?(...)]` filter form. We implement RFC 9535 strictly, which forbids
//! parentheses, so those scenarios assert the specific error message rather
//! than a successful apply. See `validation.rs::goessner_filter_syntax_is_rejected`.

use std::path::{Path, PathBuf};

use crate::common::{failed, overlay, succeeded};

fn scenario(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/overlay/compliant_sets")
        .join(name)
}

/// Runs a scenario end-to-end and asserts YAML-structural equality against
/// the expected `output.yaml`.
fn run_apply(name: &str) {
    let dir = scenario(name);
    let spec = dir.join("openapi.yaml");
    let ov = dir.join("overlay.yaml");
    let expected = std::fs::read_to_string(dir.join("output.yaml")).unwrap();

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);

    let actual: serde_yml::Value = serde_yml::from_slice(&out.stdout).expect("stdout is YAML");
    let expected_value: serde_yml::Value = serde_yml::from_str(&expected).expect("output.yaml is YAML");
    assert_eq!(
        actual, expected_value,
        "scenario {name}: output does not match expected output.yaml"
    );
}

/// Runs a scenario that uses Goessner `[?(...)]` filter syntax and asserts
/// forge rejects it with a message that points authors at RFC 9535.
fn run_expects_goessner_rejection(name: &str) {
    let dir = scenario(name);
    let spec = dir.join("openapi.yaml");
    let ov = dir.join("overlay.yaml");

    let err = failed(overlay(
        &[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()],
        "",
    ));
    assert!(
        err.to_lowercase().contains("rfc") || err.to_lowercase().contains("goessner") || err.contains("[?("),
        "scenario {name}: expected RFC 9535 vs. Goessner error, got: {err}"
    );
}

#[test]
fn add_a_license() {
    run_apply("add-a-license");
}

#[test]
fn description_and_summary() {
    run_apply("description-and-summary");
}

#[test]
fn remove_example() {
    run_apply("remove-example");
}

#[test]
fn remove_matching_responses() {
    run_apply("remove-matching-responses");
}

#[test]
fn remove_property_uses_goessner_syntax() {
    run_expects_goessner_rejection("remove-property");
}

#[test]
fn remove_server_uses_goessner_syntax() {
    run_expects_goessner_rejection("remove-server");
}

#[test]
fn replace_servers_for_sandbox() {
    run_apply("replace-servers-for-sandbox");
}

#[test]
fn update_root() {
    run_apply("update-root");
}
