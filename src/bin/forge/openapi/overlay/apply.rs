//! Apply one action to a document: `remove`, `update`, `copy`.
//!
//! The spec semantics are version-dispatched: 1.0 is strict about
//! primitive targets and replaces arrays-under-properties; 1.1+ permits
//! primitive-replacement, concatenates arrays under array-valued properties,
//! and introduces `copy`.

use std::fmt::Write as _;

use forge::Err;
use serde_json::Value;
use serde_json_path::{LocatedNode, NormalizedPath, PathElement};

use super::action::Fields;
use super::document::{Document, type_name};
use super::parsed::Version;
use super::path::{Path, PointerList, Seg};
use super::uri;

/// What one overlay action did when it ran.
pub(super) struct ActionReport<'a> {
    verb: Verb,
    target: &'a str,
    pub(super) matched: usize,
    pub(super) mutated: usize,
    copy_source: Option<&'a str>,
    pub(super) ref_name: Option<&'a str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verb {
    Update,
    Remove,
    Copy,
    Noop,
}

impl Verb {
    fn as_str(self) -> &'static str {
        match self {
            Verb::Update => "update",
            Verb::Remove => "remove",
            Verb::Copy => "copy",
            Verb::Noop => "noop",
        }
    }
}

impl ActionReport<'_> {
    /// Human-readable summary of one action: "<verb> <target> — <result>",
    /// prefixed when `ref_name` is set with "ref=<name> ".
    pub(super) fn format(&self) -> String {
        let prefix = match self.ref_name {
            Some(n) => format!("ref={n} "),
            None => String::new(),
        };
        let result = self.describe_result();
        format!("{prefix}{} {} — {result}", self.verb.as_str(), self.target)
    }

    fn describe_result(&self) -> String {
        if self.matched == 0 {
            return "matched 0 nodes — no-op (zero-match actions are silent per spec)".to_owned();
        }
        let nodes = if self.mutated == 1 { "node" } else { "nodes" };
        let matched_nodes = if self.matched == 1 { "node" } else { "nodes" };
        match self.verb {
            Verb::Update => {
                if self.mutated == 0 {
                    format!("matched {} {matched_nodes}, mutated 0 nodes", self.matched)
                } else {
                    format!("updated {} {nodes}", self.mutated)
                }
            }
            Verb::Remove => format!("removed {} {nodes}", self.mutated),
            Verb::Copy => {
                let src = self.copy_source.unwrap_or("?");
                if self.mutated == 0 {
                    format!(
                        "matched {} {matched_nodes}, mutated 0 nodes (source {src})",
                        self.matched
                    )
                } else {
                    format!("copied {} {nodes} from {src} to {}", self.mutated, self.target)
                }
            }
            Verb::Noop => format!("matched {} {matched_nodes}, action had no verb", self.matched),
        }
    }
}

pub(super) fn apply_action<'a>(
    doc: &mut Document,
    version: Version,
    target: &'a Path,
    fields: &'a Fields,
    overlay_base: Option<&str>,
    spec_base: Option<&str>,
) -> Result<ActionReport<'a>, Err> {
    // Precedence: remove > update > copy (per spec).
    if fields.remove {
        let nodes = target.query_deduped(doc.value());
        let matched = nodes.len();
        // Pre-scan: a root pointer `$` is a non-starter for remove (would leave
        // nothing downstream can use). Reject before any mutation so a mixed
        // nodelist of `[root, child]` doesn't half-apply before the root error.
        for n in &nodes {
            if n.location().is_empty() {
                return Err(root_remove_error());
            }
        }
        let mutated = if matched == 0 {
            0
        } else {
            let mut pointers = PointerList::from_located(&nodes);
            drop(nodes);
            apply_remove(doc, &mut pointers)?
        };
        return Ok(ActionReport {
            verb: Verb::Remove,
            target: target.source(),
            matched,
            mutated,
            copy_source: None,
            ref_name: None,
        });
    }

    // If there is an update, copy is ignored.
    if let Some(update_val) = &fields.update {
        let (matched, mutated) = apply_update(doc, version, target, update_val, overlay_base, spec_base)?;
        return Ok(ActionReport {
            verb: Verb::Update,
            target: target.source(),
            matched,
            mutated,
            copy_source: None,
            ref_name: None,
        });
    }

    if let Some(copy_src) = &fields.copy {
        let (matched, mutated) = apply_copy(doc, version, target, copy_src)?;
        return Ok(ActionReport {
            verb: Verb::Copy,
            target: target.source(),
            matched,
            mutated,
            copy_source: Some(copy_src.source()),
            ref_name: None,
        });
    }

    // No fields => no-op.
    let matched = target.query_deduped(doc.value()).len();
    Ok(ActionReport {
        verb: Verb::Noop,
        target: target.source(),
        matched,
        mutated: 0,
        copy_source: None,
        ref_name: None,
    })
}

