//! Real-world overlay regression fixtures.
//!
//! Each subdirectory under `tests/openapi/overlay/real_world/` is a `(spec,
//! overlay, expected)` triple. The test applies `overlay` to `spec` and
//! asserts the parsed YAML tree matches `expected`. Any silent drift in
//! forge's apply semantics on a known-good overlay surfaces here.
//!
//! See `tests/openapi/overlay/real_world/README.md` for the per-fixture
//! source, license, and upstream commit SHA.

use std::fs;
use std::path::{Path, PathBuf};

use crate::common::{overlay, text};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/openapi/overlay/real_world")
}

/// Every subdirectory of `real_world/` that holds a triple.
fn fixtures() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(root())
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    v
}

fn spec_overlay_expected(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    // Pick the first matching extension so new fixtures can use `.json`
    // without changing this module.
    let pick = |stem: &str| {
        for ext in ["yaml", "yml", "json"] {
            let p = dir.join(format!("{stem}.{ext}"));
            if p.exists() {
                return p;
            }
        }
        panic!("missing {stem}.{{yaml,yml,json}} in {}", dir.display());
    };
    (pick("spec"), pick("overlay"), pick("expected"))
}

#[test]
fn every_fixture_applies_cleanly_and_matches_expected() {
    let fixtures = fixtures();
    assert!(
        !fixtures.is_empty(),
        "no real-world fixtures found under {}",
        root().display()
    );

    for dir in fixtures {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let (spec, ov, expected) = spec_overlay_expected(&dir);

        let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
        assert!(
            out.status.success(),
            "{name}: `forge openapi overlay` failed: {}",
            text(&out.stderr)
        );

        // Both sides must parse. We deliberately do NOT compare bytes: forge's
        // YAML emitter is free to reshape whitespace. A tree comparison still
        // fires on any semantic drift (added, dropped, or mutated nodes).
        let actual: serde_json::Value = serde_saphyr::from_slice(&out.stdout).unwrap_or_else(|e| {
            panic!(
                "{name}: forge stdout is not valid YAML: {e}\n--- stdout ---\n{}",
                text(&out.stdout)
            )
        });
        let want_bytes = fs::read(&expected).unwrap();
        let want: serde_json::Value = serde_saphyr::from_slice(&want_bytes).unwrap_or_else(|e| {
            panic!("{name}: expected.yaml is not valid YAML: {e}");
        });

        if actual != want {
            let a = text(&out.stdout);
            let w = std::str::from_utf8(&want_bytes).unwrap_or("<non-utf8>");
            let head = |s: &str, n: usize| s.lines().take(n).collect::<Vec<_>>().join("\n");
            panic!(
                "{name}: parsed output does not match expected.yaml.\n\
                 lines: actual={} expected={}\n\
                 bytes: actual={} expected={}\n\
                 --- actual (first 20 lines) ---\n{}\n\
                 --- expected (first 20 lines) ---\n{}",
                a.lines().count(),
                w.lines().count(),
                a.len(),
                w.len(),
                head(a, 20),
                head(w, 20),
            );
        }
    }
}
