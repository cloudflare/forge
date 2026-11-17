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
//!   on it, not pre-implementation-CLI-fail on it).
//! - The rejection MUST name a scheme-policy marker
//!   (`scheme`/`security`/`policy`/`network`/`forbidden`/`not allowed`).
//! - The rejection MUST name at least ONE complete `(field, URI)` pair
//!   from the fixture — a field (`$self` or `extends`) alongside the
//!   exact URI it holds, so an operator can see which specific reference
//!   tripped the policy. A valid validator may stop at the first forbidden
//!   reference it finds; we do NOT require every reference in the fixture
//!   to be reported.
//!
//! The full manifest still lists every forbidden reference. That serves
//! two purposes: documentation (readers see what is rejected and why),
//! and fixture drift detection (the sanity test at the bottom asserts
//! every listed `(field, URI)` pair matches the parsed YAML of the
//! fixture, so an upstream rename or URI edit fails loudly).
//!
//! Dedicated handwritten tests in `tests/overlay/validation.rs`
//! independently verify HTTP(S) rejection for BOTH `$self` and `extends`
//! across every supported Overlay version and invocation mode — the
//! policy-deviation path above is corpus-driven acceptance, not the
//! sole proof of the security rule.
//!
//! An unlisted pass fixture that forge rejects is a bug — either in the
//! implementation or in the deviations manifest.
//!
//! ## Discrimination of negative fixtures
//!
//! A rejection is only credit for the fixture if it is an overlay-level
//! schema error. We require the stderr to:
//!
//! 1. NOT contain any of the generic pre-implementation CLI diagnostics
//!    forge emits before `overlay` is a registered subcommand (identical
//!    guard to `common::PRE_IMPL_MARKERS`, imported here rather than
//!    duplicated).
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

use crate::common::{PRE_IMPL_MARKERS, SPEC, dir, overlay, text};

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

/// Scheme-policy markers that must appear somewhere in a security-policy
/// rejection — AFTER the forbidden URI has been redacted from stderr. The
/// bare word `http` is deliberately absent: every deviation's URI starts
/// with `http`/`https`, and that URI often appears verbatim in stderr, so
/// including `http` here would make this check trivially true for any
/// rejection that echoes the URL. `rejected` is also absent — too generic
/// to prove the HTTP security policy fired rather than any other
/// validation error.
const SECURITY_POLICY_SCHEME_MARKERS: &[&str] =
    &["scheme", "security", "policy", "network", "forbidden", "not allowed"];

/// One forbidden (field, URI) pair inside a deviation fixture.
#[derive(Clone, Copy)]
struct ForbiddenRef {
    /// Exact overlay field holding the URI (`$self` or `extends`).
    field: &'static str,
    /// The complete forbidden URI as it appears in the fixture, verbatim.
    uri: &'static str,
}

/// One entry in the policy deviations manifest.
#[derive(Clone, Copy)]
struct PolicyDeviation {
    version: &'static str,
    file: &'static str,
    /// Every forbidden reference in the fixture. Stored in full for
    /// documentation and fixture-drift validation; the stderr-contents
    /// check only requires AT LEAST ONE of these pairs to be named,
    /// since a validator may legitimately stop at the first forbidden
    /// reference it encounters.
    forbidden: &'static [ForbiddenRef],
}

/// Explicit list of OAI `pass/*.yaml` fixtures that Forge's security
/// policy REJECTS. Each entry records every forbidden (field, URI) pair
/// in the fixture verbatim; see the module docs for the exact contract.
const POLICY_DEVIATIONS: &[PolicyDeviation] = &[
    // $self AND extends both https — both forbidden refs MUST be named.
    // The upstream fixture's intent (reusable identifier) cannot be
    // honored without network access.
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
    // $self is https (extends is a plain relative reference, which would
    // otherwise be fine); Forge rejects for the $self scheme.
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

fn deviation_for(version: &str, name: &str) -> Option<&'static PolicyDeviation> {
    POLICY_DEVIATIONS
        .iter()
        .find(|d| d.version == version && d.file == name)
}