fn apply_remove(doc: &mut Document, pointers: &mut PointerList) -> Result<usize, Err> {
    pointers.sort_for_remove();
    let mut removed = 0usize;
    for idx in 0..pointers.len() {
        if remove_at(doc.value_mut(), pointers, idx)? {
            doc.mark_mutated();
            removed += 1;
        }
    }
    Ok(removed)
}

fn remove_at(root: &mut Value, pointers: &PointerList, idx: usize) -> Result<bool, Err> {
    let segs = pointers.segs(idx);
    let Some((&last, parent_segs)) = segs.split_last() else {
        // Belt-and-suspenders: apply_action pre-scans for root pointers, so
        // this branch should be unreachable.
        return Err(root_remove_error());
    };
    let Some(parent) = pointers.resolve_mut(root, parent_segs) else {
        return Ok(false); // Already gone.
    };
    match (parent, last) {
        (Value::Object(map), Seg::Name(s, e)) => Ok(map.shift_remove(pointers.name(s, e)).is_some()),
        (Value::Array(arr), Seg::Index(i)) => {
            if i < arr.len() {
                arr.remove(i);
                Ok(true)
            } else {
                Ok(false) // Index past the array's current end — already gone.
            }
        }
        // Type mismatch at the terminal segment: name against array, index
        // against object, or any segment against a primitive. A silent no-op
        // here would hide a misaimed target.
        (parent, last) => {
            let seg_kind = match last {
                Seg::Name(_, _) => "name",
                Seg::Index(_) => "array index",
            };
            Err(format!(
                "action remove: target at `{}` resolves to a {} but the trailing \
                 selector is a {seg_kind}; nothing to remove",
                segs_to_jsonpath(pointers, segs),
                type_name(parent),
            )
            .into())
        }
    }
}

/// Shared error for a `remove` action whose target selects the document
/// root. Named so `apply_action`'s pre-scan and `remove_at`'s belt-and-
/// suspenders branch stay in sync.
fn root_remove_error() -> Err {
    "action remove: cannot remove the root of the document \
     (target `$`). If you meant to clear and replace the spec, \
     use `update` with a full replacement value; if you meant \
     to remove a child, tighten the target (e.g. `$.servers` \
     instead of `$`)."
        .into()
}

