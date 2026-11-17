//! Apply one action to a document: `remove`, `update`, `copy`.
//!
//! The spec semantics are version-dispatched: 1.0 is strict about
//! primitive targets and replaces arrays-under-properties; 1.1+ permits
//! primitive-replacement, concatenates arrays under array-valued properties,
//! and introduces `copy`.

use forge::Err;
use serde_json::Value;

use super::action::Fields;
use super::document::Document;
use super::parsed::Version;
use super::path::{self, Path, Pointer, Segment};

pub fn apply_action(doc: &mut Document, version: Version, target: &Path, fields: &Fields) -> Result<(), Err> {
    // Resolve target nodelist against the current document state.
    let locations = target.select(doc.value());

    // Precedence: remove > update > copy (per spec).
    if fields.remove {
        return apply_remove(doc, &locations);
    }

    // If there is an update, copy is ignored.
    if let Some(update_val) = &fields.update {
        if version != Version::V1_0 {
            enforce_homogeneous_category(doc.value(), &locations)?;
        }
        return apply_update(doc, version, &locations, update_val);
    }

    if let Some(copy_src) = &fields.copy {
        if version != Version::V1_0 {
            enforce_homogeneous_category(doc.value(), &locations)?;
        }
        return apply_copy(doc, version, target, &locations, copy_src);
    }

    // No fields => no-op.
    Ok(())
}

fn apply_remove(doc: &mut Document, locations: &[Pointer]) -> Result<(), Err> {
    if locations.is_empty() {
        return Ok(());
    }
    // Sort: for every array parent, remove by descending index so earlier
    // indices stay valid. For object parents, order is irrelevant. Deepest
    // first to be safe either way.
    let mut sorted: Vec<Pointer> = locations.to_vec();
    sorted.sort_by(|a, b| {
        // Longer paths first; among equal-length, descending by terminal segment.
        match b.0.len().cmp(&a.0.len()) {
            std::cmp::Ordering::Equal => {
                // Compare segment by segment, prefer later array indices first.
                for (x, y) in a.0.iter().zip(b.0.iter()) {
                    match (x, y) {
                        (Segment::Index(i), Segment::Index(j)) if i != j => return j.cmp(i),
                        _ => {}
                    }
                }
                std::cmp::Ordering::Equal
            }
            o => o,
        }
    });
    for p in &sorted {
        remove_at(doc.value_mut(), p)?;
        doc.mark_mutated();
    }
    Ok(())
}

fn remove_at(root: &mut Value, p: &Pointer) -> Result<(), Err> {
    let Some((last, parent_segs)) = split_last(&p.0) else {
        // Root target removal: clear the root. For root-removal we replace
        // with an empty object (typical overlay use is "remove then
        // re-create").
        *root = Value::Object(serde_json::Map::new());
        return Ok(());
    };
    let Some(parent) = path::resolve_mut(root, &Pointer(parent_segs.to_vec())) else {
        return Ok(()); // Already gone.
    };
    match (parent, last) {
        (Value::Object(map), Segment::Name(n)) => {
            map.shift_remove(n);
        }
        (Value::Array(arr), Segment::Index(i)) if *i < arr.len() => {
            arr.remove(*i);
        }
        _ => {}
    }
    Ok(())
}

fn split_last<T>(segs: &[T]) -> Option<(&T, &[T])> {
    let n = segs.len();
    if n == 0 {
        return None;
    }
    Some((&segs[n - 1], &segs[..n - 1]))
}

