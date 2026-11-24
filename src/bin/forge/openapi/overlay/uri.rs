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
        Ok(windows_path_to_file_uri(s))
    }
    #[cfg(not(windows))]
    Ok(format!("file://{}", percent_encode_path(s)))
}

/// Format a Windows path string (including `\\?\` / `\\?\UNC\` extended-length
/// paths returned by `std::fs::canonicalize`) as an RFC 8089 `file:` URI.
#[cfg(any(windows, test))]
fn windows_path_to_file_uri(s: &str) -> String {
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        let slash = unc.replace('\\', "/");
        return format!("file://{}", percent_encode_path(&slash));
    }
    let stripped = s.strip_prefix(r"\\?\").unwrap_or(s);
    let slash = stripped.replace('\\', "/");
    if let Some(unc) = slash.strip_prefix("//") {
        format!("file://{}", percent_encode_path(unc))
    } else {
        format!("file:///{}", percent_encode_path(&slash))
    }
}

/// Validate that `s` is syntactically a valid RFC 3986 URI reference.
pub fn validate_reference(s: &str) -> Result<(), String> {
    fluent_uri::UriRef::parse(s)
        .map(|_| ())
        .map_err(|e| format!("not a valid RFC 3986 URI reference: {e}"))
}

/// Validate that a `file:` URI names no remote host (only an empty authority
/// or `localhost` is permitted per RFC 8089 / Forge's no-network policy).
pub fn validate_file_authority(uri: &str) -> Result<(), String> {
    let Some((sc, rest)) = uri.split_once(':') else {
        return Ok(());
    };
    if !sc.eq_ignore_ascii_case("file") {
        return Ok(());
    }
    if let Some(no_slashes) = rest.strip_prefix("//") {
        let authority = no_slashes.split(['/', '?', '#']).next().unwrap_or(no_slashes);
        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            return Err(format!(
                "{uri} names host {authority:?}; only file: URIs with an empty authority or `localhost` \
                 refer to a local file"
            ));
        }
    }
    Ok(())
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

/// Syntax-based normalization per RFC 3986 §6.2.2 (lowercase scheme/host,
/// uppercase percent-encoded octets, unreserved decoding, dot-segment removal)
/// so equivalent URIs compare equal.
pub fn normalize(uri: &str) -> String {
    fluent_uri::Uri::parse(uri).map_or_else(|_| uri.to_owned(), |u| u.normalize().to_string())
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
    validate_file_authority(uri)?;
    // `file:/path`, `file:///path`, `file://localhost/path`.
    let after_authority = if let Some(no_slashes) = rest.strip_prefix("//") {
        match no_slashes.find('/') {
            Some(i) => &no_slashes[i..],
            None => "/",
        }
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

/// Try to express `target` as a path relative to the directory containing
/// `base`. Both must be `file:` URIs. Returns `None` when a relative
/// expression is impossible (different schemes, Windows cross-drive,
/// or when the result would need to walk up more than two `..` segments
/// — past that threshold the relative form is fragile enough that we
/// prefer the absolute `file:` URI). Preserves `target`'s fragment on
/// the output; the path portion is percent-encoded as a file URI path.
pub fn relative_file_ref(base: &str, target: &str) -> Option<String> {
    // Both URIs must be file: for a path-relative expression to make sense.
    if !scheme(base).is_some_and(|s| s == "file") {
        return None;
    }
    if !scheme(target).is_some_and(|s| s == "file") {
        return None;
    }
    // Split target fragment off the URI, not the path, so a `#` in the
    // path (percent-encoded, but belt-and-suspenders) isn't misread.
    let (target_no_frag, fragment) = match target.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (target, None),
    };
    let (target_path_uri, query) = match target_no_frag.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target_no_frag, None),
    };
    let base_is_dir = base.ends_with('/');
    let base_path = to_path(base).ok()?;
    let target_path = to_path(target_path_uri).ok()?;
    if !base_is_dir && target_path == base_path {
        // Same-file reference. Per RFC 3986 §5.2.2, a reference consisting
        // of just `?query` or just `#fragment` (or both) inherits the base
        // path and replaces only the component it carries, so both are
        // portable same-document relative refs. Emit whichever components
        // the original ref carried; when neither is present there is no
        // relative form left to emit and we fall back to the absolute URI.
        let mut out = String::new();
        if let Some(q) = query {
            out.push('?');
            out.push_str(q);
        }
        if let Some(f) = fragment {
            out.push('#');
            out.push_str(f);
        }
        return (!out.is_empty()).then_some(out);
    }
    // A trailing-slash `base` (e.g. stdin's CWD) is already the directory; a
    // file `base` uses its parent directory.
    let base_dir = if base_is_dir {
        base_path.as_path()
    } else {
        base_path.parent()?
    };

    let rel = make_relative(base_dir, &target_path)?;
    // Threshold: anything deeper than `../../` is fragile (brittle to
    // small layout changes, hard for humans to follow); fall back to the
    // absolute URI instead. Count ALL ParentDir components, not just
    // leading ones: fluent_uri::resolve_reference normalizes per RFC 3986
    // §5.2.4 so leading-only is sufficient in practice, but counting all
    // is defense-in-depth against future callers that might hand in a
    // non-normalized target.
    const MAX_UP_HOPS: usize = 2;
    let up_hops = rel
        .components()
        .filter(|c| matches!(c, std::path::Component::ParentDir))
        .count();
    if up_hops > MAX_UP_HOPS {
        return None;
    }

    // Serialize the relative path with `/` separators (URI-shaped, not
    // platform-shaped) and percent-encode as a file: URI path would be.
    let mut out = String::new();
    let mut first = true;
    for comp in rel.components() {
        if !first {
            out.push('/');
        }
        first = false;
        match comp {
            std::path::Component::ParentDir => out.push_str(".."),
            std::path::Component::CurDir => out.push('.'),
            std::path::Component::Normal(s) => {
                let seg = s.to_str()?;
                out.push_str(&percent_encode_path(seg));
            }
            // RootDir / Prefix should not appear in a relative result.
            _ => return None,
        }
    }
    if out.is_empty() {
        // Reached only when the target resolves to the base file's parent
        // directory (`$ref: "../"` and friends) — same-file was handled
        // in the early return above. A ref to a directory has no useful
        // relative form that downstream tools will resolve, so fall back
        // to the absolute URI.
        return None;
    }
    // RFC 3986 §4.2: a relative path's first segment cannot contain `:`, or
    // URI parsers interpret the prefix as a scheme (e.g. `a:b.yaml` -> scheme
    // `a`). Prefix with `./` so it stays a valid relative reference.
    if out.split('/').next().is_some_and(|seg| seg.contains(':')) {
        out.insert_str(0, "./");
    }
    if let Some(q) = query {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = fragment {
        out.push('#');
        out.push_str(f);
    }
    Some(out)
}

