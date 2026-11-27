//! Official OAI Overlay-Specification conformance tests.
//!
//! The upstream repo ships per-version corpora of overlay documents at
//! `tests/v{1.0,1.1,1.2-dev}/{pass,fail}/`. A `pass` file is a schema-valid
//! overlay that implementations MUST accept; a `fail` file is forbidden by
//! the spec and MUST be rejected. See `oai_tests/README.md` for the vendored
//! commit SHA.
//!
//! We invoke each as `forge openapi overlay <trivial-spec> <test>` in
//! Mode B. Mode B ignores `extends`, so tests whose `extends` URIs point at
//! files we don't have still parse cleanly.
//!
//! ## Forge's restricted security profile
//!
//! Forge intentionally refuses to issue any HTTP request. `$self` and
//! `extends` MUST NOT use an `http://` or `https://` URI. The upstream
//! `pass/*.yaml` corpus ships a small number of fixtures that put https
//! URIs in those fields; `POLICY_DEVIATIONS` lists them so this runner
//! treats them as expected rejections rather than conformance failures.
//!
//! The deviation runner itself is deliberately thin: it asserts the
//! fixture is rejected and the rejection isn't a panic, I/O error, or
//! the pre-implementation CLI diagnostic. Full discrimination of the
//! HTTP security rule (correct field named, URI shown, no network
//! connection attempted) is proven exhaustively across versions and
//! modes by the handwritten tests in `tests/openapi/overlay/validation.rs`.
//! Duplicating that discrimination here would just enforce error-text
//! vocabulary before any error text exists.
//!
//! The deviation manifest still enumerates every `(field, URI)` pair in
//! each fixture, consumed by the drift sanity test at the bottom: if
//! upstream renames a URI or moves it to a different field, that test
//! fails loudly instead of silently dropping coverage.

use std::fs;
use std::path::{Path, PathBuf};

use crate::common::{PRE_IMPL_MARKERS, SPEC, dir, overlay, text};

/// Strings that indicate the error came from somewhere other than the
/// overlay validator — a missing file, a target-spec parser, a panic.
/// A fixture whose stderr matches one of these isn't real conformance
/// evidence either way.
const NON_OVERLAY_ERROR_MARKERS: &[&str] = &[
    "panicked at",
    "stack backtrace",
    "no such file or directory",
    "is a directory",
    "permission denied",
    "openapi document",
    "openapi spec",
    "invalid openapi",
];

/// Overlay-schema markers. A real overlay-level rejection of a `fail`
/// fixture mentions at least one of these — otherwise we can't tell the
/// overlay validator actually looked at the document.
const OVERLAY_MARKERS: &[&str] = &[
    "overlay",
    "action",
    "target",
    "update",
    "copy",
    "remove",
    "extends",
    "$self",
    "$ref",
    "fields",
    "components",
    "info.title",
    "info.version",
    "jsonpath",
    "json path",
    "rfc 9535",
];

/// One forbidden (field, URI) pair inside a deviation fixture. Stored
/// exactly as it appears in the upstream fixture so the drift sanity
/// test can verify the pair hasn't moved or been edited.
#[derive(Clone, Copy)]
struct ForbiddenRef {
    field: &'static str,
    uri: &'static str,
}

/// One entry in the policy deviations manifest.
#[derive(Clone, Copy)]
struct PolicyDeviation {
    version: &'static str,
    file: &'static str,
    forbidden: &'static [ForbiddenRef],
}

/// OAI `pass/*.yaml` fixtures that Forge's security profile REJECTS. The
/// `forbidden` list documents every `(field, URI)` pair in the fixture;
/// the runner only requires forge to reject the fixture, but the drift
/// sanity test asserts each pair is still present verbatim in the
/// upstream YAML.
const POLICY_DEVIATIONS: &[PolicyDeviation] = &[
    PolicyDeviation {
        version: "v1.2-dev",
        file: "self-and-extends-identifier.yaml",
        forbidden: &[
            ForbiddenRef {
                field: "$self",
                uri: "https://example.com/overlays/petstore.overlay.yaml",
            },
            ForbiddenRef {
                field: "extends",
                uri: "https://api.example.com/openapi/petstore.yaml",
            },
        ],
    },
    PolicyDeviation {
        version: "v1.2-dev",
        file: "self-with-relative-extends.yaml",
        forbidden: &[ForbiddenRef {
            field: "$self",
            uri: "https://example.com/overlays/petstore.overlay.yaml",
        }],
    },
];