fn stderr_has_any(lower: &str, markers: &[&str]) -> bool {
    markers.iter().any(|m| lower.contains(&m.to_lowercase()))
}

#[derive(Default)]
struct PassReport {
    unexpectedly_rejected: Vec<String>,
    deviation_unexpectedly_accepted: Vec<String>,
    deviation_missing_scheme_marker: Vec<String>,
    deviation_missing_matching_pair: Vec<String>,
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

        if let Some(deviation) = deviation_for(version, &name) {
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
            // Redact every forbidden URI from stderr before the scheme and
            // field checks run. The URIs themselves start with `http`/`https`
            // and contain their own path segments, so leaving them in would
            // let any stderr that merely echoes the URL trivially satisfy
            // these checks. The URI-verbatim side of the pair check below
            // runs against the ORIGINAL stderr, where quoting IS the contract.
            let mut redacted = stderr.clone();
            for forbidden in deviation.forbidden {
                redacted = redacted.replace(forbidden.uri, "");
            }
            let redacted_lower = redacted.to_lowercase();
            // Require: a scheme-policy marker — in the URI-free stderr.
            if !stderr_has_any(&redacted_lower, SECURITY_POLICY_SCHEME_MARKERS) {
                report
                    .deviation_missing_scheme_marker
                    .push(format!("{name}\n  stderr:\n{stderr}"));
                continue;
            }
            // Require: AT LEAST ONE complete (field, URI) pair — the field
            // name named in the URI-free stderr (so echoing the YAML body
            // doesn't count) AND the URI quoted verbatim in the original
            // stderr. A valid validator may stop at the first forbidden
            // reference, so we don't demand every reference be reported.
            let any_pair_named = deviation
                .forbidden
                .iter()
                .any(|f| redacted.contains(f.field) && stderr.contains(f.uri));
            if !any_pair_named {
                let pairs = deviation
                    .forbidden
                    .iter()
                    .map(|f| format!("({:?}, {:?})", f.field, f.uri))
                    .collect::<Vec<_>>()
                    .join(", ");
                report.deviation_missing_matching_pair.push(format!(
                    "{name} (expected at least one of these (field, URI) pairs \
                     to be named in stderr: {pairs})\n  stderr:\n{stderr}",
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
        report.deviation_missing_scheme_marker.is_empty(),
        "{} OAI {version}/pass deviation scenarios were rejected, but stderr \
         names no scheme-policy marker (scheme/security/policy/network/forbidden/\
         not allowed). The rejection must be unambiguously the security policy, \
         not an incidental parse error. Affected files:\n---\n{}\n---",
        report.deviation_missing_scheme_marker.len(),
        report.deviation_missing_scheme_marker.join("\n---\n")
    );
    assert!(
        report.deviation_missing_matching_pair.is_empty(),
        "{} OAI {version}/pass deviation scenarios were rejected without stderr \
         naming at least ONE complete (field, URI) pair from the fixture. An \
         operator must see which specific forbidden reference tripped the \
         policy. Affected files:\n---\n{}\n---",
        report.deviation_missing_matching_pair.len(),
        report.deviation_missing_matching_pair.join("\n---\n")
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
/// fixture AND the exact forbidden URI it declares is actually bound to
/// the declared field (`$self` or `extends`) in that fixture, not merely
/// present somewhere in the bytes. If an upstream rename moves the URI
/// to a different field, or a URI edit changes its value, this test
/// fails loudly instead of silently dropping coverage.
#[test]
fn policy_deviations_manifest_matches_vendored_fixtures() {
    for deviation in POLICY_DEVIATIONS {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/overlay/oai_tests")
            .join(deviation.version)
            .join("pass")
            .join(deviation.file);
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "POLICY_DEVIATIONS entry {}/pass/{} is not a vendored fixture ({path:?}): {e}",
                deviation.version, deviation.file,
            )
        });
        let parsed: serde_yml::Value = serde_yml::from_str(&contents).unwrap_or_else(|e| {
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
