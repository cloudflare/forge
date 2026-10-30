//! Rewrites the extensions other tools' metadata is written with into the
//! native `x-forge-*` ones, in a JSON document.
//!
//! The key a tool writes is found with the tables of [`vendor`], at the kinds
//! of OpenAPI object where its native replacement belongs. A key elsewhere is
//! left alone, since rewriting it would give it a meaning it did not have.
//!
//! A native key is never replaced. When a document says the same thing with a
//! native key and another, the native one is kept.
//!
//! The document is read with `serde_json` and written again, in the order its
//! keys were in, with the indentation of its first indented line. That is
//! simple, and it is not a minimal edit: what is lost is listed in the README
//! of the package under "Known limitations", and each one is pinned by a test in
//! `tests/normalize/known_gaps.rs`.

mod vendor;
mod walk;

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;
use serde_json::Value;
use serde_json::ser::PrettyFormatter;

/// A source of compatibility keys that [`normalize`] can rewrite.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Cloudflare's compatibility keys.
    Cloudflare,
    /// Deprecated Forge keys that have a current replacement.
    Deprecated,
    /// Fern's compatibility keys.
    Fern,
    /// Stainless's compatibility keys.
    Stainless,
}

impl Source {
    const fn bit(self) -> u8 {
        match self {
            Source::Cloudflare => 1,
            Source::Deprecated => 2,
            Source::Fern => 4,
            Source::Stainless => 8,
        }
    }
}

/// The sources of compatibility keys that [`normalize`] rewrites.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sources(u8);

impl Sources {
    /// Every compatibility source.
    pub const ALL: Sources = Sources(1 | 2 | 4 | 8);

    /// Returns only `source`.
    pub const fn only(source: Source) -> Sources {
        Sources(source.bit())
    }

    /// Returns whether `source` is included.
    pub const fn contains(self, source: Source) -> bool {
        self.0 & source.bit() != 0
    }
}

impl FromIterator<Source> for Sources {
    fn from_iter<T: IntoIterator<Item = Source>>(sources: T) -> Sources {
        Sources(sources.into_iter().fold(0, |bits, source| bits | source.bit()))
    }
}

/// What [`normalize`] does.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Keeps each key that is rewritten, beside the native key that replaces
    /// it, for what still reads the old one.
    pub leave_old_extensions: bool,
    /// The compatibility sources to rewrite.
    pub sources: Sources,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            leave_old_extensions: false,
            sources: Sources::ALL,
        }
    }
}

/// What [`normalize`] did.
#[derive(Debug, Default)]
pub struct Report {
    /// How many keys were rewritten, or removed for a native key that
    /// already said it, by the name of the key.
    pub migrated: BTreeMap<String, usize>,
    /// How many group paths were written again, as the names joined by dots,
    /// which is the one value that is not copied as it was.
    pub joined: usize,
}

impl Report {
    /// Returns whether the document is different from what it was.
    pub fn changed(&self) -> bool {
        !self.migrated.is_empty()
    }
}

/// A document after [`normalize`].
#[derive(Debug)]
pub struct Normalized {
    /// The document, if it is different from what was read.
    pub json: Option<Vec<u8>>,
    /// What was done to it.
    pub report: Report,
}

/// Why a document could not be normalized.
#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Error {
        Error(err.to_string())
    }
}

/// Rewrites the keys of the document `json` that a native key replaces.
pub fn normalize(json: &[u8], options: &Options) -> Result<Normalized, Error> {
    let mut document: Value = serde_json::from_slice(json)?;
    let report = walk::walk(&mut document, options);
    if !report.changed() {
        return Ok(Normalized { json: None, report });
    }
    Ok(Normalized {
        json: Some(write(&document, json)),
        report,
    })
}

/// Writes `document` as `original` was written, as far as it is known: with
/// its indentation, which is that of the first line that is indented, on one
/// line if it was, and with a newline at the end if it had one.
fn write(document: &Value, original: &[u8]) -> Vec<u8> {
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
    let first = memchr::memchr(b'\n', original)?;
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
    fn all_sources_includes_every_compatibility_adapter() {
        for source in [Source::Cloudflare, Source::Deprecated, Source::Fern, Source::Stainless] {
            assert!(Sources::ALL.contains(source), "{source:?}");
        }
    }

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
            write(&serde_json::json!({"a": 1, "b": [1, 2]}), br#"{"a":1}"#),
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
        assert!(write(&document, b"{\n  \"a\": 1\n}\n").ends_with(b"}\n"));
        assert!(write(&document, b"{\n  \"a\": 1\n}").ends_with(b"}"));
    }
}
