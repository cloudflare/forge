//! Wrapper around `serde_json_path` (RFC 9535 JSONPath).

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::ptr;

use serde_json::Value;
use serde_json_path::{JsonPath, LocatedNode, PathElement};

/// A parsed RFC 9535 JSONPath expression.
pub struct Path {
    expr: JsonPath,
    source: String,
}

impl Path {
    pub fn parse(s: &str) -> Result<Path, String> {
        if !s.starts_with('$') {
            return Err(format!(
                "invalid JSONPath target {s:?}: RFC 9535 JSONPath expressions must begin with `$`"
            ));
        }
        let normalized = normalize_shorthand(s);
        let expr = JsonPath::parse(&normalized).map_err(|e| format!("invalid RFC 9535 JSONPath target {s:?}: {e}"))?;
        Ok(Path {
            expr,
            source: s.to_owned(),
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    /// Select nodes matching this expression and deduplicate by node identity
    /// while preserving first-seen order.
    ///
    /// RFC 9535 §2.5.1 permits duplicate outputs for selectors like `$['a', 'a']`.
    /// Because a `serde_json::Value` is a strict non-ZST tree, two `LocatedNode`s
    /// borrowed from `root` refer to the same location iff their node pointers
    /// are equal — deduping by pointer identity is O(1) per node with no path
    /// string allocations.
    pub fn query_deduped<'a>(&self, root: &'a Value) -> Vec<LocatedNode<'a>> {
        let mut nodes = self.expr.query_located(root).all();
        if nodes.len() <= 1 {
            return nodes;
        }
        let mut seen: HashSet<*const Value> = HashSet::with_capacity(nodes.len());
        nodes.retain(|n| seen.insert(ptr::from_ref(n.node())));
        nodes
    }
}

/// Fast byte scan: true only when `s` has a `.` followed by an ASCII digit or
/// a shorthand name containing `-`, the only cases `normalize_shorthand` can
/// rewrite.
fn may_need_shorthand_normalization(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'.' {
            let next = bytes[i + 1];
            if next.is_ascii_digit() {
                return true;
            }
            if next.is_ascii_alphabetic() || next == b'_' || next == b'-' {
                let mut j = i + 1;
                while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
                    if bytes[j] == b'-' {
                        return true;
                    }
                    j += 1;
                }
            }
        }
        i += 1;
    }
    false
}

/// Rewrite dot-shorthand names that RFC 9535 does not permit (names with
/// `-`, or names starting with a digit) into bracket-quoted names, as used in
/// the OAI test corpus (e.g. `@.x-oai-traits.paged`). Leaves quoted strings,
/// floating-point numeric literals (e.g. `1.5`), and `..` descendant prefixes
/// intact.
fn normalize_shorthand(s: &str) -> Cow<'_, str> {
    if !may_need_shorthand_normalization(s) {
        return Cow::Borrowed(s);
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Preserve strings verbatim (single- or double-quoted).
        if c == '\'' || c == '"' {
            let quote = c;
            out.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                out.push(ch);
                i += 1;
                if ch == '\\' && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                    continue;
                }
                if ch == quote {
                    break;
                }
            }
            continue;
        }
        // `..` descendant operator: keep `..` intact, and if followed by a
        // shorthand name needing bracket-quoting (`..x-foo`, `..200`), turn it
        // into `..['name']` rather than corrupting the second `.`.
        if c == '.' && i + 1 < chars.len() && chars[i + 1] == '.' {
            out.push_str("..");
            i += 2;
            if let Some((quoted, end)) = rewrite_shorthand_name(&chars, i) {
                out.push_str(&quoted);
                i = end;
            }
            continue;
        }
        // Single `.` followed by a shorthand name that RFC 9535 would reject
        // (starts with a digit or contains `-`), unless the `.` is the decimal
        // point of a numeric literal (e.g. `1.5`, `-0.25`).
        if c == '.'
            && i + 1 < chars.len()
            && chars[i + 1] != '*'
            && !ends_with_number_literal(&out)
            && let Some((quoted, end)) = rewrite_shorthand_name(&chars, i + 1)
        {
            out.push_str(&quoted);
            i = end;
            continue;
        }
        out.push(c);
        i += 1;
    }
    Cow::Owned(out)
}

/// If `chars[start..]` begins with an ASCII shorthand name containing `-` or
/// starting with a digit, return `Some(("['<name>']", end))`.
fn rewrite_shorthand_name(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut end = start;
    while end < chars.len() {
        let ch = chars[end];
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            end += 1;
        } else {
            break;
        }
    }
    if end == start {
        return None;
    }
    let name: String = chars[start..end].iter().collect();
    let first_ok = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let any_hyphen = name.contains('-');
    if !first_ok || any_hyphen {
        Some((format!("['{}']", name.replace('\'', "\\'")), end))
    } else {
        None
    }
}

