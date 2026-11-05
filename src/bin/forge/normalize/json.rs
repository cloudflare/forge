//! Normalizes one JSON document.
//!
//! The key a tool writes is looked up in the sources of [`super::vendor`], at
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

use super::vendor::{Change, Detail, Source};
use super::walk;

/// What [`normalize`] does.
#[derive(Clone, Copy)]
pub(super) struct Options<'a> {
    /// Keeps each key that is rewritten, beside the native key that replaces
    /// it, for what still reads the old one.
    pub(super) leave_old_extensions: bool,
    /// The compatibility sources whose keys are rewritten.
    pub(super) sources: &'a [&'static dyn Source],
}

/// What [`normalize`] did.
#[derive(Debug, Default)]
pub(super) struct Report {
    /// How many times each key was rewritten, or removed because a native key
    /// already said the same thing.
    pub(super) migrated: BTreeMap<String, usize>,
    details: BTreeMap<Detail, usize>,
}

impl Report {
    /// Returns whether the document is different from what it was.
    pub(super) fn changed(&self) -> bool {
        !self.migrated.is_empty()
    }

    /// Returns the additional descriptions of changes, and how many times
    /// each happened.
    pub(super) fn details(&self) -> impl Iterator<Item = (usize, &'static str)> + '_ {
        self.details.iter().map(|(detail, count)| {
            let description = if *count == 1 { detail.one } else { detail.many };
            (*count, description)
        })
    }

    pub(super) fn record(&mut self, original: &str, change: Change) {
        *self.migrated.entry(original.to_owned()).or_insert(0) += 1;
        if let Some(detail) = change.detail {
            *self.details.entry(detail).or_insert(0) += 1;
        }
    }
}

/// A document after [`normalize`].
#[derive(Debug)]
pub(super) struct Normalized {
    /// The document, if it is different from what was read.
    pub(super) json: Option<Vec<u8>>,
    /// What was done to it.
    pub(super) report: Report,
}

/// Rewrites the keys of the document `json` that a native key replaces.
pub(super) fn normalize(json: &[u8], options: &Options) -> Result<Normalized, serde_json::Error> {
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