fn apply_update(
    doc: &mut Document,
    version: Version,
    target: &Path,
    update: &Value,
    overlay_base: Option<&str>,
    spec_base: Option<&str>,
) -> Result<(usize, usize), Err> {
    let nodes = target.query_deduped(doc.value());
    let matched = nodes.len();
    if matched == 0 {
        return Ok((0, 0));
    }

    if !version.allows_primitive_update() {
        reject_v10_primitive_in_update(&nodes)?;
    }
    enforce_homogeneous_category(&nodes)?;

    // Fast path: when the update payload contains no relative `$ref` (the
    // common case), skip per-target context classification and payload cloning.
    let needs_rebase = overlay_base.is_some() && contains_relative_ref(update);
    let mut contexts = Vec::new();
    let mut rebased_normal = None;
    let mut rebased_entry_map = None;
    if needs_rebase {
        contexts.reserve(matched);
        let mut has_normal = false;
        let mut has_entry_map = false;
        for n in &nodes {
            let ctx = classify_target_location(n.location(), category_of(n.node()));
            match ctx {
                TargetRebaseContext::Normal => has_normal = true,
                TargetRebaseContext::EntryMap => has_entry_map = true,
                TargetRebaseContext::Literal => {}
            }
            contexts.push(ctx);
        }
        if has_normal {
            let mut cloned = update.clone();
            rebase_refs(&mut cloned, overlay_base, spec_base, false)?;
            rebased_normal = Some(cloned);
        }
        if has_entry_map {
            let mut cloned = update.clone();
            rebase_refs(&mut cloned, overlay_base, spec_base, true)?;
            rebased_entry_map = Some(cloned);
        }
    }

    let value_for = |idx: usize| -> &Value {
        if !needs_rebase {
            return update;
        }
        match contexts[idx] {
            TargetRebaseContext::Literal => update,
            TargetRebaseContext::Normal => rebased_normal.as_ref().unwrap_or(update),
            TargetRebaseContext::EntryMap => rebased_entry_map.as_ref().unwrap_or(update),
        }
    };

    for (idx, n) in nodes.iter().enumerate() {
        let val = value_for(idx);
        match n.node() {
            Value::Object(tgt) => {
                let Some(upd) = val.as_object() else {
                    return Err(format!(
                        "action update: object target requires an object update value, got {}",
                        type_name(val)
                    )
                    .into());
                };
                // Precheck: merging an object update into an object target
                // rejects incompatible nested property categories up front so
                // a multi-match update never partially mutates before failing.
                check_nested_merge_compat("update", tgt, upd)?;
            }
            Value::Array(_) => {
                // Array target: any update value is allowed (array is
                // concatenated in 1.1+, primitive/object is appended).
            }
            _ => {
                // Overlay 1.0 primitives are already rejected above via
                // `reject_v10_primitive_in_update`.
                if !is_primitive(val) {
                    return Err(format!(
                        "action update: primitive target at {offender} requires a primitive \
                         update value (got {got}); the Overlay 1.1 spec says primitive update \
                         values replace the selected node.{siblings}",
                        offender = location_to_jsonpath(n.location()),
                        got = type_name(val),
                        siblings = sibling_hint(&nodes, idx),
                    )
                    .into());
                }
            }
        }
    }

    let pointers = PointerList::from_located(&nodes);
    drop(nodes);
    let mutated = apply_value_to_targets(doc, version, &pointers, value_for)?;
    Ok((matched, mutated))
}

fn apply_copy(doc: &mut Document, version: Version, target: &Path, source_path: &Path) -> Result<(usize, usize), Err> {
    let target_nodes = target.query_deduped(doc.value());
    let matched = target_nodes.len();
    enforce_homogeneous_category(&target_nodes)?;

    let source_nodes = source_path.query_deduped(doc.value());
    // A source that selects multiple nodes is always invalid, even when target
    // selects nothing.
    if source_nodes.len() > 1 {
        return Err(format!(
            "action copy: source {:?} selects {} nodes — a copy source MUST match exactly one (single) node, \
             not multiple or more than one",
            source_path.source(),
            source_nodes.len()
        )
        .into());
    }
    if matched == 0 {
        return Ok((0, 0));
    }
    if source_nodes.is_empty() {
        return Err(format!(
            "action copy: source {:?} selects zero nodes — a copy source MUST match exactly one node (no match)",
            source_path.source()
        )
        .into());
    }
    let source_value = source_nodes[0].node().clone();
    drop(source_nodes);

    // Precheck every target before mutating any of them so a compatibility
    // error on a later target never leaves the document partially mutated.
    for n in &target_nodes {
        match n.node() {
            Value::Object(dst) => match &source_value {
                Value::Object(src) => check_nested_merge_compat("copy", dst, src)?,
                Value::Array(_) => {
                    return Err(
                        "action copy: cannot merge array source into object target — incompatible categories".into(),
                    );
                }
                _ => {
                    return Err("action copy: cannot merge primitive source into object target — \
                         primitive into object is an incompatible category"
                        .into());
                }
            },
            Value::Array(_) => {}
            _ => match &source_value {
                Value::Array(_) => {
                    return Err(
                        "action copy: cannot replace primitive target with array source — array into primitive is an incompatible category"
                            .into(),
                    );
                }
                Value::Object(_) => {
                    return Err(
                        "action copy: cannot replace primitive target with object source — object into primitive is an incompatible category"
                            .into(),
                    );
                }
                _ => {}
            },
        }
    }

    let pointers = PointerList::from_located(&target_nodes);
    drop(target_nodes);
    let mutated = apply_value_to_targets(doc, version, &pointers, |_| &source_value)?;
    Ok((matched, mutated))
}

