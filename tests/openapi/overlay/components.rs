//! Tests for Overlay 1.2 features: `components.actions` (reusable
//! actions), `$ref` references, the `$self` document identifier, and the
//! stricter `extends` URI rules.
//!
//! The 1.2 spec adds a `components.actions` map holding named reusable
//! action definitions. An action in the top-level `actions` list may
//! substitute itself for one of these by setting `$ref` to its component
//! fragment. A Reusable Action Reference Object is exactly
//! `{"$ref": "#/components/actions/<name>", "target": "...", "description"?,
//! "x-*"?}`; direct `update`, `copy`, `remove` on the reference site are
//! not permitted. The referenced reusable action's `fields` object is an
//! Action Object where no field is required and `target` MUST NOT appear —
//! `fields.update`, `fields.copy`, and `fields.remove` are all valid.
//!
//! 1.2 §Base URI rules: `$self` (optional) identifies the overlay
//! document. It MAY be relative — in which case it is resolved against the
//! retrieval URI. It MUST NOT carry a URI fragment. `extends` follows the
//! same no-fragment rule and is resolved against `$self` when `$self` is
//! an absolute URI. These rules are document-level validation and apply
//! in both Mode A (where forge resolves `extends`) and Mode B (where
//! forge already has the target spec).

use crate::common::{SPEC, apply, dir, failed_with, files, overlay, succeeded, text};
use std::fs;

// --- Reusable action references (semantics) -----------------------------

/// 1.2 §Components. A reusable action under `components.actions.<name>`
/// with `fields.update` is applied at the reference's target.
#[test]
fn v12_reusable_update_action_applies_at_reference_target() {
    let doc = apply(
        "v12-reusable-update",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "errorResponse": {
        "fields": {
          "update": {"404": {"description": "Not Found"}}
        }
      }
    }
  },
  "actions": [
    {"$ref": "#/components/actions/errorResponse", "target": "$.paths.*.get.responses"}
  ]
}"##,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["responses"]["404"]["description"],
        "Not Found"
    );
    assert_eq!(doc["paths"]["/a"]["get"]["responses"]["200"]["description"], "ok");
}

/// 1.2 §Components. A reusable action's `fields.copy` is applied at the
/// reference's target. `fields.copy` is a plain Action Object field and is
/// explicitly allowed.
#[test]
fn v12_reusable_copy_action_applies_at_reference_target() {
    let doc = apply(
        "v12-reusable-copy",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "copyTitleIn": {
        "fields": {"copy": "$.info.title"}
      }
    }
  },
  "actions": [
    {"target": "$.info", "update": {"description": "placeholder"}},
    {"$ref": "#/components/actions/copyTitleIn", "target": "$.info.description"}
  ]
}"##,
    );

    assert_eq!(
        doc["info"]["description"], "t",
        "copy of info.title landed at info.description"
    );
}

/// 1.2 §Components. A reusable action's `fields.remove` is applied at the
/// reference's target. `fields.remove` is a plain Action Object field and is
/// explicitly allowed.
#[test]
fn v12_reusable_remove_action_applies_at_reference_target() {
    let doc = apply(
        "v12-reusable-remove",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "dropOperation": {"fields": {"remove": true}}
    }
  },
  "actions": [
    {"$ref": "#/components/actions/dropOperation", "target": "$.paths[\"/a\"].get"}
  ]
}"##,
    );

    assert!(
        doc["paths"]["/a"].get("get").is_none(),
        "remove via reusable action dropped the operation"
    );
}

/// 1.2 §Components. A reusable action whose `fields` is empty (`{}`) is a
/// valid no-op: the reference's `target` still MUST select and the action
/// executes against each selected node, but no change is made.
#[test]
fn v12_reusable_empty_fields_is_a_valid_noop() {
    let doc = apply(
        "v12-reusable-empty-fields",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {"actions": {"doNothing": {"fields": {}}}},
  "actions": [
    {"$ref": "#/components/actions/doNothing", "target": "$.info"}
  ]
}"##,
    );

    assert_eq!(doc["info"]["title"], "t");
    assert_eq!(doc["info"]["version"], "1");
    assert!(doc["info"].get("description").is_none());
}

