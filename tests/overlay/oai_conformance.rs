//! Official OAI Overlay-Specification conformance tests.
//!
//! The upstream repo ships per-version corpora of overlay documents at
//! `tests/v{1.0,1.1,1.2-dev}/{pass,fail}/`. A `pass` file is a schema-valid
//! overlay that implementations MUST accept; a `fail` file is forbidden by
//! the spec and MUST be rejected. See `oai_tests/README.md` for the vendored
//! commit SHA.
//!
//! We invoke each as `forge overlay <trivial-spec> --overlay <test>` in
//! Mode B. Mode B ignores `extends`, so tests whose `extends` URIs point at
//! files we don't have still parse cleanly. For Mode-A-only documents (ones
//! that only make sense when their `extends` resolves) this layer still
//! verifies document-level schema conformance — apply-time semantics are
//! covered by the hand-written tests elsewhere in this directory.
//!
//! ## Forge is a RESTRICTED compatibility profile, not unrestricted conformance
//!
//! Forge intentionally refuses to issue any HTTP request. `$self` and
//! `extends` MUST NOT use an `http://` or `https://` URI, in any mode or
//! any Overlay minor. This is a security-profile deviation from the OAI
//! spec: the OAI corpus ships some `pass/*.yaml` fixtures whose URIs use
//! https. Rather than silently accepting those or editing vendored files,
//! we maintain an explicit `POLICY_DEVIATIONS` manifest. For each listed
//! fixture:
//!
//! - Forge MUST reject it (not accept it, not panic on it, not I/O-fail
//!   on it).
//! - The rejection MUST name the forbidden URI and a security/policy
//!   marker (`http`, `security`, `policy`, `scheme`) alongside the field
//!   name (`$self`/`extends`).
//!
//! An unlisted pass fixture that forge rejects is a bug — either in the
//! implementation or in the deviations manifest. Likewise an unlisted
//! fixture whose rejection would be expected by Forge's security policy
//! must be added here deliberately.
//!
//! ## Discrimination of negative fixtures
//!
//! A rejection is only credit for the fixture if it is an overlay-level
//! schema error. We require the stderr to:
//!
//! 1. NOT contain any of the generic pre-implementation CLI diagnostics
//!    forge emits before `overlay` is a registered subcommand (identical
//!    guard to `common::failed`'s `PRE_IMPL_MARKERS`).
//! 2. NOT look like a target-OpenAPI parse error, a missing-file I/O
//!    failure, or a panic — those don't demonstrate that the overlay was
//!    rejected for the reason the fixture is about.
//! 3. Contain at least one overlay-schema marker (`overlay`, `action`,
//!    `target`, `$ref`, `extends`, `$self`, `fields`, `components`, or
//!    `update` / `copy` / `remove`), so we know forge examined the overlay
//!    itself rather than tripping on something else.
//!
//! When any of these conditions fails, we report the fixture name together
//! with the complete stdout and stderr, so a regression in the official
//! corpus is immediately debuggable.

use std::fs;
use std::path::{Path, PathBuf};

use crate::common::{SPEC, dir, overlay, text};

/// Strings forge emits for the pre-implementation CLI, not for an overlay
/// rejection. Mirrors `common::PRE_IMPL_MARKERS` (kept private there).
const PRE_IMPL_MARKERS: &[&str] = &[
    "cannot be used with '<SPEC>'",
    "the following required arguments were not provided",
    "unrecognized subcommand",
    "unexpected argument 'overlay'",
    "unexpected argument \"overlay\"",
];

/// Strings that indicate the error came from somewhere other than the
/// overlay validator — a missing file, a target-spec parser, a panic. If
/// one of these appears in a fixture's stderr we consider it a false
/// negative/positive, not real conformance.
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

/// Overlay-schema markers. A real overlay-level rejection mentions at
/// least one of these.
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

/// Markers that must appear in a security-policy rejection: a URI-scheme
/// word plus a field name. At least one of each category is required so
/// the error unambiguously names Forge's policy, not a generic parse
/// error that happens to contain `http`.
const SECURITY_POLICY_SCHEME_MARKERS: &[&str] = &["http", "scheme", "security", "policy", "network"];
const SECURITY_POLICY_FIELD_MARKERS: &[&str] = &["$self", "extends"];

/// Explicit list of OAI `pass/*.yaml` fixtures that Forge's security
/// policy REJECTS. Each entry is `(version, filename, forbidden_uri)` —
/// the forbidden URI must appear in stderr verbatim so operators can see
/// exactly which URI tripped the policy.
///
/// Rationale per entry is documented in the surrounding module docs.
const POLICY_DEVIATIONS: &[(&str, &str, &str)] = &[
    // $self AND extends both https — both are rejected; we check that at
    // least one of them is named in the error, together with a policy
    // marker. The upstream fixture's intent (reusable identifier) is not
    // one Forge can honor without network access.
    ("v1.2-dev", "self-and-extends-identifier.yaml", "https://"),
    // $self is https (extends is relative, which would otherwise be
    // fine); Forge rejects for the $self scheme.
    ("v1.2-dev", "self-with-relative-extends.yaml", "https://"),
];

