//! Fast, streaming specification-family detection for CLI inputs.
//!
//! Identifies common API specification formats (in JSON, YAML, or text
//! formats) without building a DOM or parsing the full document. For JSON and
//! YAML mappings, deserialization aborts on the first top-level spec marker
//! key (`openapi`, `overlay`, `swagger`, `asyncapi`, `arazzo`, `openrpc`), so
//! typical documents stop after reading only a few bytes.

use std::borrow::Cow;
use std::fmt;
use std::io;

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};

/// Serialization syntax of a detected mapping document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Syntax {
    Json,
    Yaml,
}

/// API specification family detected from a document's contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpecKind {
    /// OpenAPI 3.x (`openapi: "<version>"`).
    OpenApi { version: Option<String>, syntax: Syntax },
    /// OpenAPI Overlay 1.x (`overlay: "<version>"`).
    Overlay { version: Option<String>, syntax: Syntax },
    /// Swagger (`swagger: ...`).
    Swagger,
    /// AsyncAPI (`asyncapi: ...`).
    AsyncApi,
    /// Arazzo (`arazzo: ...`).
    Arazzo,
    /// OpenRPC (`openrpc: ...`).
    OpenRpc,
    /// JSON Schema (`$schema: ...`, when no API spec marker key is present).
    JsonSchema,
    /// RAML (`#%RAML ...`).
    Raml,
    /// Protocol Buffers (`syntax = "proto..."` / `edition = "..."`).
    Protobuf,
    /// WSDL (`<definitions` / `<wsdl:definitions`).
    Wsdl,
    /// GraphQL SDL (`schema {` / `type ... {` / etc.).
    GraphQl,
    /// Smithy IDL (`$version: ...`).
    Smithy,
    /// Unrecognized or malformed input.
    Unknown,
}

impl SpecKind {
    /// Human-readable name for the specification family (without version).
    pub fn family_name(&self) -> Option<&'static str> {
        match self {
            SpecKind::OpenApi { .. } => Some("OpenAPI"),
            SpecKind::Overlay { .. } => Some("OpenAPI Overlay"),
            SpecKind::Swagger => Some("Swagger"),
            SpecKind::AsyncApi => Some("AsyncAPI"),
            SpecKind::Arazzo => Some("Arazzo"),
            SpecKind::OpenRpc => Some("OpenRPC"),
            SpecKind::JsonSchema => Some("JSON Schema"),
            SpecKind::Raml => Some("RAML"),
            SpecKind::Protobuf => Some("Protocol Buffers"),
            SpecKind::Wsdl => Some("WSDL"),
            SpecKind::GraphQl => Some("GraphQL"),
            SpecKind::Smithy => Some("Smithy"),
            SpecKind::Unknown => None,
        }
    }

    /// Returns an error message when this specification family is not supported
    /// by `forge generate` / `forge inspect`. Never mentions a version for
    /// families where no version is supported.
    pub fn unsupported_error(&self) -> Option<&'static str> {
        match self {
            SpecKind::OpenApi {
                syntax: Syntax::Yaml, ..
            } => Some("YAML OpenAPI documents are not supported yet: convert the document to JSON first"),
            SpecKind::OpenApi {
                syntax: Syntax::Json, ..
            }
            | SpecKind::Overlay { .. }
            | SpecKind::Unknown => None,
            SpecKind::Swagger => {
                Some("Swagger documents are not supported: convert the document to OpenAPI 3.0, 3.1, or 3.2")
            }
            SpecKind::AsyncApi => Some("AsyncAPI documents are not supported yet"),
            SpecKind::Arazzo => Some("Arazzo documents are not supported yet"),
            SpecKind::OpenRpc => Some("OpenRPC documents are not supported yet"),
            SpecKind::JsonSchema => Some("JSON Schema documents are not supported: expected an OpenAPI document"),
            SpecKind::Raml => Some("RAML documents are not supported yet"),
            SpecKind::Protobuf => Some("Protocol Buffers documents are not supported yet"),
            SpecKind::Wsdl => Some("WSDL documents are not supported yet"),
            SpecKind::GraphQl => Some("GraphQL documents are not supported yet"),
            SpecKind::Smithy => Some("Smithy documents are not supported yet"),
        }
    }
}