fn scenario_files(version: &str, kind: &str) -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/openapi/overlay/oai_tests")
        .join(version)
        .join(kind);
    let mut paths: Vec<_> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read {root:?}: {e}"))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("yaml"))
        .collect();
    paths.sort();
    paths
}

fn spec_for(tag: &str) -> PathBuf {
    let d = dir(&format!("oai/{}", tag.replace(['/', ' ', '.'], "_")));
    let p = d.join("spec.json");
    fs::write(&p, SPEC).unwrap();
    p
}

fn is_policy_deviation(version: &str, name: &str) -> bool {
    POLICY_DEVIATIONS.iter().any(|d| d.version == version && d.file == name)
}

#[derive(Default)]
struct PassReport {
    unexpectedly_accepted: Vec<String>,
    unexpectedly_rejected: Vec<String>,
    pre_impl: Vec<String>,
    non_overlay_error: Vec<String>,
}

fn run_pass(version: &str) {
    let mut report = PassReport::default();

    for ov in scenario_files(version, "pass") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-pass-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
        let stdout = text(&out.stdout).to_owned();
        let stderr = text(&out.stderr).to_owned();
        let lower = stderr.to_lowercase();

        let is_deviation = is_policy_deviation(version, &name);
        let failed_with_pre_impl = !out.status.success() && PRE_IMPL_MARKERS.iter().any(|m| stderr.contains(m));

        if failed_with_pre_impl {
            report.pre_impl.push(name);
            continue;
        }

        if is_deviation {
            if out.status.success() {
                report
                    .unexpectedly_accepted
                    .push(format!("{name}\n  stdout:\n{stdout}\n  stderr:\n{stderr}"));
            } else if NON_OVERLAY_ERROR_MARKERS.iter().any(|m| lower.contains(m)) {
                report.non_overlay_error.push(format!("{name}\n  stderr:\n{stderr}"));
            }
            // Otherwise: forge rejected it with an overlay-level error.
            // That's sufficient here; validation.rs proves the exact
            // HTTP security rule with handwritten tests.
        } else if !out.status.success() {
            report
                .unexpectedly_rejected
                .push(format!("{name}\n  stdout:\n{stdout}\n  stderr:\n{stderr}"));
        }
    }

    assert!(
        report.unexpectedly_rejected.is_empty(),
        "{} OAI {version}/pass scenarios were rejected and are NOT on the \
         POLICY_DEVIATIONS list (MUST be accepted):\n---\n{}\n---",
        report.unexpectedly_rejected.len(),
        report.unexpectedly_rejected.join("\n---\n")
    );
    assert!(
        report.unexpectedly_accepted.is_empty(),
        "{} OAI {version}/pass scenarios on the POLICY_DEVIATIONS list were \
         ACCEPTED but Forge's security policy requires rejection:\n---\n{}\n---",
        report.unexpectedly_accepted.len(),
        report.unexpectedly_accepted.join("\n---\n")
    );
    assert!(
        report.pre_impl.is_empty(),
        "{} OAI {version}/pass scenarios tripped the pre-implementation CLI \
         diagnostic rather than the overlay command. `forge openapi overlay` is almost \
         certainly unimplemented. Affected files:\n{}",
        report.pre_impl.len(),
        report.pre_impl.join("\n")
    );
    assert!(
        report.non_overlay_error.is_empty(),
        "{} OAI {version}/pass deviation scenarios failed with a non-overlay \
         error (panic, I/O, target parser). Affected files:\n---\n{}\n---",
        report.non_overlay_error.len(),
        report.non_overlay_error.join("\n---\n")
    );
}

#[derive(Default)]
struct FailReport {
    unexpectedly_accepted: Vec<String>,
    pre_impl: Vec<String>,
    non_overlay_error: Vec<String>,
    no_overlay_marker: Vec<String>,
}

