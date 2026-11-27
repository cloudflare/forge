//! A spec document that tracks its original format (JSON or YAML) and its
//! unmutated source bytes, so a no-op overlay round-trips byte-identically.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use forge::Err;
use serde_json::Value;

/// Strip a leading UTF-8 BOM, if present.
pub(super) fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Yaml,
}

impl Format {
    /// Pick a format by the first non-whitespace byte after any UTF-8 BOM
    /// (`{`/`[` suggests JSON, anything else YAML). Content wins over
    /// extension; `Document::parse` and `Overlay::parse` also fall back from
    /// JSON to YAML so flow-style YAML root mappings (`{key: val}`) still work.
    pub fn sniff(bytes: &[u8]) -> Format {
        for &b in strip_utf8_bom(bytes) {
            match b {
                b' ' | b'\t' | b'\r' | b'\n' => {}
                b'{' | b'[' => return Format::Json,
                _ => return Format::Yaml,
            }
        }
        Format::Yaml
    }
}

/// A parsed document plus the bytes it came from, so an unmutated document
/// can be serialized back byte-identically.
pub struct Document {
    value: Value,
    format: Format,
    /// Original input bytes, kept only until the first mutation so a no-op
    /// round-trips byte-identically without re-serializing and a mutated
    /// document releases the raw buffer immediately.
    original: Option<Vec<u8>>,
    /// Original input byte length, used to pre-size the output buffer on
    /// serialization and avoid repeated reallocations on large specs.
    original_len: usize,
    mutated: bool,
    /// Retrieval URI the document was loaded from (a `file:` URI for a path
    /// on disk, or an absolute `file:` URI for CWD when the input was stdin).
    /// Used by overlay apply to re-express rebased relative `$ref`s as paths
    /// relative to this location, falling back to an absolute `file:` URI
    /// when a relative expression is not possible.
    base_uri: Option<String>,
    /// Filesystem path this document was loaded from, if not stdin. Used to
    /// detect in-place `--out` rewrites in both Mode A and Mode B.
    source_path: Option<PathBuf>,
}

/// Parse JSON or YAML bytes (stripping any UTF-8 BOM) into a [`Value`] and
/// the detected [`Format`]. If `format` is `Format::Json` (e.g. a `{`-prefixed
/// flow-style YAML file) and JSON parsing fails, falls back to YAML.
pub(super) fn parse_value(bytes: &[u8], format: Format, label: &str) -> Result<(Value, Format), Err> {
    let content = strip_utf8_bom(bytes);
    match format {
        Format::Json => match serde_json::from_slice::<Value>(content) {
            Ok(v) => Ok((v, Format::Json)),
            Err(json_err) => match parse_yaml(content) {
                Ok(v) => Ok((v, Format::Yaml)),
                Err(yaml_err) => Err(format!("could not parse {label}JSON ({json_err}) or YAML ({yaml_err})").into()),
            },
        },
        Format::Yaml => Ok((
            parse_yaml(content).map_err(|e| format!("could not parse {label}YAML: {e}"))?,
            Format::Yaml,
        )),
    }
}

impl Document {
    pub fn parse(bytes: Vec<u8>, format: Format) -> Result<Document, Err> {
        let (value, format) = parse_value(&bytes, format, "")?;
        let original_len = bytes.len();
        Ok(Document {
            value,
            format,
            original: Some(bytes),
            original_len,
            mutated: false,
            base_uri: None,
            source_path: None,
        })
    }

    /// Chainable setter for the retrieval base URI.
    pub fn with_base_uri(mut self, base: Option<String>) -> Document {
        self.base_uri = base;
        self
    }

    /// Chainable setter for the on-disk source path.
    pub fn with_source_path(mut self, path: Option<PathBuf>) -> Document {
        self.source_path = path;
        self
    }

    pub fn base_uri(&self) -> Option<&str> {
        self.base_uri.as_deref()
    }

    pub fn source_path(&self) -> Option<&Path> {
        self.source_path.as_deref()
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn value_mut(&mut self) -> &mut Value {
        &mut self.value
    }

    pub fn mark_mutated(&mut self) {
        if !self.mutated {
            self.mutated = true;
            // No longer needed for byte-identical no-op round-trips; release now.
            self.original = None;
        }
    }

    pub fn mutated(&self) -> bool {
        self.mutated
    }

    pub fn to_bytes(&self) -> Result<Cow<'_, [u8]>, Err> {
        if !self.mutated
            && let Some(orig) = self.original.as_deref()
        {
            return Ok(Cow::Borrowed(orig));
        }
        match self.format {
            Format::Json => {
                let mut buf = Vec::with_capacity(self.original_len);
                serde_json::to_writer_pretty(&mut buf, &self.value)
                    .map_err(|e| format!("could not serialize JSON: {e}"))?;
                Ok(Cow::Owned(buf))
            }
            Format::Yaml => Ok(Cow::Owned(
                serde_saphyr::to_string(&self.value)
                    .map_err(|e| format!("could not serialize YAML: {e}"))?
                    .into_bytes(),
            )),
        }
    }
}

fn parse_yaml(bytes: &[u8]) -> Result<Value, serde_saphyr::Error> {
    // serde-saphyr deserializes directly into any serde type that implements
    // Deserialize. serde_json::Value (with preserve_order) uses IndexMap
    // for objects, so key insertion order survives.
    serde_saphyr::from_slice::<Value>(bytes)
}

pub(super) fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