impl fmt::Display for SpecKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecKind::OpenApi { version: Some(v), .. } => write!(f, "OpenAPI {v}"),
            SpecKind::Overlay { version: Some(v), .. } => write!(f, "OpenAPI Overlay {v}"),
            _ => f.write_str(self.family_name().unwrap_or("unknown")),
        }
    }
}

/// Detects the API specification family of `bytes`.
pub fn detect(bytes: &[u8]) -> SpecKind {
    let content = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let Some(first) = first_non_whitespace(content) else {
        return SpecKind::Unknown;
    };

    // Fast magic checks that avoid invoking JSON/YAML parsers on non-mapping
    // formats (RAML's `#%RAML` header is otherwise a YAML comment).
    if first == b'#' && looks_like_raml(content) {
        return SpecKind::Raml;
    }
    if first == b'<' {
        return if looks_like_wsdl(content) {
            SpecKind::Wsdl
        } else {
            SpecKind::Unknown
        };
    }

    // JSON object: try streaming JSON first; only fall back to YAML on a real
    // syntax error (so flow-style YAML `{overlay: 1.0.0}` still works).
    if first == b'{' {
        match detect_json(content) {
            Probe::Found(kind) => return kind,
            Probe::NotFound => return SpecKind::Unknown,
            Probe::ParseError => {}
        }
    }

    if let Probe::Found(kind) = detect_yaml(content) {
        return kind;
    }

    detect_text_idl(content)
}

fn first_non_whitespace(bytes: &[u8]) -> Option<u8> {
    bytes
        .iter()
        .copied()
        .find(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
}

enum Probe {
    /// A recognized spec marker (or `$schema`) was found.
    Found(SpecKind),
    /// Parsed as a mapping to EOF without finding any known marker.
    NotFound,
    /// Not valid in this syntax (caller may try another parser).
    ParseError,
}

fn detect_json(content: &[u8]) -> Probe {
    let mut found = None;
    let mut saw_json_schema = false;
    let mut de = serde_json::Deserializer::from_slice(content);
    let result = TopLevelProbe {
        syntax: Syntax::Json,
        found: &mut found,
        saw_json_schema: &mut saw_json_schema,
    }
    .deserialize(&mut de);
    probe_result(found, saw_json_schema, result.is_ok())
}

fn detect_yaml(content: &[u8]) -> Probe {
    let mut found = None;
    let mut saw_json_schema = false;
    let mut options = serde_saphyr::options! {
        with_snippet: false,
        duplicate_keys: serde_saphyr::DuplicateKeyPolicy::LastWins,
    };
    // Probe skips values with `IgnoredAny` (no DOM built), so disable the
    // default node/event budget that would otherwise abort large YAML specs
    // whose spec marker key appears late in the file.
    options.budget = None;
    // Stream through `from_reader` rather than `from_slice`: `from_slice` runs
    // `str::from_utf8` across the entire input upfront, whereas `from_reader`
    // decodes lazily in chunks and stops as soon as `TopLevelProbe` aborts.
    let result = serde_saphyr::with_deserializer_from_reader_with_options(io::Cursor::new(content), options, |de| {
        TopLevelProbe {
            syntax: Syntax::Yaml,
            found: &mut found,
            saw_json_schema: &mut saw_json_schema,
        }
        .deserialize(de)
    });
    probe_result(found, saw_json_schema, result.is_ok())
}

fn probe_result(found: Option<SpecKind>, saw_json_schema: bool, completed_ok: bool) -> Probe {
    if let Some(kind) = found {
        Probe::Found(kind)
    } else if completed_ok {
        if saw_json_schema {
            Probe::Found(SpecKind::JsonSchema)
        } else {
            Probe::NotFound
        }
    } else {
        Probe::ParseError
    }
}

/// Streaming `DeserializeSeed` that scans top-level mapping keys and aborts
/// deserialization the instant a definitive spec marker key is seen.
struct TopLevelProbe<'a> {
    syntax: Syntax,
    found: &'a mut Option<SpecKind>,
    saw_json_schema: &'a mut bool,
}