/// 1.2 §Components. `x-*` extensions on the `$ref` site are permitted and
/// do not interfere with application of the referenced fields.
#[test]
fn v12_reference_site_extension_is_accepted() {
    let doc = apply(
        "v12-reference-ext",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "setDescription": {"fields": {"update": {"description": "updated"}}}
    }
  },
  "actions": [
    {
      "$ref": "#/components/actions/setDescription",
      "target": "$.info",
      "x-reference-extension": {"applied": true}
    }
  ]
}"##,
    );

    assert_eq!(doc["info"]["description"], "updated");
}

/// 1.2 §Components. A reference site MAY carry an optional `description`
/// alongside a reusable action that itself carries a `description`. The
/// overlay is accepted and the reusable action still applies.
///
/// **Honesty note:** the spec's override rule (reference-site description
/// wins over the reusable action's description) governs overlay metadata
/// that does not appear in the applied spec, so a CLI-only black-box test
/// cannot observe the override. We retain this as an acceptance test only;
/// the override semantics are intentionally untested at this layer and
/// belong in an internal parser/resolver unit test when one exists.
#[test]
fn v12_reference_site_description_coexists_with_reusable_description() {
    let doc = apply(
        "v12-ref-description-coexists",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "setDescription": {
        "description": "reusable-level description",
        "fields": {"update": {"description": "updated"}}
      }
    }
  },
  "actions": [
    {
      "$ref": "#/components/actions/setDescription",
      "target": "$.info",
      "description": "reference-site description"
    }
  ]
}"##,
    );

    assert_eq!(doc["info"]["description"], "updated");
}

/// 1.2 §Components. JSON Pointer in `$ref` uses standard escapes: `~0`
/// for `~`, `~1` for `/`. A correctly escaped lookup resolves.
#[test]
fn v12_reference_with_escaped_component_key() {
    let doc = apply(
        "v12-escaped-ref",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "error-response/v1~beta": {
        "fields": {"update": {"404": {"description": "Not Found"}}}
      }
    }
  },
  "actions": [
    {
      "$ref": "#/components/actions/error-response~1v1~0beta",
      "target": "$.paths.*.get.responses"
    }
  ]
}"##,
    );

    assert_eq!(
        doc["paths"]["/a"]["get"]["responses"]["404"]["description"],
        "Not Found"
    );
}

/// 1.2 §Components. An incorrectly escaped component name (`~` or `/`
/// written unescaped, or the wrong escape) does NOT resolve and is
/// rejected as an unknown reference target.
#[test]
fn v12_reference_with_unescaped_pointer_segment_is_rejected() {
    // The component is literally named `with/slash` — a client MUST write
    // `~1` to reach it. Writing `/` unescaped parses as two pointer
    // segments (`with` then `slash`), which don't exist.
    let (spec, ov) = files(
        "v12-unescaped-ref",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {"with/slash": {"fields": {"update": {"description": "x"}}}}
  },
  "actions": [
    {"$ref": "#/components/actions/with/slash", "target": "$.info"}
  ]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["$ref", "with/slash", "components.actions", "unknown", "pointer"],
    );
}

/// 1.2 §Components. A `$ref` pointing at an unknown component is rejected.
#[test]
fn v12_reference_to_unknown_component_is_rejected() {
    let (spec, ov) = files(
        "v12-unknown-ref",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {"actions": {"knownOne": {"fields": {"update": {"x": 1}}}}},
  "actions": [
    {"$ref": "#/components/actions/missingOne", "target": "$.info"}
  ]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["$ref", "missingOne", "components.actions", "unknown"],
    );
}

/// 1.2 §Components. A `$ref` with the wrong pointer prefix is rejected.
/// Only `#/components/actions/<name>` is a valid reusable-action
/// reference; `#/components/foo/<name>`, a pointer outside `#/components`,
/// or a bare fragment-less string are all errors.
#[test]
fn v12_reference_with_malformed_pointer_prefix_is_rejected() {
    for (name, bad_ref) in [
        ("prefix-wrong-components-subtree", "#/components/badSection/foo"),
        ("prefix-outside-components", "#/paths/~1a/get"),
        ("prefix-no-fragment", "components/actions/foo"),
        ("prefix-empty", ""),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "components": {{"actions": {{"foo": {{"fields": {{"update": {{"x": 1}}}}}}}}}},
  "actions": [
    {{"$ref": "{bad_ref}", "target": "$.info"}}
  ]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["$ref", "components/actions", "invalid", "unknown"],
        );
    }
}