/// Apply an already-validated value to each target pointer: primitives replace
/// in place, objects deep-merge, arrays concat (1.1+) or append. Shared by
/// `update` and `copy`.
fn apply_value_to_targets<'a>(
    doc: &mut Document,
    version: Version,
    locations: &PointerList,
    value_for: impl Fn(usize) -> &'a Value,
) -> Result<usize, Err> {
    let mut mutated = 0usize;
    for idx in 0..locations.len() {
        let value = value_for(idx);
        match locations.resolve_mut(doc.value_mut(), locations.segs(idx)) {
            Some(Value::Object(map)) => {
                if let Some(src) = value.as_object()
                    && merge_object(map, src, version)?
                {
                    doc.mark_mutated();
                    mutated += 1;
                }
            }
            Some(Value::Array(arr)) => {
                let before_len = arr.len();
                match value {
                    Value::Array(items) if version.concat_arrays() => {
                        arr.reserve(items.len());
                        for it in items {
                            arr.push(it.clone());
                        }
                    }
                    other => arr.push(other.clone()),
                }
                if arr.len() != before_len {
                    doc.mark_mutated();
                    mutated += 1;
                }
            }
            Some(node) if *node != *value => {
                *node = value.clone();
                doc.mark_mutated();
                mutated += 1;
            }
            _ => {}
        }
    }
    Ok(mutated)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    Object,
    Array,
    Primitive,
}

fn category_of(v: &Value) -> Category {
    match v {
        Value::Object(_) => Category::Object,
        Value::Array(_) => Category::Array,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Category::Primitive,
    }
}