impl<'de> DeserializeSeed<'de> for TopLevelProbe<'_> {
    type Value = ();

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for TopLevelProbe<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a top-level mapping")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<Cow<'de, str>>()? {
            let detected = match key.as_ref() {
                "openapi" => {
                    let version = map.next_value::<OptionalVersion>()?.0;
                    Some(SpecKind::OpenApi {
                        version,
                        syntax: self.syntax,
                    })
                }
                "overlay" => {
                    let version = map.next_value::<OptionalVersion>()?.0;
                    Some(SpecKind::Overlay {
                        version,
                        syntax: self.syntax,
                    })
                }
                "swagger" => {
                    map.next_value::<IgnoredAny>()?;
                    Some(SpecKind::Swagger)
                }
                "asyncapi" => {
                    map.next_value::<IgnoredAny>()?;
                    Some(SpecKind::AsyncApi)
                }
                "arazzo" => {
                    map.next_value::<IgnoredAny>()?;
                    Some(SpecKind::Arazzo)
                }
                "openrpc" => {
                    map.next_value::<IgnoredAny>()?;
                    Some(SpecKind::OpenRpc)
                }
                "$schema" => {
                    map.next_value::<IgnoredAny>()?;
                    *self.saw_json_schema = true;
                    None
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                    None
                }
            };
            if let Some(kind) = detected {
                *self.found = Some(kind);
                // Abort the pull parser immediately so the rest of the
                // document is never read or tokenized.
                return Err(de::Error::custom("detected"));
            }
        }
        Ok(())
    }
}

/// Captures a string version value without failing if the value has a
/// non-string type (e.g., an unquoted numeric `openapi: 3.1` in YAML).
struct OptionalVersion(Option<String>);

impl<'de> serde::Deserialize<'de> for OptionalVersion {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct VersionVisitor;
        impl<'de> Visitor<'de> for VersionVisitor {
            type Value = OptionalVersion;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a version value")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(OptionalVersion(Some(v.to_owned())))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(OptionalVersion(Some(v)))
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(OptionalVersion(None))
            }

            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(OptionalVersion(None))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(OptionalVersion(None))
            }
        }
        deserializer.deserialize_any(VersionVisitor)
    }
}

/// Prefix window inspected for non-JSON/YAML IDL formats.
const TEXT_SNIFF_LIMIT: usize = 4096;

fn sniff_text(content: &[u8]) -> Option<&str> {
    let end = content.len().min(TEXT_SNIFF_LIMIT);
    // Step back to a UTF-8 character boundary if the limit sliced a codepoint.
    let mut i = end;
    while i > 0 && std::str::from_utf8(&content[..i]).is_err() {
        if end - i >= 4 {
            return None;
        }
        i -= 1;
    }
    std::str::from_utf8(&content[..i]).ok()
}

fn looks_like_raml(content: &[u8]) -> bool {
    let Some(text) = sniff_text(content) else {
        return false;
    };
    text.trim_start().starts_with("#%RAML")
}

fn looks_like_wsdl(content: &[u8]) -> bool {
    let Some(text) = sniff_text(content) else {
        return false;
    };
    text.contains("<wsdl:definitions")
        || text.contains("schemas.xmlsoap.org/wsdl")
        || text.contains("www.w3.org/ns/wsdl")
        || (text.contains("<definitions") && text.contains("xmlns"))
}

fn detect_text_idl(content: &[u8]) -> SpecKind {
    let Some(text) = sniff_text(content) else {
        return SpecKind::Unknown;
    };
    let mut in_block_comment = false;
    let mut in_graphql_doc = false;
    for raw_line in text.lines() {
        let mut line = raw_line.trim();
        if in_block_comment {
            if let Some((_, rest)) = line.split_once("*/") {
                in_block_comment = false;
                line = rest.trim();
            } else {
                continue;
            }
        }
        if in_graphql_doc {
            if let Some((_, rest)) = line.split_once("\"\"\"") {
                in_graphql_doc = false;
                line = rest.trim();
            } else {
                continue;
            }
        }
        while let Some(rest) = line.strip_prefix("/*") {
            if let Some((_, after)) = rest.split_once("*/") {
                line = after.trim();
            } else {
                in_block_comment = true;
                line = "";
                break;
            }
        }
        if let Some(rest) = line.strip_prefix("\"\"\"") {
            if let Some((_, after)) = rest.split_once("\"\"\"") {
                line = after.trim();
            } else {
                in_graphql_doc = true;
                continue;
            }
        }
        if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
            continue;
        }

        if looks_like_smithy_line(line) {
            return SpecKind::Smithy;
        }
        if looks_like_protobuf_line(line) {
            return SpecKind::Protobuf;
        }
        if looks_like_graphql_line(line) {
            return SpecKind::GraphQl;
        }
        // Only inspect the first meaningful declaration line.
        break;
    }
    SpecKind::Unknown
}