/// 1.2 §Components. A reusable action MUST declare its action fields under
/// `fields`. Peer `target`, `update`, `copy`, or `remove` next to `fields`
/// is rejected.
#[test]
fn v12_reusable_action_peer_action_fields_rejected() {
    for (name, peer) in [
        ("v12-peer-target", r##""target": "$.info""##),
        ("v12-peer-update", r##""update": {"description": "wrong"}"##),
        ("v12-peer-copy", r##""copy": "$.info.title""##),
        ("v12-peer-remove", r##""remove": true"##),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "components": {{
    "actions": {{
      "setDescription": {{
        {peer},
        "fields": {{"update": {{"description": "d"}}}}
      }}
    }}
  }},
  "actions": [{{"target": "$", "update": {{"x-marker": 1}}}}]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["fields", "components.actions", "peer", "unknown"],
        );
    }
}

/// 1.2 §Components. `target` is forbidden inside `fields` on a reusable
/// action — it must come from the reference site.
#[test]
fn v12_reusable_fields_cannot_contain_target() {
    let (spec, ov) = files(
        "v12-fields-target",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "setDescription": {
        "fields": {"target": "$.info", "update": {"description": "d"}}
      }
    }
  },
  "actions": [
    {"$ref": "#/components/actions/setDescription", "target": "$.info"}
  ]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["fields", "target", "reference", "forbidden"],
    );
}