/// Compute `target` as a path relative to `base_dir`, walking up with
/// `..` segments as needed. Returns `None` on cross-prefix paths (different
/// Windows drives, root vs. relative mix) that have no common prefix.
fn make_relative(base_dir: &Path, target: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut base_iter = base_dir.components().peekable();
    let mut target_iter = target.components().peekable();
    // Both should start with the same prefix / root (file: URIs always
    // produce absolute paths on POSIX; on Windows the drive prefix must
    // match for relativization to make sense).
    while let (Some(b), Some(t)) = (base_iter.peek(), target_iter.peek()) {
        if b == t {
            base_iter.next();
            target_iter.next();
        } else {
            break;
        }
    }
    // If the paths never shared a root/prefix, bail out.
    // (On POSIX, both start with RootDir, so the loop above always
    // consumed at least one component; on Windows, the prefix must have
    // matched.)
    let mut out = PathBuf::new();
    for c in base_iter {
        match c {
            Component::Normal(_) | Component::ParentDir | Component::CurDir => out.push(".."),
            // A difference at RootDir or Prefix means no relative path exists.
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    for c in target_iter {
        match c {
            Component::Normal(n) => out.push(n),
            Component::ParentDir => out.push(".."),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
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

#[cfg(test)]
mod tests {
    use super::{normalize, relative_file_ref, validate_file_authority, validate_reference, windows_path_to_file_uri};

    #[test]
    fn windows_extended_length_paths_produce_clean_file_uris() {
        assert_eq!(
            windows_path_to_file_uri(r"\\?\C:\Users\dev\spec.json"),
            "file:///C:/Users/dev/spec.json"
        );
        assert_eq!(
            windows_path_to_file_uri(r"\\?\C:\my dir\spec.json"),
            "file:///C:/my%20dir/spec.json"
        );
        assert_eq!(
            windows_path_to_file_uri(r"C:\Users\dev\spec.json"),
            "file:///C:/Users/dev/spec.json"
        );
        assert_eq!(
            windows_path_to_file_uri(r"\\?\UNC\server\share\spec.json"),
            "file://server/share/spec.json"
        );
    }

    #[test]
    fn file_authority_validation_rejects_remote_hosts() {
        assert!(validate_file_authority("file:///a/b.json").is_ok());
        assert!(validate_file_authority("file://localhost/a/b.json").is_ok());
        assert!(validate_file_authority("file:/a/b.json").is_ok());
        assert!(validate_file_authority("file://evil.example/a/b.json").is_err());
        assert!(validate_file_authority("file://evil.example?x=1").is_err());
    }

    #[test]
    fn reference_validation_rejects_malformed_uris() {
        assert!(validate_reference("./spec.yaml").is_ok());
        assert!(validate_reference("file:///a/b.yaml").is_ok());
        assert!(validate_reference("urn:example:spec").is_ok());
        assert!(validate_reference("http ://example.com/spec.yaml").is_err());
        assert!(validate_reference("file://[bad").is_err());
    }

    #[test]
    fn relative_file_ref_prefixes_colon_in_first_segment_and_handles_dir_base() {
        // RFC 3986 §4.2: a colon in the first segment of a relative path would
        // parse as a URI scheme unless prefixed with `./`.
        assert_eq!(
            relative_file_ref("file:///work/spec.yaml", "file:///work/a:b.yaml#/X"),
            Some("./a:b.yaml#/X".to_owned())
        );
        // Colons in later segments (or after `../`) are already valid.
        assert_eq!(
            relative_file_ref("file:///work/spec.yaml", "file:///work/sub/a:b.yaml"),
            Some("sub/a:b.yaml".to_owned())
        );
        // Trailing-slash directory base (used for stdin) resolves directly
        // against that directory and never matches a real file as same-file.
        assert_eq!(
            relative_file_ref("file:///work/", "file:///work/shared.yaml#/X"),
            Some("shared.yaml#/X".to_owned())
        );
    }

    #[test]
    fn normalize_lowercases_scheme_and_uppercases_percent_encoding() {
        assert_eq!(normalize("FILE:///a/b%2fc.yaml"), normalize("file:///a/b%2Fc.yaml"));
    }
}
