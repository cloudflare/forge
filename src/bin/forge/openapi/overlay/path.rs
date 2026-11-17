//! Wrapper around `serde_json_path` (RFC 9535 JSONPath). Rejects Goessner
//! `[?(...)]` filter syntax with a clear, migration-friendly error.

use serde_json::Value;
use serde_json_path::JsonPath;

/// A parsed RFC 9535 JSONPath expression.
pub struct Path {
    expr: JsonPath,
    /// A fallback expression used when the primary returns zero matches
    /// and the original has a trailing `[?filter]` on a named step. This
    /// hoists the filter to the parent level so the filter effectively
    /// acts on the named object itself (a common author expectation).
    fallback: Option<JsonPath>,
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
        if looks_goessner(&normalized) {
            return Err(format!(
                "invalid JSONPath target {s:?}: Goessner-style `[?(...)]` filter is not valid \
                 RFC 9535 JSONPath. Rewrite without the surrounding parentheses, e.g. `[?...]`."
            ));
        }
        let expr = JsonPath::parse(&normalized).map_err(|e| format!("invalid JSONPath target {s:?}: {e}"))?;
        let fallback = build_fallback(&normalized).and_then(|rewritten| JsonPath::parse(&rewritten).ok());
        Ok(Path {
            expr,
            fallback,
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
        let primary: Vec<Pointer> = collect_locations(&self.expr, root);
        if !primary.is_empty() || self.fallback.is_none() {
            return primary;
        }
        collect_locations(self.fallback.as_ref().unwrap(), root)
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

/// Rewrite `$X.NAME[?FILTER]` as `$X[?FILTER]`: drop the trailing name
/// step so the filter selector iterates the members of `$X` (which, by
/// construction, include the nodes that the original `.NAME` step would
/// have selected). This matches the common "filter on the named object
/// itself" author intent where RFC 9535's "filter on children" semantics
/// would return zero nodes.
fn build_fallback(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.last() != Some(&']') {
        return None;
    }
    // Find matching `[` at the top level.
    let mut depth = 1;
    let mut i = chars.len().checked_sub(2)?;
    loop {
        match chars[i] {
            ']' => depth += 1,
            '[' => {
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
    if chars.get(i + 1) != Some(&'?') {
        return None;
    }
    let filter: String = chars[i + 2..chars.len() - 1].iter().collect();
    let prefix: String = chars[..i].iter().collect();
    let (base, _name) = split_trailing_name(&prefix)?;
    Some(format!("{base}[?{filter}]"))
}

fn split_trailing_name(prefix: &str) -> Option<(String, String)> {
    let chars: Vec<char> = prefix.chars().collect();
    let n = chars.len();
    if n == 0 {
        return None;
    }
    // Case 1: ends with `['NAME']` or `["NAME"]`.
    if chars[n - 1] == ']' {
        let j = n.checked_sub(2)?;
        // Expect a string literal inside brackets.
        if chars[j] != '\'' && chars[j] != '"' {
            return None;
        }
        let quote = chars[j];
        let end_q = j;
        if end_q == 0 {
            return None;
        }
        // Walk back to opening quote.
        let mut start_q = end_q.checked_sub(1)?;
        loop {
            if chars[start_q] == quote {
                // Make sure not escaped.
                if start_q == 0 || chars[start_q - 1] != '\\' {
                    break;
                }
            }
            if start_q == 0 {
                return None;
            }
            start_q -= 1;
        }
        // chars[start_q] is opening quote. Check `[` just before.
        if start_q == 0 || chars[start_q - 1] != '[' {
            return None;
        }
        let name: String = chars[start_q + 1..end_q]
            .iter()
            .collect::<String>()
            .replace("\\'", "'")
            .replace("\\\"", "\"");
        let base: String = chars[..start_q - 1].iter().collect();
        if base.is_empty() {
            return None;
        }
        return Some((base, name));
    }
    // Case 2: ends with `.NAME`.
    let end = n;
    let mut start = end;
    while start > 0 {
        let ch = chars[start - 1];
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            start -= 1;
        } else {
            break;
        }
    }
    if start == end || start == 0 {
        return None;
    }
    if chars[start - 1] != '.' {
        return None;
    }
    // Reject `..` descendant walker.
    if start >= 2 && chars[start - 2] == '.' {
        return None;
    }
    let name: String = chars[start..end].iter().collect();
    let base: String = chars[..start - 1].iter().collect();
    if base.is_empty() {
        return None;
    }
    Some((base, name))
}

/// Rewrite dot-shorthand names that RFC 9535 does not permit (names with
/// `-`, or names starting with a digit) into bracket-quoted names. Also
/// handles the common `@.name` form inside filter expressions. Leaves
/// strings inside `'...'` or `"..."` untouched.
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
        // `.` followed by a shorthand name that RFC 9535 would reject:
        // starts with a digit or contains `-`. Transform `.name-char+`
        // into `["name"]`. Skip `..` (descendant walker) and `.*`.
        if c == '.' && i + 1 < chars.len() && chars[i + 1] != '.' && chars[i + 1] != '*' {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() {
                let ch = chars[end];
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                    end += 1;
                } else {
                    break;
                }
            }
            if end > start {
                let name: String = chars[start..end].iter().collect();
                let first_ok = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
                let any_hyphen = name.contains('-');
                if !first_ok || any_hyphen {
                    out.push_str(&format!("['{}']", name.replace('\'', "\\'")));
                    i = end;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// True Goessner filter: `[?(...)]` wrapping the ENTIRE filter in parens.
/// (A sub-expression in parens like `[?(a == b) || c]` is RFC 9535-valid
/// grouping, not Goessner.) Heuristic: `[?(` ... matching `)` ... `]`.
fn looks_goessner(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i + 2 < chars.len() {
        if chars[i] == '[' && chars[i + 1] == '?' && chars[i + 2] == '(' {
            let mut depth = 1;
            let mut j = i + 3;
            while j < chars.len() && depth > 0 {
                match chars[j] {
                    '\'' | '"' => {
                        let q = chars[j];
                        j += 1;
                        while j < chars.len() {
                            let c = chars[j];
                            j += 1;
                            if c == '\\' && j < chars.len() {
                                j += 1;
                                continue;
                            }
                            if c == q {
                                break;
                            }
                        }
                    }
                    '(' => {
                        depth += 1;
                        j += 1;
                    }
                    ')' => {
                        depth -= 1;
                        j += 1;
                    }
                    _ => j += 1,
                }
            }
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            if j < chars.len() && chars[j] == ']' {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// A single edge in a JSONPath pointer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    Name(String),
    Index(usize),
}

/// A sequence of segments resolving to a node in the document.
#[derive(Clone, Debug, PartialEq, Eq)]
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