fn looks_like_smithy_line(line: &str) -> bool {
    line.starts_with("$version:") || line.starts_with("namespace ")
}

fn looks_like_protobuf_line(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix("syntax")
        && let Some(rhs) = rest.trim_start().strip_prefix('=')
    {
        let rhs = rhs.trim_start();
        return rhs.starts_with("\"proto") || rhs.starts_with("'proto");
    }
    if let Some(rest) = line.strip_prefix("edition")
        && let Some(rhs) = rest.trim_start().strip_prefix('=')
    {
        let rhs = rhs.trim_start();
        return rhs.starts_with('"') || rhs.starts_with('\'');
    }
    false
}

fn looks_like_graphql_line(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix("schema") {
        let rest = rest.trim_start();
        if rest.starts_with('{') || rest.starts_with('@') {
            return true;
        }
    }
    let line = line.strip_prefix("extend ").map_or(line, str::trim_start);
    for kw in ["type ", "interface ", "input ", "enum "] {
        if let Some(rest) = line.strip_prefix(kw) {
            let rest = rest.trim_start();
            if has_graphql_ident_prefix(rest) && rest.contains('{') {
                return true;
            }
        }
    }
    if let Some(rest) = line.strip_prefix("union ") {
        let rest = rest.trim_start();
        if has_graphql_ident_prefix(rest) && rest.contains('=') {
            return true;
        }
    }
    false
}

