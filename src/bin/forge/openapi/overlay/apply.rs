//! Apply one action to a document: `remove`, `update`, `copy`.
//!
//! The spec semantics are version-dispatched: 1.0 is strict about
//! primitive targets and replaces arrays-under-properties; 1.1+ permits
//! primitive-replacement, concatenates arrays under array-valued properties,
//! and introduces `copy`.

use forge::Err;
use serde_json::Value;

use super::action::Fields;
use super::document::{Document, type_name};
use super::parsed::Version;
use super::path::{self, Path, Pointer, Segment};
use super::uri;

/// What one overlay action did when it ran.
pub(super) struct ActionReport {
    verb: Verb,
    target: String,
    pub(super) matched: usize,
    pub(super) mutated: usize,
    copy_source: Option<String>,
    pub(super) ref_name: Option<String>,
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

impl ActionReport {
    /// Human-readable summary of one action: "<verb> <target> — <result>",
    /// prefixed when `ref_name` is set with "ref=<name> ".
    pub(super) fn format(&self) -> String {
        let prefix = match &self.ref_name {
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
                let src = self.copy_source.as_deref().unwrap_or("?");
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

pub(super) fn apply_action(
    doc: &mut Document,
    version: Version,
    target: &Path,
    fields: &Fields,
    overlay_base: Option<&str>,
    spec_base: Option<&str>,
) -> Result<ActionReport, Err> {
    // Resolve target nodelist against the current document state, deduping
    // by JSON Pointer (RFC 9535 §2.5.1 allows duplicate outputs from selectors
    // like `$['a', 'a']`). `matched` is the deduped count the user gets.
    let locations = select_deduped(target, doc.value());
    let matched = locations.len();

    // Precedence: remove > update > copy (per spec).
    if fields.remove {
        let mutated = apply_remove(doc, &locations)?;
        return Ok(ActionReport {
            verb: Verb::Remove,
            target: target.source().to_owned(),
            matched,
            mutated,
            copy_source: None,
            ref_name: None,
        });
    }

    // If there is an update, copy is ignored.
    if let Some(update_val) = &fields.update {
        if !version.allows_primitive_update() {
            reject_v10_primitive_in_update(doc.value(), &locations)?;
        }
        enforce_homogeneous_category(doc.value(), &locations)?;
        let mutated = apply_update(doc, version, &locations, update_val, overlay_base, spec_base)?;
        return Ok(ActionReport {
            verb: Verb::Update,
            target: target.source().to_owned(),
            matched,
            mutated,
            copy_source: None,
            ref_name: None,
        });
    }

    if let Some(copy_src) = &fields.copy {
        enforce_homogeneous_category(doc.value(), &locations)?;
        let mutated = apply_copy(doc, version, &locations, copy_src)?;
        return Ok(ActionReport {
            verb: Verb::Copy,
            target: target.source().to_owned(),
            matched,
            mutated,
            copy_source: Some(copy_src.source().to_owned()),
            ref_name: None,
        });
    }

    // No fields => no-op.
    Ok(ActionReport {
        verb: Verb::Noop,
        target: target.source().to_owned(),
        matched,
        mutated: 0,
        copy_source: None,
        ref_name: None,
    })
}

/// Select nodes matching `path` and dedup by JSON Pointer while preserving
/// first-seen order. RFC 9535 §2.5.1 permits duplicate outputs for selectors
/// like `$['a', 'a']`; visiting each node at most once prevents double array
/// concatenation, double removal, and spurious multi-match `copy` errors.
fn select_deduped(path: &Path, root: &Value) -> Vec<Pointer> {
    let raw = path.select(root);
    let mut deduped: indexmap::IndexSet<Pointer> = indexmap::IndexSet::with_capacity(raw.len());
    for p in raw {
        deduped.insert(p);
    }
    deduped.into_iter().collect()
}

/// Total order on [`Segment`] for removal sorting: array indices sort
/// descending so removing later indices does not invalidate earlier ones;
/// object keys sort ascending; indices consistently precede keys so equal-length
/// mixed pointers never violate strict weak ordering.
fn cmp_segment_for_remove(a: &Segment, b: &Segment) -> std::cmp::Ordering {
    match (a, b) {
        (Segment::Index(i), Segment::Index(j)) => j.cmp(i),
        (Segment::Name(x), Segment::Name(y)) => x.cmp(y),
        (Segment::Index(_), Segment::Name(_)) => std::cmp::Ordering::Less,
        (Segment::Name(_), Segment::Index(_)) => std::cmp::Ordering::Greater,
    }
}

fn apply_remove(doc: &mut Document, locations: &[Pointer]) -> Result<usize, Err> {
    if locations.is_empty() {
        return Ok(0);
    }
    // Pre-scan: a root pointer `$` is a non-starter for remove (would leave
    // nothing downstream can use). Reject before any mutation so a mixed
    // nodelist of `[root, child]` doesn't half-apply before the root error.
    // In practice no RFC 9535 selector yields root alongside other paths —
    // this is defense-in-depth for atomicity.
    for p in locations {
        if p.0.is_empty() {
            return Err(root_remove_error());
        }
    }
    // Sort: deepest paths first, then lexicographically by `cmp_segment_for_remove`
    // (descending array indices so earlier indices stay valid).
    let mut sorted: Vec<Pointer> = locations.to_vec();
    sorted.sort_by(|a, b| {
        b.0.len().cmp(&a.0.len()).then_with(|| {
            for (x, y) in a.0.iter().zip(b.0.iter()) {
                let ord = cmp_segment_for_remove(x, y);
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            std::cmp::Ordering::Equal
        })
    });
    let mut removed = 0usize;
    for p in &sorted {
        if remove_at(doc.value_mut(), p)? {
            doc.mark_mutated();
            removed += 1;
        }
    }
    Ok(removed)
}

fn remove_at(root: &mut Value, p: &Pointer) -> Result<bool, Err> {
    let Some((last, parent_segs)) = split_last(&p.0) else {
        // Belt-and-suspenders: apply_remove pre-scans for root pointers, so
        // this branch should be unreachable. Keep the explicit error in case
        // remove_at is ever called from a path that skipped the pre-scan.
        return Err(root_remove_error());
    };
    let Some(parent) = path::resolve_mut(root, &Pointer(parent_segs.to_vec())) else {
        return Ok(false); // Already gone.
    };
    match (parent, last) {
        (Value::Object(map), Segment::Name(n)) => Ok(map.shift_remove(n).is_some()),
        (Value::Array(arr), Segment::Index(i)) => {
            if *i < arr.len() {
                arr.remove(*i);
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
                Segment::Name(_) => "name",
                Segment::Index(_) => "array index",
            };
            Err(format!(
                "action remove: target at `{}` resolves to a {} but the trailing \
                 selector is a {seg_kind}; nothing to remove",
                pointer_to_jsonpath(p),
                type_name(parent),
            )
            .into())
        }
    }
}

fn split_last<T>(segs: &[T]) -> Option<(&T, &[T])> {
    let n = segs.len();
    if n == 0 {
        return None;
    }
    Some((&segs[n - 1], &segs[..n - 1]))
}

/// Shared error for a `remove` action whose target selects the document
/// root. Named so `apply_remove`'s pre-scan and `remove_at`'s belt-and-
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
    locations: &[Pointer],
    update: &Value,
    overlay_base: Option<&str>,
    spec_base: Option<&str>,
) -> Result<usize, Err> {
    if locations.is_empty() {
        return Ok(0);
    }
    // Rebase relative `$ref`s in the inserted value against the overlay's
    // retrieval base so the merged spec is self-contained. Targets inside
    // literal-data containers (examples, defaults, `x-*` extensions) keep the
    // raw payload untouched so ordinary data keys named `$ref` aren't altered.
    let needs_rebase = overlay_base.is_some() && locations.iter().any(|p| !pointer_is_literal_data(p));
    let mut rebased_owner = None;
    if needs_rebase {
        let mut cloned = update.clone();
        rebase_refs(&mut cloned, overlay_base, spec_base)?;
        rebased_owner = Some(cloned);
    }
    let value_for = |p: &Pointer| -> &Value {
        if pointer_is_literal_data(p) {
            update
        } else {
            rebased_owner.as_ref().unwrap_or(update)
        }
    };
    // Compute each target's category once. Nothing mutates between here
    // and the end of the apply loop that would invalidate these (dedup
    // guarantees locations are distinct, and no two distinct pointers
    // alias the same node), so we can reuse the vector below.
    let cats: Vec<Category> = locations.iter().map(|p| category_at(doc.value(), p)).collect();
    for (p, cat) in locations.iter().zip(cats.iter().copied()) {
        let val = value_for(p);
        match cat {
            Category::Primitive => {
                // Overlay 1.0 primitives are already rejected in `apply_action`
                // via `reject_v10_primitive_in_update`.
                if !is_primitive(val) {
                    return Err(format!(
                        "action update: primitive target at {offender} requires a primitive \
                         update value (got {got}); the Overlay 1.1 spec says primitive update \
                         values replace the selected node.{siblings}",
                        offender = pointer_to_jsonpath(p),
                        got = type_name(val),
                        siblings = sibling_hint(doc.value(), locations, p),
                    )
                    .into());
                }
            }
            Category::Object => {
                if !val.is_object() {
                    return Err(format!(
                        "action update: object target requires an object update value, got {}",
                        type_name(val)
                    )
                    .into());
                }
            }
            Category::Array => {
                // Array target: any update value is allowed (array is concatenated,
                // primitive is appended, object is appended).
            }
            Category::Missing => {
                // No-op; a matching but currently-missing node can't happen
                // since the pointer came from `select`.
            }
        }
        // Precheck: merging an object update into an object target rejects
        // incompatible nested property categories. Runs on all versions:
        // without it, 1.0 silently drops later iterations of a multi-match
        // update when an earlier iteration mutated an overlapping ancestor.
        if matches!(cat, Category::Object)
            && let (Some(Value::Object(target)), Some(upd)) = (path::resolve(doc.value(), p), val.as_object())
        {
            check_nested_merge_compat("update", target, upd)?;
        }
    }

    apply_value_to_targets(doc, version, locations, &cats, value_for)
}

fn apply_copy(doc: &mut Document, version: Version, locations: &[Pointer], source_path: &Path) -> Result<usize, Err> {
    let source_matches = select_deduped(source_path, doc.value());
    // A source that selects multiple nodes is always invalid, even when target
    // selects nothing.
    if source_matches.len() > 1 {
        return Err(format!(
            "action copy: source {:?} selects {} nodes — a copy source MUST match exactly one (single) node, \
             not multiple or more than one",
            source_path.source(),
            source_matches.len()
        )
        .into());
    }
    if locations.is_empty() {
        return Ok(0);
    }
    if source_matches.is_empty() {
        return Err(format!(
            "action copy: source {:?} selects zero nodes — a copy source MUST match exactly one node (no match)",
            source_path.source()
        )
        .into());
    }
    let source_value = path::resolve(doc.value(), &source_matches[0])
        .expect("source matched above")
        .clone();

    // Precheck every target before mutating any of them so a compatibility
    // error on a later target never leaves the document partially mutated.
    // Resolving directly here both avoids a second walk and keeps the resolved
    // node variant in lockstep with `cats`.
    let mut cats = Vec::with_capacity(locations.len());
    for p in locations {
        let cat = match path::resolve(doc.value(), p) {
            Some(Value::Object(dst)) => {
                match &source_value {
                    Value::Object(src) => check_nested_merge_compat("copy", dst, src)?,
                    Value::Array(_) => {
                        return Err(
                            "action copy: cannot merge array source into object target — incompatible categories"
                                .into(),
                        );
                    }
                    _ => {
                        return Err("action copy: cannot merge primitive source into object target — \
                             primitive into object is an incompatible category"
                            .into());
                    }
                }
                Category::Object
            }
            Some(Value::Array(_)) => Category::Array,
            Some(_) => {
                match &source_value {
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
                }
                Category::Primitive
            }
            None => Category::Missing,
        };
        cats.push(cat);
    }

    apply_value_to_targets(doc, version, locations, &cats, |_| &source_value)
}

/// Apply an already-validated value to each `(pointer, category)` target:
/// primitives replace in place, objects deep-merge, arrays concat (1.1+) or
/// append. Shared by `update` and `copy`.
fn apply_value_to_targets<'a>(
    doc: &mut Document,
    version: Version,
    locations: &[Pointer],
    cats: &[Category],
    value_for: impl Fn(&Pointer) -> &'a Value,
) -> Result<usize, Err> {
    let mut mutated = 0usize;
    for (p, cat) in locations.iter().zip(cats.iter().copied()) {
        let value = value_for(p);
        match (cat, path::resolve_mut(doc.value_mut(), p)) {
            (Category::Primitive, Some(node)) => {
                if *node != *value {
                    *node = value.clone();
                    doc.mark_mutated();
                    mutated += 1;
                }
            }
            (Category::Object, Some(Value::Object(map))) => {
                if let Some(src) = value.as_object()
                    && merge_object(map, src, version)?
                {
                    doc.mark_mutated();
                    mutated += 1;
                }
            }
            (Category::Array, Some(Value::Array(arr))) => {
                let before_len = arr.len();
                match value {
                    Value::Array(items) if version.concat_arrays() => {
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
    Missing,
}

fn category_of(v: &Value) -> Category {
    match v {
        Value::Object(_) => Category::Object,
        Value::Array(_) => Category::Array,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Category::Primitive,
    }
}

fn category_at(root: &Value, p: &Pointer) -> Category {
    match path::resolve(root, p) {
        Some(v) => category_of(v),
        None => Category::Missing,
    }
}

fn enforce_homogeneous_category(root: &Value, locations: &[Pointer]) -> Result<(), Err> {
    if locations.len() < 2 {
        return Ok(());
    }
    let mut seen: Option<Category> = None;
    for p in locations {
        let c = category_at(root, p);
        if c == Category::Missing {
            continue;
        }
        match seen {
            None => seen = Some(c),
            Some(prev) if prev != c => {
                return Err("target selects nodes of mixed categories (object, array, primitive); \
                     overlay requires the selected nodes to be the same category \
                     (homogeneous nodelist)"
                    .into());
            }
            _ => {}
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
fn reject_v10_primitive_in_update(root: &Value, locations: &[Pointer]) -> Result<(), Err> {
    for p in locations {
        if category_at(root, p) == Category::Primitive {
            return Err(format!(
                "action update: target selects a primitive value at {offender}, \
                 which overlay 1.0 forbids as an `update` target (must select \
                 objects or arrays). Forge follows Overlay 1.0 §5 strictly for \
                 `update` on primitives.{siblings}",
                offender = pointer_to_jsonpath(p),
                siblings = sibling_hint(root, locations, p),
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
                    Category::Missing => "missing",
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
fn rebase_refs(value: &mut Value, overlay_base: Option<&str>, spec_base: Option<&str>) -> Result<(), Err> {
    let Some(overlay_base) = overlay_base else {
        return Ok(());
    };
    rebase_refs_walk(value, overlay_base, spec_base)
}

/// Keys whose values hold literal user data rather than OpenAPI/JSON Schema
/// reference-bearing structures. A `$ref` key inside these is ordinary data
/// and must not be rebased.
fn is_literal_data_key(key: &str) -> bool {
    matches!(key, "example" | "default" | "const" | "enum" | "value" | "dataValue") || key.starts_with("x-")
}

/// True when `p` points at or inside a literal-data container in the target
/// document (such as `example`, `default`, `const`, `enum`, `value`,
/// `dataValue`, a JSON Schema `examples` array, or an `x-*` extension).
fn pointer_is_literal_data(p: &Pointer) -> bool {
    for (i, seg) in p.0.iter().enumerate() {
        let Segment::Name(k) = seg else {
            continue;
        };
        if is_literal_data_key(k) {
            return true;
        }
        // JSON Schema 2020-12 `examples` is an array of literal example values,
        // whereas OpenAPI `examples` is a map of Example/Reference Objects.
        if k == "examples" && matches!(p.0.get(i + 1), Some(Segment::Index(_))) {
            return true;
        }
    }
    false
}

fn rebase_refs_walk(value: &mut Value, overlay_base: &str, spec_base: Option<&str>) -> Result<(), Err> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("$ref") {
                let r = r.clone();
                if let Some(rewritten) = rebase_one_ref(&r, overlay_base, spec_base)? {
                    map.insert("$ref".to_owned(), Value::String(rewritten));
                }
            }
            for (k, v) in map.iter_mut() {
                if is_literal_data_key(k) || (k == "examples" && v.is_array()) {
                    continue;
                }
                rebase_refs_walk(v, overlay_base, spec_base)?;
            }
        }
        Value::Array(arr) => {
            for v in arr {
                rebase_refs_walk(v, overlay_base, spec_base)?;
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
    if uri::scheme(r).is_some() {
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

/// Render a `Pointer` as a human-friendly JSONPath-shaped string, for error
/// messages. Index segments become `[i]`; name segments become `.name` when
/// `name` is a simple identifier (alnum, `_`, `-`) and `['name']` otherwise
/// (including anything with slashes, dots, quotes, or surrogates).
fn pointer_to_jsonpath(p: &Pointer) -> String {
    let mut s = String::from("$");
    for seg in &p.0 {
        match seg {
            Segment::Index(i) => {
                s.push('[');
                s.push_str(&i.to_string());
                s.push(']');
            }
            Segment::Name(n) => {
                if is_identifier(n) {
                    s.push('.');
                    s.push_str(n);
                } else {
                    s.push_str("['");
                    for ch in n.chars() {
                        if ch == '\\' || ch == '\'' {
                            s.push('\\');
                        }
                        s.push(ch);
                    }
                    s.push_str("']");
                }
            }
        }
    }
    s
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Build a " — target also selects: <p1>, <p2>, ... (and N more)" fragment
/// listing OTHER primitive locations in `locations`, so the author can see
/// the filter was over-broad — e.g. sweeping `x-internal: true` into an
/// operation-level selection. Empty string when the offending pointer is
/// the only primitive the target picked up.
fn sibling_hint(root: &Value, locations: &[Pointer], offender: &Pointer) -> String {
    const MAX_SHOWN: usize = 3;
    let others: Vec<String> = locations
        .iter()
        .filter(|p| *p != offender && category_at(root, p) == Category::Primitive)
        .map(pointer_to_jsonpath)
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
