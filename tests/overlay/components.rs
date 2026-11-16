//! Tests for Overlay 1.2 features: `components.actions` (reusable
//! actions), `$ref` references, the `$self` document identifier, and the
//! stricter `extends` URI rules.
//!
//! The 1.2 spec adds a `components.actions` map holding named reusable
//! action definitions. An action in the top-level `actions` list may
//! substitute itself for one of these by setting `$ref` to its component
//! fragment. The referenced reusable action supplies a `fields` object
//! whose entries (`update`, `description`, extensions) are merged into the
//! reference site, while `target`, `remove`, `copy`, and `x-*` extensions
//! stay on the reference site.

use crate::common::{SPEC, apply, dir, failed_with, overlay, succeeded, text};
use std::fs;

// --- Components / reusable actions --------------------------------------

/// 1.2 §Components. A reusable action under `components.actions.<name>`
/// with a `fields.update` is applied where it's referenced.
#[test]
fn v12_reusable_update_action() {
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

/// 1.2 §Components. `x-*` extensions on the `$ref` site merge alongside
/// the reusable action's fields.
#[test]
fn v12_reference_site_extension() {
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

/// 1.2 §Components. JSON Pointer in `$ref` uses standard escapes: `~0`
/// for `~`, `~1` for `/`.
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

/// 1.2 §Components. A reusable-action reference is only valid against a
/// `#/components/actions/<name>` fragment of the same document. Pointing
/// at an external URI or an unknown name is rejected.
#[test]
fn v12_reference_to_unknown_component_is_rejected() {
    let (spec, ov) = crate::common::files(
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["$ref", "missingOne", "components.actions", "unknown"],
    );
}

/// 1.2 §Components. A reusable action must declare its action fields
/// under `fields`, not as peer properties of itself. A peer `target` or
/// `update` next to `fields` is rejected.
#[test]
fn v12_reusable_action_peer_action_fields_rejected() {
    let (spec, ov) = crate::common::files(
        "v12-peer-fields",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "components": {
    "actions": {
      "setDescription": {
        "target": "$.info",
        "update": {"description": "wrong"}
      }
    }
  },
  "actions": [{"target": "$", "update": {"x-marker": 1}}]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["fields", "components.actions", "peer", "unknown"],
    );
}

/// 1.2 §Components. A reusable action reference MUST carry a `target`.
#[test]
fn v12_reference_without_target_is_rejected() {
    let (spec, ov) = crate::common::files(
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
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["target", "$ref"],
    );
}

/// 1.2 §Components. A reusable action's `fields` block cannot carry
/// `copy` or `remove` — those only make sense on a reference site.
#[test]
fn v12_reusable_fields_cannot_contain_copy_or_remove() {
    for (name, fields) in [
        ("v12-fields-copy", r##"{"copy": "$.info.title"}"##),
        ("v12-fields-remove", r##"{"remove": true}"##),
    ] {
        let (spec, ov) = crate::common::files(
            name,
            SPEC,
            &format!(
                r##"{{
  "overlay": "1.2.0",
  "info": {{"title": "fix", "version": "1"}},
  "components": {{
    "actions": {{"doThing": {{"fields": {fields}}}}}
  }},
  "actions": [{{"$ref": "#/components/actions/doThing", "target": "$.info"}}]
}}"##
            ),
        );

        failed_with(
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
            &["fields", "copy", "remove"],
        );
    }
}

/// Version boundary: a 1.0 overlay with `components` is rejected —
/// components didn't exist in 1.0 or 1.1.
#[test]
fn v10_components_object_is_rejected() {
    let (spec, ov) = crate::common::files(
        "v10-with-components",
        SPEC,
        r##"{
  "overlay": "1.0.0",
  "info": {"title": "fix", "version": "1"},
  "components": {"actions": {"foo": {"fields": {"update": {"x": 1}}}}},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    failed_with(
        overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
        &["components", "1.0", "unknown", "unsupported"],
    );
}

// --- $self identifier and extends URI rules -----------------------------

/// 1.2 §Base URI. `$self` sets the overlay document's base URI. In Mode
/// B, `extends` is still ignored (so we accept any value here); the point
/// is that `$self` itself is schema-valid and parsed.
#[test]
fn v12_self_identifier_is_accepted_in_mode_b() {
    let doc = apply(
        "v12-self-in-mode-b",
        r##"{
  "overlay": "1.2.0",
  "$self": "https://example.com/overlays/fix.overlay.json",
  "info": {"title": "fix", "version": "1"},
  "extends": "./openapi.yaml",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    assert_eq!(doc["info"]["description"], "d");
}

/// 1.2 §Base URI. In Mode A, a `$self` URI pairs with a relative `extends`
/// to produce the resolved spec URI. When `$self` is present the overlay
/// may still carry a real relative `extends` that resolves to a local file
/// relative to the overlay's directory (Mode A's usual behavior); `$self`
/// doesn't disable local-file resolution.
#[test]
fn v12_mode_a_self_plus_relative_extends_resolves_local_file() {
    let d = dir("v12-self-local-extends");
    fs::write(d.join("spec.json"), SPEC).unwrap();
    fs::write(
        d.join("overlay.json"),
        r##"{
  "overlay": "1.2.0",
  "$self": "https://example.com/overlays/fix.overlay.json",
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

/// 1.2 §Base URI. `$self` MUST be an absolute URI. A relative or
/// fragment-only `$self` is rejected.
#[test]
fn v12_self_must_be_absolute_uri() {
    for bad in ["./not-absolute", "#frag-only", "foo"] {
        let (spec, ov) = crate::common::files(
            &format!("v12-self-{}", bad.replace(['/', '.', '#'], "_")),
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
            overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], ""),
            &["$self", "absolute", "uri"],
        );
    }
}

/// 1.2 §Extends. `extends` with a URI fragment is rejected: a fragment
/// doesn't identify a complete OpenAPI document.
#[test]
fn v12_extends_with_fragment_is_rejected() {
    let d = dir("v12-extends-fragment");
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
}

/// 1.2 Mode B. `extends` is ignored and NOT resolved even when it has a
/// fragment — we never fetch `extends` in Mode B. The info-level log
/// mentions `extends` as before.
#[test]
fn v12_mode_b_ignores_extends_with_fragment_without_rejecting() {
    let (spec, ov) = crate::common::files(
        "v12-mode-b-extends-fragment",
        SPEC,
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1"},
  "extends": "./spec.yaml#/paths/~1a",
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    let out = overlay(&[spec.to_str().unwrap(), "--overlay", ov.to_str().unwrap()], "");
    succeeded(&out);
    assert!(
        text(&out.stderr).to_lowercase().contains("extends"),
        "info log mentions extends: {}",
        text(&out.stderr)
    );
}

/// 1.2 §Info. `info.description` is a new optional string field.
#[test]
fn v12_info_description_is_accepted() {
    let doc = apply(
        "v12-info-description",
        r##"{
  "overlay": "1.2.0",
  "info": {"title": "fix", "version": "1", "description": "a *CommonMark* string"},
  "actions": [{"target": "$.info", "update": {"description": "d"}}]
}"##,
    );

    assert_eq!(doc["info"]["description"], "d");
}