fn has_graphql_ident_prefix(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::{SpecKind, Syntax, detect};

    #[test]
    fn detects_openapi_json_and_yaml() {
        assert_eq!(
            detect(br#"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"}}"#),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Json,
            }
        );
        assert_eq!(
            detect(b"openapi: 3.0.3\ninfo:\n  title: t\n"),
            SpecKind::OpenApi {
                version: Some("3.0.3".into()),
                syntax: Syntax::Yaml,
            }
        );
        assert_eq!(
            detect(b"# comment\n---\nopenapi: '3.2.0'\ninfo:\n  title: t\n"),
            SpecKind::OpenApi {
                version: Some("3.2.0".into()),
                syntax: Syntax::Yaml,
            }
        );
    }

    #[test]
    fn detects_overlay_json_yaml_flow_yaml_and_bom() {
        assert_eq!(
            detect(br#"{"overlay": "1.0.0", "info": {"title": "t", "version": "1"}}"#),
            SpecKind::Overlay {
                version: Some("1.0.0".into()),
                syntax: Syntax::Json,
            }
        );
        assert_eq!(
            detect(b"\xEF\xBB\xBF{\"overlay\": \"1.1.0\"}"),
            SpecKind::Overlay {
                version: Some("1.1.0".into()),
                syntax: Syntax::Json,
            }
        );
        assert_eq!(
            detect(b"overlay: 1.2.0\ninfo:\n  title: t\n"),
            SpecKind::Overlay {
                version: Some("1.2.0".into()),
                syntax: Syntax::Yaml,
            }
        );
        assert_eq!(
            detect(b"{overlay: 1.1.0, info: {title: t}}"),
            SpecKind::Overlay {
                version: Some("1.1.0".into()),
                syntax: Syntax::Yaml,
            }
        );
    }

    #[test]
    fn aborts_early_without_parsing_the_rest_of_the_document() {
        // Invalid trailing bytes after the first key prove neither parser
        // continues past the spec marker key.
        assert_eq!(
            detect(br#"{"openapi": "3.1.0", NOT_VALID_JSON_AT_ALL"#),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Json,
            }
        );
        assert_eq!(
            detect(b"openapi: '3.1.0'\n: : : [unterminated yaml"),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Yaml,
            }
        );
        assert_eq!(
            detect(br#"{"asyncapi": "3.0.0", NOT_VALID_JSON_AT_ALL"#),
            SpecKind::AsyncApi
        );

        // Trailing invalid UTF-8 well past the first read chunk proves YAML
        // streaming does not validate the whole slice upfront.
        let mut yaml_with_late_bad_utf8 = b"openapi: '3.1.0'\ninfo:\n  title: ".to_vec();
        yaml_with_late_bad_utf8.resize(128 * 1024, b'a');
        yaml_with_late_bad_utf8.extend_from_slice(&[0xFF, 0xFE]);
        assert_eq!(
            detect(&yaml_with_late_bad_utf8),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Yaml,
            }
        );
    }

    #[test]
    fn detects_marker_past_large_leading_values() {
        let padding = "x".repeat(70 * 1024);
        let yaml = format!("info:\n  x-pad: '{padding}'\noverlay: 1.1.0\n");
        assert_eq!(
            detect(yaml.as_bytes()),
            SpecKind::Overlay {
                version: Some("1.1.0".into()),
                syntax: Syntax::Yaml,
            }
        );
    }

    #[test]
    fn schema_key_does_not_shadow_real_spec_marker() {
        let openapi_with_schema = br#"{"$schema": "https://spec.openapis.org/oas/3.1/schema", "openapi": "3.1.0"}"#;
        assert_eq!(
            detect(openapi_with_schema),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Json,
            }
        );

        let standalone_schema = br#"{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"}"#;
        assert_eq!(detect(standalone_schema), SpecKind::JsonSchema);
    }

    #[test]
    fn detects_unsupported_spec_families() {
        assert_eq!(detect(br#"{"swagger": "2.0", "info": {}}"#), SpecKind::Swagger);
        assert_eq!(detect(b"swagger: '2.0'\ninfo:\n  title: t\n"), SpecKind::Swagger);
        assert_eq!(detect(br#"{"asyncapi": "3.0.0"}"#), SpecKind::AsyncApi);
        assert_eq!(detect(b"asyncapi: 2.6.0\n"), SpecKind::AsyncApi);
        assert_eq!(detect(br#"{"arazzo": "1.0.0"}"#), SpecKind::Arazzo);
        assert_eq!(detect(b"arazzo: 1.0.1\n"), SpecKind::Arazzo);
        assert_eq!(detect(br#"{"openrpc": "1.3.2"}"#), SpecKind::OpenRpc);
        assert_eq!(detect(b"openrpc: 1.3.2\n"), SpecKind::OpenRpc);
        assert_eq!(detect(b"#%RAML 1.0\ntitle: Pets\n"), SpecKind::Raml);
        assert_eq!(
            detect(b"// header\nsyntax = \"proto3\";\npackage pets;\n"),
            SpecKind::Protobuf
        );
        assert_eq!(detect(b"edition = \"2023\";\n"), SpecKind::Protobuf);
        assert_eq!(
            detect(b"<?xml version=\"1.0\"?>\n<definitions xmlns=\"http://schemas.xmlsoap.org/wsdl/\"/>"),
            SpecKind::Wsdl
        );
        assert_eq!(detect(b"type Query {\n  hello: String\n}\n"), SpecKind::GraphQl);
        assert_eq!(detect(b"schema {\n  query: Query\n}\n"), SpecKind::GraphQl);
        assert_eq!(detect(b"$version: \"2.0\"\nnamespace com.example\n"), SpecKind::Smithy);
    }

    #[test]
    fn unsupported_errors_omit_versions() {
        for kind in [
            SpecKind::Swagger,
            SpecKind::AsyncApi,
            SpecKind::Arazzo,
            SpecKind::OpenRpc,
            SpecKind::JsonSchema,
            SpecKind::Raml,
            SpecKind::Protobuf,
            SpecKind::Wsdl,
            SpecKind::GraphQl,
            SpecKind::Smithy,
        ] {
            let msg = kind.unsupported_error().expect("has unsupported error");
            assert!(
                !msg.contains("2.0") && !msg.contains("1.0"),
                "{kind:?} error should not mention an unsupported spec's version: {msg}"
            );
        }
    }

    #[test]
    fn yaml_probe_survives_duplicate_keys_before_marker() {
        let yaml = b"info:\n  title: a\n  title: b\nopenapi: '3.1.0'\n";
        assert_eq!(
            detect(yaml),
            SpecKind::OpenApi {
                version: Some("3.1.0".into()),
                syntax: Syntax::Yaml,
            }
        );
    }

    #[test]
    fn unknown_inputs_return_unknown() {
        assert_eq!(detect(b""), SpecKind::Unknown);
        assert_eq!(detect(b"{"), SpecKind::Unknown);
        assert_eq!(detect(b"[1, 2, 3]"), SpecKind::Unknown);
        assert_eq!(detect(br#"{"hello": "world"}"#), SpecKind::Unknown);
        assert_eq!(detect(b"<html/>"), SpecKind::Unknown);
    }
}
