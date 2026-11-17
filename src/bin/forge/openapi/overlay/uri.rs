//! Minimal RFC 3986 URI handling for `$self` / `extends` resolution.
//!
//! Forge is a restricted overlay runtime: it NEVER fetches `http:` or
//! `https:` URIs. That rejection is enforced at the schema layer; this
//! module turns a successfully validated reference into a local file path
//! (or an error naming the resolved URI).

use std::path::{Path, PathBuf};

use forge::Err;

/// Build a `file://` URI for a local path.
pub fn from_path(path: &Path) -> Result<String, Err> {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir().map_or_else(|_| path.to_owned(), |cwd| cwd.join(path))
        }
    });
    let s = abs
        .to_str()
        .ok_or_else(|| format!("path {} is not valid UTF-8", abs.display()))?;
    #[cfg(windows)]
    {
        let s = s.replace('\\', "/");
        Ok(format!("file:///{}", percent_encode_path(&s)))
    }
    #[cfg(not(windows))]
    Ok(format!("file://{}", percent_encode_path(s)))
}

/// Resolve `reference` against `base`, per RFC 3986 §5.
pub fn resolve_reference(base: &str, reference: &str) -> Result<String, String> {
    let base_uri = fluent_uri::Uri::parse(base).map_err(|e| format!("invalid base URI {base}: {e}"))?;
    let ref_uri = fluent_uri::UriRef::parse(reference).map_err(|e| format!("invalid reference {reference}: {e}"))?;
    let resolved = ref_uri
        .resolve_against(&base_uri)
        .map_err(|e| format!("could not resolve {reference} against {base}: {e}"))?;
    Ok(resolved.to_string())
}

/// Return the local file path for a `file:` URI. Errors for any other
/// scheme, and for a `file:` URI whose authority is neither empty nor
/// `localhost` (RFC 8089 only guarantees interop for those two).
pub fn to_path(uri: &str) -> Result<PathBuf, String> {
    let Some((scheme, rest)) = uri.split_once(':') else {
        return Err(format!("{uri} has no scheme, so it is not a file: URI"));
    };
    if !scheme.eq_ignore_ascii_case("file") {
        return Err(format!(
            "{uri} uses the {} scheme, not file:",
            scheme.to_ascii_lowercase()
        ));
    }
    // `file:/path`, `file:///path`, `file://localhost/path`.
    let after_authority = if let Some(no_slashes) = rest.strip_prefix("//") {
        let (authority, path) = match no_slashes.find('/') {
            Some(i) => (&no_slashes[..i], &no_slashes[i..]),
            None => (no_slashes, "/"),
        };
        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            return Err(format!(
                "{uri} names host {authority:?}; only file: URIs with an empty authority or `localhost` \
                 refer to a local file"
            ));
        }
        path
    } else {
        rest
    };
    // Trim query/fragment if any — $self / extends forbid fragments, but a
    // directly-handed URI might still carry one in error paths.
    let no_frag = after_authority.split_once('#').map_or(after_authority, |(p, _)| p);
    let path_part = no_frag.split_once('?').map_or(no_frag, |(p, _)| p);
    let decoded = percent_decode(path_part);
    #[cfg(windows)]
    {
        // `/C:/foo` -> `C:/foo`.
        let trimmed = decoded.strip_prefix('/').unwrap_or(&decoded);
        Ok(PathBuf::from(trimmed))
    }
    #[cfg(not(windows))]
    Ok(PathBuf::from(decoded))
}

/// The scheme of a URI, lowercased, or `None` for a relative reference.
pub fn scheme(uri: &str) -> Option<String> {
    let (s, _) = uri.split_once(':')?;
    // Ensure the "scheme" is a valid RFC 3986 scheme (ALPHA (ALPHA/DIGIT/+/-/.)*).
    let mut chars = s.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return None;
        }
    }
    Some(s.to_ascii_lowercase())
}

/// Does `uri` contain a `#` fragment?
pub fn has_fragment(uri: &str) -> bool {
    uri.contains('#')
}

fn percent_encode_path(s: &str) -> String {
    // Encode the minimum needed for a file path: spaces and a few control
    // characters. Keep `/` unescaped so segments stay recognizable.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + (b - b'a')),
        b'A'..=b'F' => Some(10 + (b - b'A')),
        _ => None,
    }
}