fn enforce_homogeneous_category(nodes: &[LocatedNode<'_>]) -> Result<(), Err> {
    let Some((first, rest)) = nodes.split_first() else {
        return Ok(());
    };
    if rest.is_empty() {
        return Ok(());
    }
    let expected = category_of(first.node());
    for n in rest {
        if category_of(n.node()) != expected {
            return Err("target selects nodes of mixed categories (object, array, primitive); \
                 overlay requires the selected nodes to be the same category \
                 (homogeneous nodelist)"
                .into());
        }
    }
    Ok(())
}

/// Overlay 1.0 forbids `update` on primitive targets (§5). When a 1.0
/// target sweeps across a mixed-kind nodelist that happens to include a
/// primitive, surface the primitive-specific error (with its sibling
/// listing) rather than the generic mixed-category message — the
/// primitive is the actionable problem and the sibling hint tells the
/// author which filter clause to narrow.
fn reject_v10_primitive_in_update(nodes: &[LocatedNode<'_>]) -> Result<(), Err> {
    for (idx, n) in nodes.iter().enumerate() {
        if category_of(n.node()) == Category::Primitive {
            return Err(format!(
                "action update: target selects a primitive value at {offender}, \
                 which overlay 1.0 forbids as an `update` target (must select \
                 objects or arrays). Forge follows Overlay 1.0 §5 strictly for \
                 `update` on primitives.{siblings}",
                offender = location_to_jsonpath(n.location()),
                siblings = sibling_hint(nodes, idx),
            )
            .into());
        }
    }
    Ok(())
}

fn check_nested_merge_compat(
    verb: &str,
    tgt: &serde_json::Map<String, Value>,
    update: &serde_json::Map<String, Value>,
) -> Result<(), Err> {
    for (k, v_upd) in update {
        if let Some(v_tgt) = tgt.get(k) {
            let ct = category_of(v_tgt);
            let cu = category_of(v_upd);
            if ct != cu {
                let names = |c| match c {
                    Category::Object => "object",
                    Category::Array => "array",
                    Category::Primitive => "primitive",
                };
                return Err(format!(
                    "action {verb}: incompatible merge at `{k}` — cannot merge {} and {} \
                     (target property is {}, source value is {}); no sensible merge rule exists",
                    names(ct),
                    names(cu),
                    names(ct),
                    names(cu),
                )
                .into());
            }
            if let (Value::Object(inner_tgt), Value::Object(inner_upd)) = (v_tgt, v_upd) {
                check_nested_merge_compat(verb, inner_tgt, inner_upd)?;
            }
        }
    }
    Ok(())
}

/// Merge `update` into `target`. Returns whether anything changed.
fn merge_object(
    target: &mut serde_json::Map<String, Value>,
    update: &serde_json::Map<String, Value>,
    version: Version,
) -> Result<bool, Err> {
    let mut changed = false;
    for (k, v_upd) in update {
        match target.get_mut(k) {
            None => {
                // Append new key at the end, preserving existing order.
                target.insert(k.clone(), v_upd.clone());
                changed = true;
            }
            Some(existing) => match (existing, v_upd) {
                (Value::Object(ex), Value::Object(up)) => {
                    changed |= merge_object(ex, up, version)?;
                }
                (Value::Array(ex), Value::Array(up)) if version.concat_arrays() => {
                    ex.extend(up.iter().cloned());
                    changed |= !up.is_empty();
                }
                (slot, up) => {
                    // 1.0 replace; 1.1+ nested category must match, checked
                    // ahead of this call.
                    if *slot != *up {
                        *slot = up.clone();
                        changed = true;
                    }
                }
            },
        }
    }
    Ok(changed)
}

fn is_primitive(v: &Value) -> bool {
    matches!(v, Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_))
}

/// True if `value` contains any `"$ref"` string member that is neither a
/// pure-fragment reference (`#...`) nor an absolute URI with a scheme — the
/// only values `rebase_refs_walk` can rewrite or reject.
fn contains_relative_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("$ref")
                && !r.starts_with('#')
                && uri::scheme_str(r).is_none()
            {
                return true;
            }
            map.values().any(contains_relative_ref)
        }
        Value::Array(arr) => arr.iter().any(contains_relative_ref),
        _ => false,
    }
}