/// 1.2 §Components. A Reusable Action Reference Object (`$ref` + `target`)
/// MUST NOT carry `update`, `copy`, or `remove` directly — those belong in
/// the referenced reusable action's `fields`.
#[test]
fn v12_reference_object_cannot_carry_action_fields_directly() {
    for (name, extra) in [
        ("ref-with-update", r##""update": {"description": "d"}"##),
        ("ref-with-copy", r##""copy": "$.info.title""##),
        ("ref-with-remove", r##""remove": true"##),
    ] {
        let (spec, ov) = files(
            name,
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "components": {{
    "actions": {{"setDescription": {{"fields": {{"update": {{"description": "d"}}}}}}}}
  }},
  "actions": [
    {{
      "$ref": "#/components/actions/setDescription",
      "target": "$.info",
      {extra}
    }}
  ]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["$ref", "reference", "update", "copy", "remove"],
        );
    }
}

/// 1.2 §Components. A reusable action reference MUST carry a `target`.
#[test]
fn v12_reference_without_target_is_rejected() {
    let (spec, ov) = files(
        "v12-ref-no-target",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {"setDescription": {"fields": {"update": {"description": "u"}}}}
  },
  "actions": [{"$ref": "#/components/actions/setDescription"}]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["target", "$ref"],
    );
}

// --- $self and extends base-URI rules -----------------------------------
//
// 1.2 §Base URI. `$self` (optional) names the overlay document. If present
// and absolute, it becomes the base URI for resolving `extends`. If
// present and relative, it is first resolved against the next available
// RFC 3986 base source — here, the overlay's retrieval URI. If absent,
// the overlay's retrieval URI is the base. Neither `$self` nor `extends`
// may contain a URI fragment.

/// 1.2 §Base URI. `$self` MAY be absolute. Under Forge's restricted
/// security profile the only safe absolute scheme is `file:` (http/https
/// are rejected cross-version — see
/// `validation::self_with_http_scheme_is_rejected_in_every_mode`). An
/// absolute `file:` `$self` is accepted and the overlay applies normally
/// in Mode B.
#[test]
fn v12_absolute_file_self_identifier_is_accepted() {
    let doc = apply(
        "v12-self-absolute-file",
        r##"{
  "overlay": "1.2.0",
  "$self": "file:///identifiers/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. `$self` with a `urn:` scheme is also accepted — it's an
/// identity label, never fetched.
#[test]
fn v12_absolute_urn_self_identifier_is_accepted() {
    let doc = apply(
        "v12-self-urn",
        r##"{
  "overlay": "1.2.0",
  "$self": "urn:example:overlays:fix",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. `$self` MAY be relative. A relative `$self` is resolved
/// against the overlay retrieval URI and is accepted in Mode B.
#[test]
fn v12_relative_self_identifier_is_accepted() {
    let doc = apply(
        "v12-self-relative",
        r##"{
  "overlay": "1.2.0",
  "$self": "fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. Neither `$self` nor `extends` may contain a URI
/// fragment. Rejected for every `$self` form (absolute `file:`, relative,
/// fragment-only) in Mode B. Fragment validation is kept separate from
/// scheme validation: these tests use `file:` and relative forms so a
/// scheme-policy rejection cannot masquerade as a fragment rejection.
#[test]
fn v12_self_with_fragment_is_rejected_mode_b() {
    for bad in [
        "file:///identifiers/fix.json#/section",
        "./fix.json#/section",
        "#frag-only",
    ] {
        let (spec, ov) = files(
            &format!("v12-self-fragment-mode-b-{}", bad.replace(['/', '.', '#', ':'], "_")),
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "$self": "{bad}",
  "info": {{"title": "fix", "version": "1"}},
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
            &["$self", "fragment", "#"],
        );
    }
}

/// 1.2 §Base URI. Same `$self` fragment rule, verified in Mode A (no
/// explicit target on the command line). Document validation does not
/// depend on how forge was invoked. Uses `file:` / relative bases so the
/// rejection is unambiguously about the fragment, not the scheme.
#[test]
fn v12_self_with_fragment_is_rejected_mode_a() {
    for bad in [
        "file:///identifiers/fix.json#/section",
        "./fix.json#/section",
        "#frag-only",
    ] {
        let d = dir(&format!(
            "v12-self-fragment-mode-a-{}",
            bad.replace(['/', '.', '#', ':'], "_")
        ));
        fs::write(d.join("spec.json"), SPEC).unwrap();
        fs::write(
            d.join("overlay.json"),
            format!(
                r##"{{
  "overlay": "1.2.0",
  "$self": "{bad}",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "./spec.json",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"##
            ),
        )
        .unwrap();
        failed_with(
            overlay(&[d.join("overlay.json").to_str().unwrap()], ""),
            &["$self", "fragment", "#"],
        );
    }
}

/// 1.2 §Base URI. `extends` with a URI fragment is rejected. Covers both
/// Mode A (where we would resolve it) and Mode B (where we would not), and
/// both relative and absolute forms of the base URI. Document validation,
/// not runtime fetching: the fragment is a schema error regardless of mode.
#[test]
fn v12_extends_with_fragment_is_rejected_in_every_mode() {
    // Mode A: `forge openapi overlay <overlay-path>` (no explicit target). Relative.
    let d = dir("v12-extends-fragment-mode-a-relative");
    fs::write(d.join("spec.json"), SPEC).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json#/paths/~1a",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();
    failed_with(
        overlay(&[d.join("overlay.json").to_str().unwrap()], ""),
        &["extends", "fragment", "#"],
    );

    // Mode A: `forge openapi overlay <overlay-path>`. Absolute `file:` base.
    let d = dir("v12-extends-fragment-mode-a-absolute");
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "file:///openapi.yaml#/paths/~1a",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();
    failed_with(
        overlay(&[d.join("overlay.json").to_str().unwrap()], ""),
        &["extends", "fragment", "#"],
    );

    // Mode B: `forge openapi overlay <spec> <overlay>`. Relative.
    let (spec, ov) = files(
        "v12-extends-fragment-mode-b-relative",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.yaml#/paths/~1a",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );
    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["extends", "fragment", "#"],
    );

    // Mode B: `forge openapi overlay <spec> <overlay>`. Absolute `file:`
    // base.
    let (spec, ov) = files(
        "v12-extends-fragment-mode-b-absolute",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "file:///openapi.yaml#/paths/~1a",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );
    failed_with(
        overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], ""),
        &["extends", "fragment", "#"],
    );
}

/// 1.2 §Base URI. No `$self`: the overlay's retrieval URI is the base. A
/// relative `extends` therefore resolves to a sibling file next to the
/// overlay. Mode A invocation.
#[test]
fn v12_mode_a_no_self_resolves_extends_against_overlay_retrieval_uri() {
    let d = dir("v12-no-self-mode-a");
    fs::write(d.join("spec.json"), SPEC).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[d.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. Absolute `$self` paired with a relative `extends`
/// resolves `extends` against `$self`, not against the overlay file's
/// directory on disk. With a `file:` `$self`, the resolved identifier is
/// a `file:` URI pointing at a path that does not exist on this
/// machine — forge MUST error naming the resolved identifier, not
/// silently reinterpret the reference as a sibling file.
#[test]
fn v12_mode_a_absolute_self_resolves_extends_against_self_not_disk() {
    let d = dir("v12-self-absolute-with-relative-extends");
    // DECOY: a file right next to the overlay with the same relative
    // name, tagged with a sentinel title so we can positively detect
    // accidental coercion. If forge wrongly uses the on-disk directory
    // as the base it loads this file; the test asserts that tag never
    // reaches stdout.
    let decoy_spec = r##"{
  "openapi": "3.0.3",
  "info": {"title": "DECOY-MUST-NOT-LOAD", "version": "1"},
  "paths": {"/a": {"get": {"operationId": "aGet", "responses": {"200": {"description": "ok"}}}}}
}"##;
    fs::write(d.join("openapi.yaml"), decoy_spec).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "$self": "file:///identifiers/overlays/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[d.join("overlay.json").to_str().unwrap()], "");
    assert!(
        !out.status.success(),
        "forge succeeded; it almost certainly loaded the decoy sibling file. stdout:\n{}",
        text(&out.stdout)
    );
    let stdout = text(&out.stdout);
    let stderr = text(&out.stderr);
    assert!(
        !stdout.contains("DECOY-MUST-NOT-LOAD"),
        "the decoy sibling file was loaded. stdout:\n{stdout}"
    );
    // The error must positively name the resolved identifier (under
    // `/identifiers/overlays/`), not the decoy's actual location.
    assert!(
        stderr.contains("/identifiers/overlays/openapi.yaml") || stderr.contains("file:///identifiers"),
        "error does not name the resolved identifier (should mention the file:/// path \
         under /identifiers/overlays/, not the decoy's path): {stderr}"
    );
}

/// 1.2 §Base URI, rule 5. Absolute `$self` + relative `extends` resolves
/// via RFC 3986. When Mode B is invoked with a target file whose own
/// `$self` matches the resolved identifier, the overlay applies against
/// that target without any fetch.
#[test]
fn v12_mode_b_extends_identifier_matches_target_self() {
    let d = dir("v12-extends-matches-target-self");
    // Target spec declares its own `$self` as a plain identity label.
    let target_spec = r##"{
  "openapi": "3.0.3",
  "$self": "file:///identifiers/openapi.yaml",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"##;
    fs::write(d.join("spec.json"), target_spec).unwrap();
    fs::write(
        d.join("overlay.json"),
        // $self is `file:///identifiers/overlays/fix.overlay.json`, extends
        // is `../openapi.yaml`. RFC 3986 resolves that to
        // `file:///identifiers/openapi.yaml`, which matches target_spec's $self.
        r##"{
  "overlay": "1.2.0",
  "$self": "file:///identifiers/overlays/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "../openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(
        &[
            d.join("spec.json").to_str().unwrap(),
            d.join("overlay.json").to_str().unwrap(),
        ],
        "",
    );
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI, rule 5 (negative). Mode B with a target file whose
/// `$self` does NOT match the overlay's resolved `extends` identifier is
/// rejected: the target the user gave is not the one the overlay was
/// written against.
#[test]
fn v12_mode_b_extends_identifier_mismatched_against_target_self_is_rejected() {
    let d = dir("v12-extends-mismatches-target-self");
    let target_spec = r##"{
  "openapi": "3.0.3",
  "$self": "file:///identifiers/other/openapi.yaml",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"##;
    fs::write(d.join("spec.json"), target_spec).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "$self": "file:///identifiers/overlays/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "../openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    failed_with(
        overlay(
            &[
                d.join("spec.json").to_str().unwrap(),
                d.join("overlay.json").to_str().unwrap(),
            ],
            "",
        ),
        &["extends", "$self", "match", "mismatch", "identifier"],
    );
}

/// 1.2 §Base URI, rule 5 (Mode A, negative). The same rule applies even in
/// Mode A, where forge itself chose the spec file via `extends`: if the
/// loaded spec declares a `$self` identifier (e.g. a URN) that disagrees
/// with the resolved extends identifier (a `file:` URI), the overlay was
/// written against a different document and the apply is rejected. This
/// MUST parallel the Mode B rejection — one mode silently accepting what
/// the other rejects is a worse bug than either behaviour on its own.
#[test]
fn v12_mode_a_extends_identifier_mismatched_against_target_self_is_rejected() {
    let d = dir("v12-mode-a-extends-mismatches-target-self");
    let target_spec = r##"{
  "openapi": "3.0.3",
  "$self": "urn:example:some-other-document",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"##;
    fs::write(d.join("spec.json"), target_spec).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    failed_with(
        overlay(&[d.join("overlay.json").to_str().unwrap()], ""),
        &["extends", "$self", "match", "mismatch", "identifier"],
    );
}

/// A relative target `$self` is resolved against the target document's
/// retrieval URI before it is compared with the overlay's resolved
/// `extends` identifier.
#[test]
fn v12_mode_a_relative_target_self_matches_resolved_extends() {
    let d = dir("v12-mode-a-relative-target-self");
    let target_spec = r##"{
  "openapi": "3.2.0",
  "$self": "spec.json",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "operationId": "aGet",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"##;
    fs::write(d.join("spec.json"), target_spec).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "spec.json",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[d.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
}

// --- RFC 3986 two-step resolution with local files only ----------------

/// 1.2 §Base URI, two-step resolution. Overlay with a RELATIVE `$self`
/// plus a RELATIVE `extends`: forge first resolves `$self` against the
/// overlay's retrieval URI (= the overlay's path on disk), then resolves
/// `extends` against the resulting `$self`.
///
/// Layout:
///   tmp/
///     canonical/openapi.yaml        <- the real target (what extends should land on)
///     canonical/overlays/fix.json   <- NOT the overlay we invoke
///     actual/fix.json               <- the overlay we invoke, with a decoy ./openapi.yaml next door
///     actual/openapi.yaml           <- DECOY: present but must not be loaded
///
/// Overlay body:
///   $self: "../canonical/overlays/fix.overlay.json"
///   extends: "../openapi.yaml"
///
/// Step 1: resolve $self against overlay retrieval URI
///         (`<tmp>/actual/fix.json`) → `<tmp>/canonical/overlays/fix.overlay.json`
/// Step 2: resolve extends against resulting $self
///         → `<tmp>/canonical/openapi.yaml`
///
/// If forge skips step 1 and resolves extends directly against the
/// overlay's directory (`<tmp>/actual/`), it would load the decoy.
#[test]
fn v12_mode_a_relative_self_plus_relative_extends_two_step_resolution() {
    let d = dir("v12-two-step-resolution");
    let canonical = d.join("canonical");
    let canonical_overlays = canonical.join("overlays");
    let actual = d.join("actual");
    fs::create_dir_all(&canonical_overlays).unwrap();
    fs::create_dir_all(&actual).unwrap();

    // The correct target, named differently from the decoy's contents so
    // we can tell which file was loaded.
    let mut canonical_spec: serde_json::Value = serde_json::from_str(SPEC).unwrap();
    canonical_spec["info"]["title"] = serde_json::json!("canonical-target");
    fs::write(
        canonical.join("openapi.yaml"),
        serde_json::to_string_pretty(&canonical_spec).unwrap(),
    )
    .unwrap();

    // Decoy next to the overlay we invoke.
    let mut decoy_spec: serde_json::Value = serde_json::from_str(SPEC).unwrap();
    decoy_spec["info"]["title"] = serde_json::json!("decoy-target");
    fs::write(
        actual.join("openapi.yaml"),
        serde_json::to_string_pretty(&decoy_spec).unwrap(),
    )
    .unwrap();

    let overlay_path = actual.join("fix.json");
    fs::write(
        &overlay_path,
        r##"{
  "overlay": "1.2.0",
  "$self": "../canonical/overlays/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "../openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[overlay_path.to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "d");
    assert_eq!(
        doc["info"]["title"], "canonical-target",
        "forge loaded the canonical target (two-step resolution), NOT the decoy sibling"
    );
}

/// 1.2 §Base URI. Mode A with no `$self`: `extends` resolves against the
/// overlay's retrieval URI directly (one-step). A relative `extends`
/// therefore loads a sibling file.
#[test]
fn v12_mode_a_no_self_loads_sibling_extends() {
    let d = dir("v12-no-self-loads-sibling");
    let mut target: serde_json::Value = serde_json::from_str(SPEC).unwrap();
    target["info"]["title"] = serde_json::json!("sibling-target");
    fs::write(d.join("openapi.yaml"), serde_json::to_string_pretty(&target).unwrap()).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[d.join("overlay.json").to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["title"], "sibling-target");
    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. `file:` `$self` is treated as an identity label only
/// — forge never silently reinterprets a non-local resolved URI as a
/// sibling filesystem path. Here the resolved `file:` path exists on
/// disk (in the decoy directory next to the overlay) but DOES NOT match
/// where the resolved identifier points; the error names the resolved
/// identifier.
#[test]
fn v12_file_self_resolved_extends_must_name_resolved_identifier() {
    let d = dir("v12-file-self-missing-target");
    // Decoy present next to overlay.
    fs::write(d.join("openapi.yaml"), SPEC).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "$self": "file:///nonexistent/identifiers/overlays/fix.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "./openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let err = crate::common::failed(overlay(&[d.join("overlay.json").to_str().unwrap()], ""));
    assert!(
        err.contains("/nonexistent/identifiers/overlays/openapi.yaml") || err.contains("file:///nonexistent"),
        "error names the resolved identifier under file:///nonexistent, NOT the decoy sibling path: {err}"
    );
}

/// 1.2 §Base URI. In Mode A with no `$self`, a relative `extends` MUST
/// resolve to a sibling file. If the target file is absent, the error
/// mentions the resolved local path (not a remote URL, not the raw
/// relative string).
#[test]
fn v12_mode_a_missing_relative_extends_reports_resolved_path() {
    let d = dir("v12-missing-relative-extends");
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./does-not-exist.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    )
    .unwrap();

    let out = overlay(&[d.join("overlay.json").to_str().unwrap()], "");
    let err = crate::common::failed(out);
    assert!(
        err.contains("does-not-exist.yaml"),
        "error names the missing target file: {err}"
    );
}

// --- Mode B is still permissive about extends it does not resolve -------

/// 1.2 Mode B. A fragment-free, non-http(s) `extends` is accepted and
/// ignored in Mode B: the target comes from the command line, so `extends`
/// is parsed to validate its shape but never fetched. The proof is
/// success on a well-formed local-ish `extends` value — whether forge
/// logs the fact is a style choice we deliberately don't pin. (http(s)
/// `extends` is a separate rejection, covered cross-version in
/// `validation.rs`.)
#[test]
fn v12_mode_b_accepts_local_extends_without_fetching() {
    for extends in ["./spec.yaml", "openapi.json", "../sibling/spec.yaml"] {
        let (spec, ov) = files(
            &format!("v12-mode-b-extends-{}", extends.replace(['/', ':', '.'], "_")),
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "extends": "{extends}",
  "actions": [{{"target": "$.info", "update": {{"description": "d"}}}}]
}}"##
            ),
        );

        let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
        succeeded(&out);
    }
}

/// 1.2 `$self`/`extends` identity comparison normalizes equivalent URIs
/// (e.g. uppercase scheme `FILE:` vs `file:`, lowercase `%2f` vs `%2F`).
#[test]
fn v12_extends_identity_normalizes_equivalent_uris() {
    let dir = dir("v12-identity-normalize");
    let spec_path = dir.join("spec.json");
    let encoded = crate::common::encode_uri_path(&spec_path);
    fs::write(
        &spec_path,
        format!(
            r#"{{
  "openapi": "3.2.0",
  "$self": "FILE://{encoded}",
  "info": {{"title": "t", "version": "1"}},
  "paths": {{}}
}}"#
        ),
    )
    .unwrap();
    let ov_path = dir.join("ov.json");
    fs::write(
        &ov_path,
        r#"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.json",
  "actions": [{"target": "$.info", "update": {"description": "matched"}}]
}"#,
    )
    .unwrap();

    let out = overlay(&[ov_path.to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "matched");
}

/// 1.2 RFC 6901 §6: percent-encoded octets in reusable-action `$ref` fragments
/// (e.g. `%20` for a space) are decoded before JSON Pointer unescaping.
#[test]
fn v12_reference_with_percent_encoded_component_key() {
    let (spec, ov) = files(
        "v12-ref-percent-encoded",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "set description": {"fields": {"update": {"description": "from-encoded-ref"}}}
    }
  },
  "actions": [{"$ref": "#/components/actions/set%20description", "target": "$.info"}]
}"##,
    );

    let out = overlay(&[spec.to_str().unwrap(), ov.to_str().unwrap()], "");
    succeeded(&out);
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["info"]["description"], "from-encoded-ref");
}