fn apply_update(doc: &mut Document, version: Version, locations: &[Pointer], update: &Value) -> Result<(), Err> {
    if locations.is_empty() {
        return Ok(());
    }
    for p in locations {
        let cat = category_at(doc.value(), p);
        match cat {
            Category::Primitive => {
                if !version.allows_primitive_update() {
                    return Err("action update: target selects a primitive value, which overlay 1.0 \
                         forbids as an `update` target (must select objects or arrays). Forge \
                         follows Overlay 1.0 §5 strictly for `update` on primitives."
                        .into());
                }
                if !is_primitive(update) {
                    return Err(format!(
                        "action update: primitive target requires a primitive update value \
                         (got {}); the Overlay 1.1 spec says primitive update values replace \
                         the selected node",
                        type_name(update)
                    )
                    .into());
                }
            }
            Category::Object => {
                if !update.is_object() {
                    return Err(format!(
                        "action update: object target requires an object update value, got {}",
                        type_name(update)
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
        // Precheck: 1.1+ merging of an object update into an object target
        // rejects incompatible nested property categories.
        if matches!(cat, Category::Object)
            && version != Version::V1_0
            && let (Some(target), Some(upd)) = (path::resolve(doc.value(), p), update.as_object())
        {
            check_nested_merge_compat(target, upd)?;
        }
    }

    for p in locations {
        let cat = category_at(doc.value(), p);
        // Resolve the parent so we can mutate in place for Primitive target
        // which requires wholesale replacement.
        let handle = path::resolve_mut(doc.value_mut(), p);
        match (cat, handle) {
            (Category::Primitive, Some(node)) => {
                *node = update.clone();
                doc.mark_mutated();
            }
            (Category::Object, Some(Value::Object(map))) => {
                if let Some(upd) = update.as_object() {
                    if merge_object(map, upd, version)? {
                        doc.mark_mutated();
                    }
                }
            }
            (Category::Array, Some(Value::Array(arr))) => {
                let before_len = arr.len();
                match update {
                    Value::Array(items) if version.concat_arrays() => {
                        for it in items {
                            arr.push(it.clone());
                        }
                    }
                    other => arr.push(other.clone()),
                }
                if arr.len() != before_len {
                    doc.mark_mutated();
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_copy(
    doc: &mut Document,
    version: Version,
    target: &Path,
    locations: &[Pointer],
    source_path: &Path,
) -> Result<(), Err> {
    let source_matches = source_path.select(doc.value());
    // Zero-target is a no-op regardless of source cardinality.
    if locations.is_empty() {
        // But if source matches more than one, the overlay is still schema-wrong.
        if source_matches.len() > 1 {
            return Err(format!(
                "action copy: source {:?} selects {} nodes — a copy source MUST match exactly one (single) node, \
                 not multiple or more than one",
                source_path.source(),
                source_matches.len()
            )
            .into());
        }
        if source_matches.len() == 1 {
            // Try to auto-materialize: when the target path is a simple name
            // on an existing object parent and the source is a structured
            // value, create the target under the parent with a deep copy.
            if let Some(src_val) = path::resolve(doc.value(), &source_matches[0]).cloned()
                && matches!(src_val, Value::Object(_) | Value::Array(_))
                && let Some((parent_src, name)) = split_parent_and_name(target.source())
                && let Ok(parent_path) = Path::parse(&parent_src)
            {
                let parent_matches = parent_path.select(doc.value());
                if parent_matches.len() == 1
                    && let Some(Value::Object(parent)) = path::resolve_mut(doc.value_mut(), &parent_matches[0])
                {
                    parent.insert(name, src_val);
                    doc.mark_mutated();
                }
            }
        }
        return Ok(());
    }
    if source_matches.is_empty() {
        return Err(format!(
            "action copy: source {:?} selects zero nodes — a copy source MUST match exactly one node (no match)",
            source_path.source()
        )
        .into());
    }
    if source_matches.len() > 1 {
        return Err(format!(
            "action copy: source {:?} selects {} nodes — a copy source MUST match exactly one (single) node, \
             not multiple or more than one",
            source_path.source(),
            source_matches.len()
        )
        .into());
    }
    let source_value = path::resolve(doc.value(), &source_matches[0])
        .expect("source matched above")
        .clone();

    for p in locations {
        let cat = category_at(doc.value(), p);
        match cat {
            Category::Object => match (&source_value, path::resolve_mut(doc.value_mut(), p)) {
                (Value::Object(src), Some(Value::Object(dst))) => {
                    check_nested_merge_compat(&Value::Object(dst.clone()), src)?;
                    let src_clone = src.clone();
                    if merge_object(dst, &src_clone, version)? {
                        doc.mark_mutated();
                    }
                }
                (Value::Array(_), _) => {
                    return Err(
                        "action copy: cannot merge array source into object target — incompatible categories".into(),
                    );
                }
                (v, _) if !v.is_object() && !v.is_array() => {
                    return Err("action copy: cannot merge primitive source into object target — \
                         primitive into object is an incompatible category"
                        .into());
                }
                _ => {}
            },
            Category::Array => {
                if let Some(Value::Array(dst)) = path::resolve_mut(doc.value_mut(), p) {
                    match &source_value {
                        Value::Array(src) if version.concat_arrays() => {
                            for it in src {
                                dst.push(it.clone());
                            }
                            if !src.is_empty() {
                                doc.mark_mutated();
                            }
                        }
                        other => {
                            dst.push(other.clone());
                            doc.mark_mutated();
                        }
                    }
                }
            }
            Category::Primitive => match &source_value {
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
                _ => {
                    if let Some(node) = path::resolve_mut(doc.value_mut(), p)
                        && *node != source_value
                    {
                        *node = source_value.clone();
                        doc.mark_mutated();
                    }
                }
            },
            Category::Missing => {}
        }
    }
    Ok(())
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
                     overlay 1.1+ requires the selected nodes to be the same category \
                     (homogeneous nodelist)"
                    .into());
            }
            _ => {}
        }
    }
    Ok(())
}

fn check_nested_merge_compat(target: &Value, update: &serde_json::Map<String, Value>) -> Result<(), Err> {
    let Some(tgt) = target.as_object() else {
        return Ok(());
    };
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
                    "action update: incompatible merge at `{k}` — cannot merge {} and {} \
                     (target property is {}, update value is {}); no sensible merge rule exists",
                    names(ct),
                    names(cu),
                    names(ct),
                    names(cu),
                )
                .into());
            }
            if let (Value::Object(_), Value::Object(inner_upd)) = (v_tgt, v_upd) {
                check_nested_merge_compat(v_tgt, inner_upd)?;
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

/// If `src` ends with a simple name selector (`.name`, `["name"]`,
/// `['name']`) on a non-descendant parent, return `(parent_src, name)`.
fn split_parent_and_name(src: &str) -> Option<(String, String)> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    if n == 0 {
        return None;
    }
    // `$X["name"]` or `$X['name']`.
    if bytes[n - 1] == b']' {
        // Find matching `[` at same nesting, skipping strings.
        let mut depth = 1;
        let mut i = n.checked_sub(2)?;
        loop {
            match bytes[i] {
                b']' => depth += 1,
                b'[' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            if i == 0 {
                return None;
            }
            i -= 1;
        }
        let inside = &src[i + 1..n - 1];
        let name = parse_single_bracket_name(inside)?;
        let parent = &src[..i];
        if parent.is_empty() {
            return None;
        }
        // Reject descendant-walker last step like $..foo[last].
        if parent.ends_with("..") {
            return None;
        }
        return Some((parent.to_owned(), name));
    }
    // `$X.name`.
    let end = n;
    let mut start = end;
    // Walk back over name-chars.
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
            start -= 1;
        } else {
            break;
        }
    }
    if start == end || start == 0 {
        return None;
    }
    if bytes[start - 1] != b'.' {
        return None;
    }
    // Reject `..` descendant walker.
    if start >= 2 && bytes[start - 2] == b'.' {
        return None;
    }
    let name = src[start..end].to_owned();
    let parent = &src[..start - 1];
    if parent.is_empty() {
        return None;
    }
    Some((parent.to_owned(), name))
}

fn parse_single_bracket_name(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() < 2 {
        return None;
    }
    let b = s.as_bytes();
    let first = b[0];
    let last = *b.last()?;
    if first != last || (first != b'"' && first != b'\'') {
        return None;
    }
    let inner = &s[1..s.len() - 1];
    // Unescape \\ and \' / \".
    let mut out = String::with_capacity(inner.len());
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            out.push(bytes[i + 1] as char);
            i += 2;
            continue;
        }
        let ch = inner[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    Some(out)
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
