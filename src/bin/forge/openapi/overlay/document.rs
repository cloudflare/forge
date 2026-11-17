//! A spec document that tracks its original format (JSON or YAML) and its
//! unmutated source bytes, so a no-op overlay round-trips byte-identically.

use forge::Err;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Yaml,
}

impl Format {
    /// Pick a format by the first non-whitespace byte (`{`/`[` is JSON,
    /// anything else YAML). Content wins over extension so a `.yaml` file
    /// that actually holds JSON is treated as JSON (and vice-versa: YAML
    /// is a superset, so this is safe).
    pub fn sniff(bytes: &[u8]) -> Format {
        for &b in bytes {
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
    original: Vec<u8>,
    mutated: bool,
    /// Retrieval URI the document was loaded from (a `file:` URI for a path
    /// on disk, or an absolute `file:` URI for CWD when the input was stdin).
    /// Used by overlay apply to rebase relative `$ref`s in inserted content.
    base_uri: Option<String>,
}

impl Document {
    pub fn parse(bytes: &[u8], format: Format) -> Result<Document, Err> {
        let value = match format {
            Format::Json => serde_json::from_slice::<Value>(bytes).map_err(|e| format!("could not parse JSON: {e}"))?,
            Format::Yaml => parse_yaml(bytes).map_err(|e| format!("could not parse YAML: {e}"))?,
        };
        Ok(Document {
            value,
            format,
            original: bytes.to_vec(),
            mutated: false,
            base_uri: None,
        })
    }

    /// Chainable setter for the retrieval base URI.
    pub fn with_base_uri(mut self, base: Option<String>) -> Document {
        self.base_uri = base;
        self
    }

    pub fn base_uri(&self) -> Option<&str> {
        self.base_uri.as_deref()
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn value_mut(&mut self) -> &mut Value {
        &mut self.value
    }

    pub fn mark_mutated(&mut self) {
        self.mutated = true;
    }

    pub fn mutated(&self) -> bool {
        self.mutated
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, Err> {
        if !self.mutated {
            return Ok(self.original.clone());
        }
        match self.format {
            Format::Json => {
                Ok(serde_json::to_vec_pretty(&self.value).map_err(|e| format!("could not serialize JSON: {e}"))?)
            }
            Format::Yaml => Ok(serde_yml::to_string(&self.value)
                .map_err(|e| format!("could not serialize YAML: {e}"))?
                .into_bytes()),
        }
    }
}

fn parse_yaml(bytes: &[u8]) -> Result<Value, serde_yml::Error> {
    // serde_yml deserializes directly into any serde type that implements
    // Deserialize. serde_json::Value (with preserve_order) uses IndexMap
    // for objects, so key insertion order survives.
    serde_yml::from_slice::<Value>(bytes)
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