fn run_fail(version: &str) {
    let mut report = FailReport::default();

    for ov in scenario_files(version, "fail") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-fail-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
        let stdout = text(&out.stdout).to_owned();
        let stderr = text(&out.stderr).to_owned();
        let lower = stderr.to_lowercase();

        if out.status.success() {
            report
                .unexpectedly_accepted
                .push(format!("{name}\n  stdout:\n{stdout}\n  stderr:\n{stderr}"));
            continue;
        }

        if PRE_IMPL_MARKERS.iter().any(|m| stderr.contains(m)) {
            report.pre_impl.push(name);
            continue;
        }

        if NON_OVERLAY_ERROR_MARKERS.iter().any(|m| lower.contains(m)) {
            report.non_overlay_error.push(format!("{name}\n  stderr:\n{stderr}"));
            continue;
        }

        if !OVERLAY_MARKERS.iter().any(|m| lower.contains(m)) {
            report.no_overlay_marker.push(format!("{name}\n  stderr:\n{stderr}"));
        }
    }

    assert!(
        report.unexpectedly_accepted.is_empty(),
        "{} OAI {version}/fail scenarios were accepted (MUST be rejected):\n---\n{}\n---",
        report.unexpectedly_accepted.len(),
        report.unexpectedly_accepted.join("\n---\n")
    );
    assert!(
        report.pre_impl.is_empty(),
        "{} OAI {version}/fail scenarios failed with the generic pre-implementation \
         CLI error, not an overlay-specific rejection. The `overlay` subcommand is \
         almost certainly unimplemented. Affected files:\n{}",
        report.pre_impl.len(),
        report.pre_impl.join("\n")
    );
    assert!(
        report.non_overlay_error.is_empty(),
        "{} OAI {version}/fail scenarios failed with a non-overlay error (panic, \
         I/O error, target OpenAPI parse error). Affected files:\n---\n{}\n---",
        report.non_overlay_error.len(),
        report.non_overlay_error.join("\n---\n")
    );
    assert!(
        report.no_overlay_marker.is_empty(),
        "{} OAI {version}/fail scenarios failed with stderr that doesn't name any \
         overlay-schema concept — the overlay validator may not have examined the \
         document. Affected files:\n---\n{}\n---",
        report.no_overlay_marker.len(),
        report.no_overlay_marker.join("\n---\n")
    );
}

#[test]
fn oai_v1_0_pass() {
    run_pass("v1.0");
}

#[test]
fn oai_v1_0_fail() {
    run_fail("v1.0");
}

#[test]
fn oai_v1_1_pass() {
    run_pass("v1.1");
}

#[test]
fn oai_v1_1_fail() {
    run_fail("v1.1");
}

#[test]
fn oai_v1_2_pass() {
    run_pass("v1.2-dev");
}

#[test]
fn oai_v1_2_fail() {
    run_fail("v1.2-dev");
}

/// Sanity: every entry in `POLICY_DEVIATIONS` names a real vendored
/// fixture AND the exact forbidden URI it declares is actually bound to
/// the declared field (`$self` or `extends`) in that fixture, not merely
/// present somewhere in the bytes. If an upstream rename moves the URI
/// to a different field, or a URI edit changes its value, this test
/// fails loudly instead of silently dropping coverage.
#[test]
fn policy_deviations_manifest_matches_vendored_fixtures() {
    for deviation in POLICY_DEVIATIONS {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/openapi/overlay/oai_tests")
            .join(deviation.version)
            .join("pass")
            .join(deviation.file);
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "POLICY_DEVIATIONS entry {}/pass/{} is not a vendored fixture ({path:?}): {e}",
                deviation.version, deviation.file,
            )
        });
        let parsed: serde_json::Value = serde_saphyr::from_str(&contents).unwrap_or_else(|e| {
            panic!(
                "POLICY_DEVIATIONS entry {}/pass/{} is not valid YAML: {e}",
                deviation.version, deviation.file,
            )
        });
        for forbidden in deviation.forbidden {
            let actual = parsed.get(forbidden.field).and_then(|v| v.as_str()).unwrap_or_else(|| {
                panic!(
                    "POLICY_DEVIATIONS says {}/pass/{} has forbidden URI in field {:?}, \
                     but the fixture has no string value at that field. Update the manifest.",
                    deviation.version, deviation.file, forbidden.field,
                )
            });
            assert_eq!(
                actual, forbidden.uri,
                "POLICY_DEVIATIONS says {}/pass/{} has URI {:?} at field {:?}, \
                 but the fixture's actual value there is {:?} — upstream probably \
                 edited the URI. Update the manifest.",
                deviation.version, deviation.file, forbidden.uri, forbidden.field, actual,
            );
        }
    }
}
