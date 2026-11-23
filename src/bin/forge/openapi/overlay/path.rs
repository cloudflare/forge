//! Wrapper around `serde_json_path` (RFC 9535 JSONPath).

use serde_json::Value;
use serde_json_path::JsonPath;

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

    /// Return the paths of every node selected by this expression,
    /// represented as sequences of [`Segment`]s so callers can mutate the
    /// source document in place.
    pub fn select(&self, root: &Value) -> Vec<Pointer> {
        collect_locations(&self.expr, root)
    }
}

fn collect_locations(expr: &JsonPath, root: &Value) -> Vec<Pointer> {
    expr.query_located(root)
        .into_iter()
        .map(|n| {
            let segs = n
                .location()
                .iter()
                .map(|s| match s {
                    serde_json_path::PathElement::Name(name) => Segment::Name(name.to_string()),
                    serde_json_path::PathElement::Index(i) => Segment::Index(*i),
                })
                .collect();
            Pointer(segs)
        })
        .collect()
}

/// Rewrite dot-shorthand names that RFC 9535 does not permit (names with
/// `-`, or names starting with a digit) into bracket-quoted names, as used in
/// the OAI test corpus (e.g. `@.x-oai-traits.paged`). Leaves quoted strings,
/// floating-point numeric literals (e.g. `1.5`), and `..` descendant prefixes
/// intact.
fn normalize_shorthand(s: &str) -> String {
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
    out
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

/// A single edge in a JSONPath pointer.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Segment {
    Name(String),
    Index(usize),
}

/// A sequence of segments resolving to a node in the document.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Pointer(pub Vec<Segment>);

/// Resolve a pointer to a mutable reference into `root`. Returns `None` if
/// any segment is missing.
pub fn resolve_mut<'a>(root: &'a mut Value, pointer: &Pointer) -> Option<&'a mut Value> {
    let mut cur = root;
    for seg in &pointer.0 {
        cur = match (cur, seg) {
            (Value::Object(map), Segment::Name(n)) => map.get_mut(n)?,
            (Value::Array(arr), Segment::Index(i)) => arr.get_mut(*i)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Resolve a pointer to a shared reference.
pub fn resolve<'a>(root: &'a Value, pointer: &Pointer) -> Option<&'a Value> {
    let mut cur = root;
    for seg in &pointer.0 {
        cur = match (cur, seg) {
            (Value::Object(map), Segment::Name(n)) => map.get(n)?,
            (Value::Array(arr), Segment::Index(i)) => arr.get(*i)?,
            _ => return None,
        };
    }
    Some(cur)
}
