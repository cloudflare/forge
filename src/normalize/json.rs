//! Normalizes one JSON document.
//!
//! The key a tool writes is looked up in the adapters of [`super::vendor`], at
//! the kinds of OpenAPI object where its native replacement belongs. A key
//! elsewhere is left alone, since rewriting it would give it a meaning it did
//! not have.
//!
//! A native key is never replaced. When a document says the same thing with a
//! native key and another, the native one is kept.
//!
//! The document is read with `serde_json` and written again, in the order its
//! keys were in, with the indentation of its first indented line. That is
//! simple, but it is not a minimal edit. The package README lists what is lost
//! under "Known limitations".

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use serde_json::ser::PrettyFormatter;

use super::Adapter;
use super::vendor::{Change, Detail};
use super::walk;

/// Configuration for [`normalize`].
#[derive(Clone, Copy, Debug)]
pub struct Options<'a> {
    /// Keeps rewritten keys alongside their native replacements instead of
    /// removing them.
    pub leave_old_extensions: bool,
    /// Adapters to apply, in precedence order. When multiple adapters match
    /// the same key, the first one wins.
    pub adapters: &'a [Adapter],
}

/// Summary of the changes made by [`normalize`].
#[derive(Debug, Default)]
pub struct Report {
    /// Count of times each original key was rewritten or removed as a
    /// duplicate of a native key.
    pub migrated: BTreeMap<String, usize>,
    details: BTreeMap<Detail, usize>,
}

impl Report {
    /// Returns `true` if any key was rewritten or removed.
    pub fn changed(&self) -> bool {
        !self.migrated.is_empty()
    }

    /// Returns counts and descriptions of value conversions beyond key
    /// renames, such as converting an array group path into a dotted string.
    /// Each description is singular or plural to match its count.
    pub fn details(&self) -> impl Iterator<Item = (usize, &'static str)> + '_ {
        self.details.iter().map(|(detail, count)| {
            let description = if *count == 1 { detail.one } else { detail.many };
            (*count, description)
        })
    }

    pub(crate) fn record(&mut self, original: &str, change: Change) {
        *self.migrated.entry(original.to_owned()).or_insert(0) += 1;
        if let Some(detail) = change.detail {
            *self.details.entry(detail).or_insert(0) += 1;
        }
    }
}

/// Output of [`normalize`].
#[derive(Debug)]
pub struct Normalized {
    /// Rewritten JSON bytes, or `None` when nothing needed rewriting.
    pub json: Option<Vec<u8>>,
    /// Summary of the changes made.
    pub report: Report,
}

/// Rewrites third-party metadata extensions in `json` into Forge's native
/// `x-forge-*` keys using [`Options::adapters`].
///
/// Preserves key order, detected indentation (or single-line formatting), and
/// any trailing newline. Because the document is parsed and re-serialized,
/// escape sequences and number formatting may change.
///
/// # Errors
///
/// Returns an error if `json` is not valid JSON.
///
/// # Examples
///
/// ```
/// use forge::normalize::{normalize, Adapter, Options};
///
/// let fern = Adapter::named("fern").unwrap();
/// let options = Options { leave_old_extensions: false, adapters: &[fern] };
///
/// let json = br#"{"paths":{"/pets":{"get":{"x-fern-sdk-group-name":["pets","owners"]}}}}"#;
/// let normalized = normalize(json, &options)?;
/// assert_eq!(
///     String::from_utf8(normalized.json.unwrap()).unwrap(),
///     r#"{"paths":{"/pets":{"get":{"x-forge-group-name":"pets.owners"}}}}"#,
/// );
/// // The report records value conversions such as array-to-dotted group paths.
/// assert_eq!(
///     normalized.report.details().collect::<Vec<_>>(),
///     [(1, "group path written as a dotted string")],
/// );
/// assert_eq!(normalized.report.migrated["x-fern-sdk-group-name"], 1);
///
/// // Documents with nothing to rewrite are returned unchanged.
/// let native = br#"{"paths":{"/pets":{"get":{"x-forge-group-name":"pets"}}}}"#;
/// let normalized = normalize(native, &options)?;
/// assert!(normalized.json.is_none() && !normalized.report.changed());
/// # Ok::<(), serde_json::Error>(())
/// ```
pub fn normalize(json: &[u8], options: &Options) -> Result<Normalized, serde_json::Error> {
    let mut document: Value = serde_json::from_slice(json)?;
    let report = walk::walk(&mut document, options);
    if !report.changed() {
        return Ok(Normalized { json: None, report });
    }
    Ok(Normalized {
        json: Some(encode(&document, json)),
        report,
    })
}

/// Encodes `document` as `original` was written, as far as that is known: with
/// its indentation, which is that of the first line that is indented, on one
/// line if it was, and with a newline at the end if it had one.
fn encode(document: &Value, original: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(original.len() + original.len() / 16);
    match indentation(original) {
        Some(indent) => {
            let mut serializer = serde_json::Serializer::with_formatter(&mut out, PrettyFormatter::with_indent(indent));
            document
                .serialize(&mut serializer)
                .expect("a document is written as JSON to the memory");
        }
        None => serde_json::to_writer(&mut out, document).expect("a document is written as JSON to the memory"),
    }
    if original.ends_with(b"\n") {
        out.push(b'\n');
    }
    out
}

/// Returns what `original` is indented with, or none if it is on one line.
fn indentation(original: &[u8]) -> Option<&[u8]> {
    let first = original.iter().position(|&byte| byte == b'\n')?;
    for line in original[first + 1..].split(|byte| *byte == b'\n') {
        let blanks = line.iter().take_while(|byte| matches!(byte, b' ' | b'\t')).count();
        if blanks > 0 && blanks < line.len() {
            return Some(&line[..blanks]);
        }
    }
    Some(b"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_indentation_is_that_of_the_first_line_that_is_indented() {
        assert_eq!(indentation(b"{\n  \"a\": {\n      \"b\": 1\n  }\n}"), Some(&b"  "[..]));
        assert_eq!(indentation(b"{\n\t\"a\": 1\n}"), Some(&b"\t"[..]));
        assert_eq!(indentation(b"{\n    \"a\": 1\n}"), Some(&b"    "[..]));
    }

    #[test]
    fn a_document_on_one_line_is_written_on_one_line() {
        assert_eq!(indentation(br#"{"a":1}"#), None);
        assert_eq!(
            encode(&serde_json::json!({"a": 1, "b": [1, 2]}), br#"{"a":1}"#),
            br#"{"a":1,"b":[1,2]}"#
        );
    }

    #[test]
    fn a_document_with_no_indented_line_is_written_with_none() {
        assert_eq!(indentation(b"{\n\"a\": 1\n}\n"), Some(&b""[..]));
    }

    #[test]
    fn a_blank_line_with_spaces_is_not_the_indentation() {
        assert_eq!(indentation(b"{\n   \n  \"a\": 1\n}"), Some(&b"  "[..]));
    }

    #[test]
    fn the_newline_at_the_end_is_kept_if_there_was_one() {
        let document = serde_json::json!({"a": 1});
        assert!(encode(&document, b"{\n  \"a\": 1\n}\n").ends_with(b"}\n"));
        assert!(encode(&document, b"{\n  \"a\": 1\n}").ends_with(b"}"));
    }
}