/// True when `out` ends with a numeric literal token (digits not preceded by
/// an identifier character or `.`), so an upcoming `.` is a decimal point
/// (e.g. `1.5`, `-0.25`) rather than a member-name selector.
fn ends_with_number_literal(out: &str) -> bool {
    let bytes = out.as_bytes();
    if bytes.is_empty() || !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    let mut k = bytes.len();
    while k > 0 && bytes[k - 1].is_ascii_digit() {
        k -= 1;
    }
    if k == 0 {
        return true;
    }
    let prev = bytes[k - 1];
    !(prev.is_ascii_alphabetic() || prev == b'_' || prev == b'.')
}

/// A single edge stored inside a [`PointerList`].
#[derive(Clone, Copy, Debug)]
pub enum Seg {
    /// Byte range `(start, end)` inside [`PointerList::names`].
    Name(usize, usize),
    /// Array element index.
    Index(usize),
}

/// Flat arena of owned JSONPath locations built from a `LocatedNode` slice so
/// the immutable borrow of the document can be released before mutating.
///
/// Packs all segment slices and object key strings into three contiguous
/// buffers instead of allocating a `Vec` per match and a `String` per segment.
pub struct PointerList {
    names: String,
    segs: Vec<Seg>,
    spans: Vec<(usize, usize)>,
}

impl PointerList {
    pub fn from_located(nodes: &[LocatedNode<'_>]) -> PointerList {
        let mut total_segs = 0usize;
        let mut total_bytes = 0usize;
        for n in nodes {
            let loc = n.location();
            total_segs += loc.len();
            for elem in loc.iter() {
                if let PathElement::Name(name) = elem {
                    total_bytes += name.len();
                }
            }
        }
        let mut names = String::with_capacity(total_bytes);
        let mut segs = Vec::with_capacity(total_segs);
        let mut spans = Vec::with_capacity(nodes.len());
        for n in nodes {
            let start_seg = segs.len();
            for elem in n.location().iter() {
                match elem {
                    PathElement::Name(name) => {
                        let start = names.len();
                        names.push_str(name);
                        let end = names.len();
                        segs.push(Seg::Name(start, end));
                    }
                    PathElement::Index(i) => segs.push(Seg::Index(*i)),
                }
            }
            spans.push((start_seg, segs.len()));
        }
        PointerList { names, segs, spans }
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn segs(&self, idx: usize) -> &[Seg] {
        let (start, end) = self.spans[idx];
        &self.segs[start..end]
    }

    pub fn name(&self, start: usize, end: usize) -> &str {
        &self.names[start..end]
    }

    /// Resolve a slice of segments from this list to a mutable reference inside
    /// `root`, returning `None` if any segment is missing.
    pub fn resolve_mut<'a>(&self, root: &'a mut Value, segs: &[Seg]) -> Option<&'a mut Value> {
        let mut cur = root;
        for &seg in segs {
            cur = match (cur, seg) {
                (Value::Object(map), Seg::Name(s, e)) => map.get_mut(&self.names[s..e])?,
                (Value::Array(arr), Seg::Index(i)) => arr.get_mut(i)?,
                _ => return None,
            };
        }
        Some(cur)
    }

    /// Sort locations in place for safe removal: deepest paths first, then
    /// lexicographically with array indices descending (so removing later
    /// indices does not invalidate earlier ones) and object keys ascending.
    pub fn sort_for_remove(&mut self) {
        let names = &self.names;
        let segs = &self.segs;
        self.spans.sort_by(|&(as_, ae), &(bs, be)| {
            let a = &segs[as_..ae];
            let b = &segs[bs..be];
            b.len().cmp(&a.len()).then_with(|| {
                for (&x, &y) in a.iter().zip(b.iter()) {
                    let ord = cmp_seg_for_remove(names, x, y);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                }
                Ordering::Equal
            })
        });
    }
}

/// Total order on [`Seg`] for removal sorting: array indices sort descending so
/// removing later indices does not invalidate earlier ones; object keys sort
/// ascending; indices consistently precede keys so equal-length mixed pointers
/// never violate strict weak ordering.
fn cmp_seg_for_remove(names: &str, a: Seg, b: Seg) -> Ordering {
    match (a, b) {
        (Seg::Index(i), Seg::Index(j)) => j.cmp(&i),
        (Seg::Name(as_, ae), Seg::Name(bs, be)) => names[as_..ae].cmp(&names[bs..be]),
        (Seg::Index(_), Seg::Name(_, _)) => Ordering::Less,
        (Seg::Name(_, _), Seg::Index(_)) => Ordering::Greater,
    }
}