fn scenario_files(version: &str, kind: &str) -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/overlay/oai_tests")
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

fn deviation_for(version: &str, name: &str) -> Option<&'static str> {
    POLICY_DEVIATIONS.iter().find_map(
        |(v, n, uri)| {
            if *v == version && *n == name { Some(*uri) } else { None }
        },
    )
}

fn stderr_has_any(lower: &str, markers: &[&str]) -> bool {
    markers.iter().any(|m| lower.contains(&m.to_lowercase()))
}

#[derive(Default)]
struct PassReport {
    unexpectedly_rejected: Vec<String>,
    deviation_unexpectedly_accepted: Vec<String>,
    deviation_bad_rejection: Vec<String>,
    deviation_missing_uri: Vec<String>,
    pre_impl: Vec<String>,
    non_overlay_error: Vec<String>,
}

fn run_pass(version: &str) {
    let mut report = PassReport::default();

    for ov in scenario_files(version, "pass") {
        let name = ov.file_name().unwrap().to_string_lossy().into_owned();
        let spec = spec_for(&format!("{version}-pass-{name}"));
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        let stdout = text(&out.stdout).to_owned();
        let stderr = text(&out.stderr).to_owned();
        let lower = stderr.to_lowercase();

        if let Some(forbidden_uri) = deviation_for(version, &name) {
            // Policy deviation: Forge MUST reject.
            if out.status.success() {
                report
                    .deviation_unexpectedly_accepted
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
            // Require: a scheme-policy marker AND a field marker AND the
            // forbidden URI itself in the error.
            let has_scheme_marker = stderr_has_any(&lower, SECURITY_POLICY_SCHEME_MARKERS);
            let has_field_marker = stderr_has_any(&lower, SECURITY_POLICY_FIELD_MARKERS);
            if !has_scheme_marker || !has_field_marker {
                report
                    .deviation_bad_rejection
                    .push(format!("{name}\n  stderr:\n{stderr}"));
                continue;
            }
            if !stderr.contains(forbidden_uri) {
                report.deviation_missing_uri.push(format!(
                    "{name} (expected {forbidden_uri:?} in stderr)\n  stderr:\n{stderr}"
                ));
            }
        } else if !out.status.success() {
            if PRE_IMPL_MARKERS.iter().any(|m| stderr.contains(m)) {
                report.pre_impl.push(name);
            } else {
                report
                    .unexpectedly_rejected
                    .push(format!("{name}\n  stdout:\n{stdout}\n  stderr:\n{stderr}"));
            }
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
        report.deviation_unexpectedly_accepted.is_empty(),
        "{} OAI {version}/pass scenarios on the POLICY_DEVIATIONS list were \
         ACCEPTED but Forge's security policy requires rejection:\n---\n{}\n---",
        report.deviation_unexpectedly_accepted.len(),
        report.deviation_unexpectedly_accepted.join("\n---\n")
    );
    assert!(
        report.pre_impl.is_empty(),
        "{} OAI {version}/pass scenarios tripped the pre-implementation CLI \
         diagnostic rather than the overlay command. `forge overlay` is almost \
         certainly unimplemented. Affected files:\n{}",
        report.pre_impl.len(),
        report.pre_impl.join("\n")
    );
    assert!(
        report.non_overlay_error.is_empty(),
        "{} OAI {version}/pass deviation scenarios failed with a non-overlay \
         error (panic, I/O, target parser) — not the security-policy \
         rejection. Affected files:\n---\n{}\n---",
        report.non_overlay_error.len(),
        report.non_overlay_error.join("\n---\n")
    );
    assert!(
        report.deviation_bad_rejection.is_empty(),
        "{} OAI {version}/pass deviation scenarios were rejected, but the error \
         did not name both a scheme-policy marker (http/scheme/security/policy/\
         network) and a field marker ($self/extends). The rejection must be \
         unambiguously the security policy, not an incidental parse error. \
         Affected files:\n---\n{}\n---",
        report.deviation_bad_rejection.len(),
        report.deviation_bad_rejection.join("\n---\n")
    );
    assert!(
        report.deviation_missing_uri.is_empty(),
        "{} OAI {version}/pass deviation scenarios were rejected with the right \
         markers, but the forbidden URI itself was not quoted in stderr. \
         Operators must see which URI tripped the policy. Affected files:\n---\n{}\n---",
        report.deviation_missing_uri.len(),
        report.deviation_missing_uri.join("\n---\n")
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
        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
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
         I/O error, target OpenAPI parse error) — the overlay validator did not \
         reach a decision about the overlay itself. These must not be counted as \
         conformance. Affected files:\n---\n{}\n---",
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
/// fixture. If a fixture is renamed upstream and we re-vendor without
/// updating this manifest, this test fails loudly instead of silently
/// dropping coverage.
#[test]
fn policy_deviations_manifest_entries_all_exist() {
    for (version, name, _uri) in POLICY_DEVIATIONS {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/overlay/oai_tests")
            .join(version)
            .join("pass")
            .join(name);
        assert!(
            path.exists(),
            "POLICY_DEVIATIONS entry {version}/pass/{name} is not a vendored fixture: {path:?}"
        );
    }
}