/// Walk `value` and rewrite every relative `$ref` string so it keeps pointing
/// at the same target once the content is merged into the spec. The ref is
/// parsed as a URI reference and:
///
/// - Pure-fragment refs (`#/foo`) pass through unchanged — they target the
///   containing document, which is still the merged spec.
/// - Absolute URIs (with a scheme) pass through unchanged — already
///   self-contained.
/// - Relative refs are resolved against `overlay_base` (the retrieval URI
///   of the content's source). When `spec_base` is also known and both
///   URIs are `file:`, the resolved ref is re-expressed as a path relative
///   to the spec's retrieval base, so the merged spec stays portable and
///   doesn't leak absolute build-environment paths. When a relative
///   expression is impossible (different schemes, Windows cross-drive,
///   or the target would walk up too many levels), the absolute `file:`
///   URI is emitted as a safe fallback.
/// - An unparseable `$ref` string is an error — surfacing it at apply time
///   is strictly better than silently emitting a broken ref the downstream
///   SDK generator will fail to resolve minutes later with no context.
///
/// Called on the inserted VALUE within apply, never on the overlay as a
/// whole, so Reusable Action `$ref`s under `components.actions.*` are not
/// touched (and a pure-fragment ref like `#/components/actions/Foo` is
/// skipped above anyway).
fn rebase_refs(
    value: &mut Value,
    overlay_base: Option<&str>,
    spec_base: Option<&str>,
    in_entry_map: bool,
) -> Result<(), Err> {
    let Some(overlay_base) = overlay_base else {
        return Ok(());
    };
    rebase_refs_walk(value, overlay_base, spec_base, in_entry_map)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetRebaseContext {
    Normal,
    EntryMap,
    Literal,
}

/// Keys whose values hold literal user data rather than OpenAPI/JSON Schema
/// reference-bearing structures. A `$ref` key inside these is ordinary data
/// and must not be rebased.
fn is_literal_data_key(key: &str) -> bool {
    matches!(key, "example" | "default" | "const" | "enum" | "value" | "dataValue") || key.starts_with("x-")
}

/// Keys whose object value is a map of user-chosen names to OpenAPI/JSON Schema
/// objects (e.g. `properties.<name>`, `headers.<name>`, `examples.<name>`).
/// Direct child keys are user names rather than OpenAPI keywords, so a schema
/// property named `"value"`/`"default"` or a header named `"x-rate"` still
/// rebases its `$ref`.
fn is_entry_map_key(key: &str) -> bool {
    matches!(
        key,
        "properties"
            | "patternProperties"
            | "dependentSchemas"
            | "$defs"
            | "definitions"
            | "schemas"
            | "parameters"
            | "responses"
            | "requestBodies"
            | "headers"
            | "examples"
            | "links"
            | "callbacks"
            | "pathItems"
            | "mediaTypes"
            | "content"
            | "encoding"
    )
}

/// Classifies where a target location sits in the OpenAPI tree for `$ref`
/// rebasing: inside a literal-data container (`Literal`), directly on an entry
/// map like `properties` or `headers` (`EntryMap`), or in a normal OpenAPI
/// object (`Normal`).
fn classify_target_location(loc: &NormalizedPath<'_>, cat: Category) -> TargetRebaseContext {
    let mut in_entry_map = false;
    let len = loc.len();
    for (i, seg) in loc.iter().enumerate() {
        match seg {
            PathElement::Name(k) => {
                if !in_entry_map {
                    if is_literal_data_key(k) {
                        return TargetRebaseContext::Literal;
                    }
                    // JSON Schema 2020-12 `examples` is an array of literal
                    // example values, whereas OpenAPI `examples` is a map of
                    // Example/Reference Objects.
                    let is_last = i + 1 == len;
                    if *k == "examples"
                        && (matches!(loc.get(i + 1), Some(PathElement::Index(_)))
                            || (is_last && cat == Category::Array))
                    {
                        return TargetRebaseContext::Literal;
                    }
                }
                in_entry_map = !in_entry_map && is_entry_map_key(k);
            }
            PathElement::Index(_) => {
                in_entry_map = false;
            }
        }
    }
    if in_entry_map {
        TargetRebaseContext::EntryMap
    } else {
        TargetRebaseContext::Normal
    }
}

fn rebase_refs_walk(
    value: &mut Value,
    overlay_base: &str,
    spec_base: Option<&str>,
    in_entry_map: bool,
) -> Result<(), Err> {
    match value {
        Value::Object(map) => {
            if !in_entry_map
                && let Some(Value::String(r)) = map.get_mut("$ref")
                && let Some(rewritten) = rebase_one_ref(r, overlay_base, spec_base)?
            {
                *r = rewritten;
            }
            for (k, v) in map.iter_mut() {
                if !in_entry_map && (is_literal_data_key(k) || (k == "examples" && v.is_array())) {
                    continue;
                }
                let child_in_entry_map = !in_entry_map && is_entry_map_key(k) && v.is_object();
                rebase_refs_walk(v, overlay_base, spec_base, child_in_entry_map)?;
            }
        }
        Value::Array(arr) => {
            for v in arr {
                rebase_refs_walk(v, overlay_base, spec_base, false)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn rebase_one_ref(r: &str, overlay_base: &str, spec_base: Option<&str>) -> Result<Option<String>, Err> {
    if r.starts_with('#') {
        return Ok(None);
    }
    if uri::scheme_str(r).is_some() {
        return Ok(None);
    }
    // An empty `$ref` would resolve to the overlay's own URI under RFC 3986
    // (same-document reference), and the walker would then silently rewrite
    // it to a path back to the overlay file itself. That is never what an
    // author meant; treat it as a bad ref.
    if r.is_empty() {
        return Err("action update: `$ref` string is empty — expected a URI reference, got \"\"".into());
    }
    // Relative URI reference: resolve against overlay_base to an absolute URI.
    // A parse/resolve failure is a bad `$ref` string and surfaces as an action
    // error naming the ref.
    let absolute = uri::resolve_reference(overlay_base, r)
        .map_err(|e| format!("action update: cannot rebase `$ref` {r:?} against overlay base {overlay_base}: {e}"))?;
    // Prefer a relative-to-the-spec expression when we know the spec base
    // and can compute one. Falls back to the absolute file: URI otherwise.
    if let Some(spec_base) = spec_base
        && let Some(rel) = uri::relative_file_ref(spec_base, &absolute)
    {
        return Ok(Some(rel));
    }
    Ok(Some(absolute))
}

fn push_jsonpath_name(s: &mut String, name: &str) {
    if is_identifier(name) {
        s.push('.');
        s.push_str(name);
    } else {
        s.push_str("['");
        for ch in name.chars() {
            if ch == '\\' || ch == '\'' {
                s.push('\\');
            }
            s.push(ch);
        }
        s.push_str("']");
    }
}

/// Render a `NormalizedPath` as a human-friendly JSONPath-shaped string, for
/// error messages.
fn location_to_jsonpath(loc: &NormalizedPath<'_>) -> String {
    let mut s = String::from("$");
    for seg in loc.iter() {
        match seg {
            PathElement::Index(i) => {
                let _ = write!(s, "[{i}]");
            }
            PathElement::Name(n) => push_jsonpath_name(&mut s, n),
        }
    }
    s
}

/// Render a [`PointerList`] segment slice as a human-friendly JSONPath-shaped
/// string, for error messages.
fn segs_to_jsonpath(pointers: &PointerList, segs: &[Seg]) -> String {
    let mut s = String::from("$");
    for &seg in segs {
        match seg {
            Seg::Index(i) => {
                let _ = write!(s, "[{i}]");
            }
            Seg::Name(start, end) => push_jsonpath_name(&mut s, pointers.name(start, end)),
        }
    }
    s
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Build a " — target also selects: <p1>, <p2>, ... (and N more)" fragment
/// listing OTHER primitive locations in `nodes`, so the author can see
/// the filter was over-broad — e.g. sweeping `x-internal: true` into an
/// operation-level selection. Empty string when the offending node is
/// the only primitive the target picked up.
fn sibling_hint(nodes: &[LocatedNode<'_>], offender_idx: usize) -> String {
    const MAX_SHOWN: usize = 3;
    let others: Vec<String> = nodes
        .iter()
        .enumerate()
        .filter(|&(i, n)| i != offender_idx && category_of(n.node()) == Category::Primitive)
        .map(|(_, n)| location_to_jsonpath(n.location()))
        .collect();
    if others.is_empty() {
        return String::new();
    }
    let shown: Vec<&str> = others.iter().take(MAX_SHOWN).map(String::as_str).collect();
    let more = others.len().saturating_sub(shown.len());
    let tail = if more == 0 {
        String::new()
    } else {
        format!(" (and {more} more)")
    };
    format!(" — target also selects: {}{tail}", shown.join(", "))
}
