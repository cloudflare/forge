//! What `forge normalize` gets wrong because a document is read with
//! `serde_json` and written again, as it happens today.
//!
//! Each test says what a document becomes, which is not what it should be, and
//! passes. When one of them fails, a gap was fixed: move it out of here and
//! out of "Known limitations" in the README of the package, if it is in it.

use forge::normalize::{Options, normalize};

/// A document with one key to rewrite, so that it is written again, and
/// `extra` as more of the members of the operation.
fn with_a_key_to_rewrite(extra: &str) -> String {
    format!(
        "{{\n  \"openapi\": \"3.0.3\",\n  \"info\": {{\"title\": \"t\", \"version\": \"1\"}},\n  \"paths\": {{\"/a\": {{\"get\": {{\n    \"x-fern-sdk-method-name\": \"get\",\n    {extra}\n    \"responses\": {{\"204\": {{\"description\": \"ok\"}}}}}}}}}}\n}}\n"
    )
}

#[track_caller]
fn rewritten(document: &str) -> String {
    let normalized = normalize(document.as_bytes(), &Options::default()).unwrap();
    String::from_utf8(normalized.json.expect("there is a key to rewrite")).unwrap()
}

/// GAP: a key written twice is not an error, and not left: the first of the
/// two is dropped, without a word. `forge` itself says `duplicate field`.
#[test]
fn a_key_written_twice_loses_the_first_copy_without_a_word() {
    let text = rewritten(&with_a_key_to_rewrite(
        r#""description": "first", "description": "second","#,
    ));

    assert!(text.contains("second") && !text.contains("first"), "{text}");
}

/// GAP: a number is read as a 64-bit float, or an integer that fits in 64
/// bits, so a longer one is rounded, and one written as `1E5` is written as
/// `100000.0`. `forge` reads them as floats too, but the document is what is
/// rewritten, and what is read by every other tool.
#[test]
fn a_number_that_does_not_fit_is_rounded_and_the_others_are_written_their_own_way() {
    let text = rewritten(&with_a_key_to_rewrite(
        r#""x-ids": [100000000000000000001, 3.14159265358979323846, 1E5, 0.10, 2.50],"#,
    ));

    assert!(text.contains("1e+20"), "{text}");
    assert!(
        text.contains("3.141592653589793") && !text.contains("3.1415926535897932"),
        "{text}"
    );
    assert!(text.contains("100000.0") && !text.contains("1E5"), "{text}");
    assert!(text.contains("0.1") && !text.contains("0.10"), "{text}");
    assert!(text.contains("2.5") && !text.contains("2.50"), "{text}");
}

/// GAP: line endings are not kept: a document with `\r\n` is written with
/// `\n`, so every line of it is in the diff.
#[test]
fn windows_line_endings_are_written_as_unix_ones() {
    let text = rewritten(&with_a_key_to_rewrite("").replace('\n', "\r\n"));

    assert!(!text.contains('\r'), "{text:?}");
}

/// GAP: an array or an object that is written on one line is written on
/// several, which is a diff of every one of them in a document that is
/// formatted that way, as most formatters of JSON do.
#[test]
fn an_array_on_one_line_is_written_on_several() {
    let text = rewritten(&with_a_key_to_rewrite(r#""tags": ["a", "b"],"#));

    assert!(!text.contains(r#"["a", "b"]"#), "{text}");
    assert!(text.contains("\"tags\": [\n"), "{text}");
}

/// GAP: a document on one line is written on one line, with no space after a
/// comma or a colon, which is not how it was written if it had them.
#[test]
fn spaces_in_a_document_on_one_line_are_not_kept() {
    let document = r#"{"openapi": "3.0.3", "info": {"title": "t", "version": "1"}, "paths": {"/a": {"get": {"x-fern-ignore": true, "responses": {"204": {"description": "ok"}}}}}}"#;

    let text = rewritten(document);

    assert!(!text.contains(", ") && !text.contains(": "), "{text}");
}

/// GAP: an escape is written as the character, so `\u00e9`, `\/` and `\u003c`
/// are not what they were, and a document with them is a diff of every line
/// that has one.
#[test]
fn escapes_in_strings_are_written_as_the_characters() {
    let text = rewritten(&with_a_key_to_rewrite(
        r#""description": "caf\u00e9 a\/b \u003ctag\u003e","#,
    ));

    assert!(text.contains("café a/b <tag>"), "{text}");
}

/// GAP: JSON with comments, which some call JSONC, is not JSON, and is an error.
#[test]
fn json_with_comments_is_an_error() {
    let err = normalize(b"// api\n{\"openapi\": \"3.0.3\"}", &Options::default()).unwrap_err();

    assert!(!err.to_string().is_empty());
}

/// GAP: a document nested deeper than `serde_json` allows, 128 levels, is an
/// error, wherever it is nested.
#[test]
fn a_document_nested_deeper_than_128_levels_is_an_error() {
    let document = format!(
        r#"{{"x-fern-ignore": true, "x-other": {}{}}}"#,
        "[".repeat(200),
        "]".repeat(200)
    );

    let err = normalize(document.as_bytes(), &Options::default()).unwrap_err();

    assert!(err.to_string().contains("recursion limit"), "{err}");
}

/// GAP: the whitespace outside strings is the writer's: one indentation for
/// the file, no blank lines, no spaces at the end of a line, nothing before the
/// first `{`, and one newline at the end.
#[test]
fn whitespace_is_the_writers() {
    let document = "\n\n  {\n  \"openapi\": \"3.0.3\",   \n\t\"paths\": {\"/a\": {\"get\": {\n\n    \"x-fern-ignore\": true}}}\n}  \n\n\n";

    let text = rewritten(document);

    assert_eq!(
        text,
        "{\n  \"openapi\": \"3.0.3\",\n  \"paths\": {\n    \"/a\": {\n      \"get\": {\n        \"x-forge-skip\": true\n      }\n    }\n  }\n}\n"
    );
}

/// GAP: `-0` is read as a float, and written as one.
#[test]
fn minus_zero_is_written_as_a_float() {
    let text = rewritten(&with_a_key_to_rewrite(r#""x-n": -0,"#));

    assert!(text.contains("-0.0"), "{text}");
}
