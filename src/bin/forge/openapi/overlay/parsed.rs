//! Overlay document: parsing, validation, security checks, and the
//! top-level application driver.

use forge::Err;
use serde_json::Value;

use super::action::{Action, ActionBody, Fields};
use super::document::{Document, type_name};
use super::path::Path as JPath;
use super::uri;

/// A parsed, validated overlay document.
pub struct Overlay {
    pub version: Version,
    pub self_uri: Option<String>,
    pub extends: Option<String>,
    pub actions: Vec<Action>,
    /// 1.2 only; name -> (Fields, optional description).
    pub components_actions: std::collections::BTreeMap<String, Fields>,
    /// Resolved base URI (`$self`-resolved against the retrieval URI) if
    /// known. Used to rebase relative `$ref`s inside inserted content so
    /// the merged spec is self-contained.
    pub base_uri: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Version {
    V1_0,
    V1_1,
    V1_2,
    FutureV1(u32),
}

impl Version {
    pub fn supports_copy(self) -> bool {
        !matches!(self, Version::V1_0)
    }
    pub fn supports_components(self) -> bool {
        matches!(self, Version::V1_2 | Version::FutureV1(_))
    }
    pub fn allows_primitive_update(self) -> bool {
        !matches!(self, Version::V1_0)
    }
    pub fn concat_arrays(self) -> bool {
        !matches!(self, Version::V1_0)
    }
    pub fn allows_info_description(self) -> bool {
        !matches!(self, Version::V1_0)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Version::V1_0 => "1.0",
            Version::V1_1 => "1.1",
            Version::V1_2 => "1.2",
            Version::FutureV1(_) => "1.x",
        }
    }
}

impl Overlay {
    pub fn parse(bytes: &[u8], format: super::document::Format) -> Result<Overlay, Err> {
        let (value, _) = super::document::parse_value(bytes, format, "overlay as ")?;
        parse_overlay(&value)
    }

    pub fn from_value(value: &Value) -> Result<Overlay, Err> {
        parse_overlay(value)
    }

    pub fn extends(&self) -> Option<&str> {
        self.extends.as_deref()
    }

    /// Chainable setter for the resolved base URI.
    pub fn with_base_uri(mut self, base: Option<String>) -> Overlay {
        self.base_uri = base;
        self
    }

    pub fn base_uri(&self) -> Option<&str> {
        self.base_uri.as_deref()
    }

    /// 1.2 §Base URI rule 5: when a 1.2 overlay has `extends` and the target
    /// spec declares `$self`, the resolved extends identifier must equal the
    /// target's `$self` (string equality). The overlay was written against a
    /// specific document; `$self` proves which. Returns an unprefixed message
    /// on mismatch so callers can prepend their own source label (overlay
    /// path, stdin, etc.).
    pub fn check_extends_identity(&self, resolved_extends: &str, doc: &Document) -> Result<(), String> {
        if !self.version.supports_components() || self.extends.is_none() {
            return Ok(());
        }
        let Some(target_self) = doc.value().get("$self").and_then(|v| v.as_str()) else {
            return Ok(());
        };
        // OpenAPI 3.2 permits a relative `$self`; resolve it against the
        // target document's retrieval URI before comparing identities.
        let resolved_target_self = match doc.base_uri() {
            Some(base) => uri::resolve_reference(base, target_self)
                .map_err(|e| format!("cannot resolve target spec's $self {target_self:?} against {base}: {e}"))?,
            None if uri::scheme(target_self).is_some() => target_self.to_owned(),
            None => {
                return Err(format!(
                    "target spec's $self {target_self:?} is relative, but the spec has no \
                     resolvable location to resolve it against. Make the spec's $self an \
                     absolute URI (e.g. a `file:` or `urn:` identifier), or pass the spec \
                     as a file path on disk so its location can be used as the base."
                ));
            }
        };
        if uri::normalize(resolved_extends) != uri::normalize(&resolved_target_self) {
            return Err(format!(
                "overlay's resolved extends identifier {resolved_extends:?} does not match \
                 the target spec's resolved $self {resolved_target_self:?}: the overlay was written \
                 against a different document"
            ));
        }
        Ok(())
    }

    /// Resolve `$self` against the overlay retrieval URI, returning the
    /// base URI to resolve `extends` against. If `$self` is absent, the
    /// retrieval URI is the base.
    pub fn resolve_base_uri(&self, retrieval_uri: &str) -> Result<String, Err> {
        match &self.self_uri {
            None => Ok(retrieval_uri.to_owned()),
            Some(s) => {
                // Absolute? Then it IS the base (possibly after normalizing).
                if uri::scheme(s).is_some() {
                    Ok(s.clone())
                } else {
                    // Relative $self: resolve against retrieval.
                    uri::resolve_reference(retrieval_uri, s)
                        .map_err(|e| format!("could not resolve $self {s:?} against overlay retrieval URI: {e}").into())
                }
            }
        }
    }

    /// Emit a stderr warning if this document declared a future 1.x minor
    /// version we may not fully understand.
    pub fn diagnose_warnings(&self) {
        if let Version::FutureV1(minor) = self.version {
            crate::log::warn!(
                "overlay version 1.{minor}.x is newer than this build; \
                 applying known features and skipping any that are unsupported"
            );
        }
    }

    pub fn apply(&self, doc: &mut Document) -> Result<Vec<super::apply::ActionReport>, Err> {
        let mut reports = Vec::with_capacity(self.actions.len());
        let overlay_base = self.base_uri();
        let spec_base = doc.base_uri().map(str::to_owned);
        for (i, action) in self.actions.iter().enumerate() {
            let (body, ref_name) = match &action.body {
                ActionBody::Direct(f) => (f, None),
                ActionBody::Ref { name } => {
                    let fields = self.components_actions.get(name).ok_or_else(|| {
                        format!(
                            "action {i}: $ref #/components/actions/{name} does not resolve — \
                             no such component in this overlay"
                        )
                    })?;
                    (fields, Some(name.clone()))
                }
            };
            let mut report = super::apply::apply_action(
                doc,
                self.version,
                &action.target_path,
                body,
                overlay_base,
                spec_base.as_deref(),
            )
            .map_err(|e| format!("action {i} (target {}): {e}", action.target_path.source()))?;
            report.ref_name = ref_name;
            reports.push(report);
        }
        Ok(reports)
    }
}

fn parse_overlay(value: &Value) -> Result<Overlay, Err> {
    let obj = value
        .as_object()
        .ok_or_else(|| "overlay document root must be an object".to_owned())?;

    // ---- overlay version ----
    let overlay_v = obj
        .get("overlay")
        .ok_or_else(|| "overlay document is missing the required `overlay` version string".to_owned())?;
    let version_s = overlay_v
        .as_str()
        .ok_or_else(|| format!("overlay version must be a string, got {}", type_name(overlay_v)))?;
    let version = parse_version(version_s)?;

    // ---- top-level unknown key check ----
    let allowed_root: &[&str] = match version {
        Version::V1_0 | Version::V1_1 => &["overlay", "info", "extends", "actions"],
        Version::V1_2 | Version::FutureV1(_) => &["overlay", "info", "$self", "extends", "components", "actions"],
    };
    for (k, _) in obj.iter() {
        if k.starts_with("x-") {
            continue;
        }
        if !allowed_root.contains(&k.as_str()) {
            return Err(format!(
                "unknown overlay top-level key {k:?} for overlay version {}: known keys are {}",
                version.as_str(),
                allowed_root.join(", ")
            )
            .into());
        }
    }

    // ---- info ----
    let info = obj
        .get("info")
        .ok_or_else(|| "overlay document is missing the required `info` object".to_owned())?;
    validate_info(info, version)?;

    // ---- extends ----
    let extends = if let Some(e) = obj.get("extends") {
        let s = e
            .as_str()
            .ok_or_else(|| format!("`extends` must be a string, got {}", type_name(e)))?;
        validate_uri_field("extends", s)?;
        Some(s.to_owned())
    } else {
        None
    };

    // ---- $self (1.2 only) ----
    let self_uri = if version.supports_components() {
        if let Some(s) = obj.get("$self") {
            let s = s
                .as_str()
                .ok_or_else(|| format!("`$self` must be a string, got {}", type_name(s)))?;
            validate_uri_field("$self", s)?;
            Some(s.to_owned())
        } else {
            None
        }
    } else {
        // Rejected above as an unknown key.
        None
    };

    // ---- components (1.2 only; rejected above as an unknown key in 1.0/1.1) ----
    let components_actions = match obj.get("components") {
        Some(c) => parse_components(c)?,
        None => Default::default(),
    };

    // ---- actions ----
    let actions_v = obj
        .get("actions")
        .ok_or_else(|| "overlay document is missing the required `actions` array".to_owned())?;
    let actions_arr = actions_v.as_array().ok_or_else(|| {
        format!(
            "`actions` must be an array, got {} — it holds the ordered list of overlay actions",
            type_name(actions_v)
        )
    })?;
    if actions_arr.is_empty() {
        return Err("`actions` array must contain at least one entry".into());
    }
    // Dedup by canonicalized whole-action equality (target, body, description,
    // and `x-*` extensions): two actions that differ in `description` or an
    // extension are NOT duplicates; identical actions (even with different key
    // ordering) are rejected in O(1) via a HashSet.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::with_capacity(actions_arr.len());
    let mut actions = Vec::with_capacity(actions_arr.len());
    for (i, a) in actions_arr.iter().enumerate() {
        let action = parse_action(a, version, &components_actions, i)?;
        if let Some(key) = dedup_key(a)
            && !seen.insert(key)
        {
            return Err(format!(
                "duplicate action at index {i}: overlay `actions` entries must be unique \
                 (identical target, body, description, and extensions)"
            )
            .into());
        }
        actions.push(action);
    }

    Ok(Overlay {
        version,
        self_uri,
        extends,
        actions,
        components_actions,
        base_uri: None,
    })
}

fn validate_info(info: &Value, version: Version) -> Result<(), Err> {
    let obj = info.as_object().ok_or_else(|| {
        format!(
            "`info` must be an object with `title` and `version`, got {}",
            type_name(info)
        )
    })?;
    let title = obj
        .get("title")
        .ok_or_else(|| "`info` object is missing the required `title` string".to_owned())?;
    if !title.is_string() {
        return Err(format!("`info.title` must be a string, got {}", type_name(title)).into());
    }
    let v = obj
        .get("version")
        .ok_or_else(|| "`info` object is missing the required `version` string".to_owned())?;
    if !v.is_string() {
        return Err(format!("`info.version` must be a string, got {}", type_name(v)).into());
    }
    let allowed: &[&str] = if version.allows_info_description() {
        &["title", "version", "description"]
    } else {
        &["title", "version"]
    };
    for (k, val) in obj.iter() {
        if k.starts_with("x-") {
            continue;
        }
        if !allowed.contains(&k.as_str()) {
            return Err(format!(
                "unknown `info` key {k:?} for overlay version {}: known keys are {}. \
                 (`info.description` was added in Overlay 1.1 — if this is the 1.0 \
                 `unevaluatedProperties: false` rule biting you, declare `overlay: \"1.1.0\"`.)",
                version.as_str(),
                allowed.join(", ")
            )
            .into());
        }
        if k == "description" && !val.is_string() {
            return Err(format!("`info.description` must be a string, got {}", type_name(val)).into());
        }
    }
    Ok(())
}

/// Canonical dedup key for an action. Includes every field the action
/// carries (target, verb body, description, `x-*` extensions, and the
/// `$ref`/description of a reusable-action reference), so two actions
/// that differ only in `description` or an extension are NOT duplicates
/// — the OAI test corpus only pins identical actions as duplicates.
///
/// Returns `None` when the action is not even a JSON object; `parse_action`
/// will error on that case with a better message, so the dedup scan skips.
/// Object keys are sorted recursively (since `serde_json` uses `preserve_order`),
/// so key order at any depth does not affect the fingerprint, matching
/// `serde_json::Value::eq`.
fn dedup_key(a: &Value) -> Option<String> {
    if !a.is_object() {
        return None;
    }
    let mut out = String::new();
    write_canonical_json(a, &mut out);
    Some(out)
}

fn write_canonical_json(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(a, _)| *a);
            out.push('{');
            for (idx, (k, val)) in entries.into_iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical_json(val, out);
            }
            out.push('}');
        }
        Value::Array(arr) => {
            out.push('[');
            for (idx, val) in arr.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_canonical_json(val, out);
            }
            out.push(']');
        }
        other => {
            out.push_str(&serde_json::to_string(other).unwrap_or_default());
        }
    }
}

fn parse_action(
    v: &Value,
    version: Version,
    components: &std::collections::BTreeMap<String, Fields>,
    i: usize,
) -> Result<Action, Err> {
    let obj = v
        .as_object()
        .ok_or_else(|| format!("action at index {i} must be an object, got {}", type_name(v)))?;

    let has_ref = obj.contains_key("$ref");
    if has_ref {
        if !version.supports_components() {
            return Err(format!(
                "action at index {i}: `$ref` reusable-action references are an unknown key in overlay version {}: they were added in 1.2",
                version.as_str()
            )
            .into());
        }
        // Reusable Action Reference Object. Allowed keys: $ref, target,
        // description, x-*.
        for (k, val) in obj.iter() {
            if k.starts_with("x-") {
                continue;
            }
            match k.as_str() {
                "$ref" | "target" | "description" => {}
                "update" | "copy" | "remove" => {
                    return Err(format!(
                        "action at index {i}: a reusable action reference (`$ref`) may not carry \
                         `{k}` directly — move the field into `components.actions.*.fields`"
                    )
                    .into());
                }
                other => {
                    return Err(format!(
                        "action at index {i}: unknown key {other:?} on a `$ref` reusable action reference"
                    )
                    .into());
                }
            }
            if k == "description" && !val.is_string() {
                return Err(format!("action at index {i}: `description` must be a string").into());
            }
        }

        let ref_val = &obj["$ref"];
        let ref_s = ref_val.as_str().ok_or_else(|| {
            format!(
                "action at index {i}: `$ref` must be a string, got {}",
                type_name(ref_val)
            )
        })?;

        let target_v = obj
            .get("target")
            .ok_or_else(|| format!("action at index {i}: a `$ref` reusable action reference requires `target`"))?;
        let target_s = target_v
            .as_str()
            .ok_or_else(|| format!("action at index {i}: `target` must be a string"))?;
        let target_path = JPath::parse(target_s).map_err(|e| format!("action at index {i}: {e}"))?;

        let name = resolve_component_ref(ref_s).map_err(|e| format!("action at index {i}: {e}"))?;
        if !components.contains_key(&name) {
            return Err(format!(
                "action at index {i}: $ref {ref_s:?} does not resolve — \
                 no `components.actions.{name}` is defined in this overlay"
            )
            .into());
        }

        return Ok(Action {
            target_path,
            body: ActionBody::Ref { name },
        });
    }

    // Direct action body.
    let target_v = obj
        .get("target")
        .ok_or_else(|| format!("action at index {i}: missing required `target` JSONPath string"))?;
    let target_s = target_v.as_str().ok_or_else(|| {
        format!(
            "action at index {i}: `target` must be a string, got {}",
            type_name(target_v)
        )
    })?;
    let target_path = JPath::parse(target_s).map_err(|e| format!("action at index {i}: {e}"))?;

    let fields = parse_fields(obj, version, Some(i))?;

    Ok(Action {
        target_path,
        body: ActionBody::Direct(fields),
    })
}

fn parse_fields(obj: &serde_json::Map<String, Value>, version: Version, index: Option<usize>) -> Result<Fields, Err> {
    let mut update = None;
    let mut copy = None;
    let mut remove = false;
    let inside_components = index.is_none();
    let label = |msg: String| match index {
        Some(i) => format!("action at index {i}: {msg}"),
        None => msg,
    };

    for (k, val) in obj.iter() {
        if k.starts_with("x-") {
            continue;
        }
        match k.as_str() {
            "update" => {
                update = Some(val.clone());
            }
            "copy" => {
                if !version.supports_copy() {
                    return Err(label(format!(
                        "`copy` is unknown in overlay version {}: it was added in 1.1",
                        version.as_str()
                    ))
                    .into());
                }
                let s = val
                    .as_str()
                    .ok_or_else(|| label(format!("`copy` must be a JSONPath string, got {}", type_name(val))))?;
                let p = JPath::parse(s).map_err(|e| label(format!("`copy` {e}")))?;
                copy = Some(p);
            }
            "remove" => {
                remove = val
                    .as_bool()
                    .ok_or_else(|| label(format!("`remove` must be a boolean, got {}", type_name(val))))?;
            }
            "description" => {
                if !val.is_string() {
                    return Err(label("`description` must be a string".to_owned()).into());
                }
            }
            "target" => {
                if inside_components {
                    return Err("components.actions `fields` object may not contain `target` — \
                         `target` is forbidden here and must come from the reference site"
                        .into());
                }
            }
            other => {
                return Err(label(format!("unknown action key {other:?}")).into());
            }
        }
    }

    Ok(Fields { update, copy, remove })
}

fn parse_components(v: &Value) -> Result<std::collections::BTreeMap<String, Fields>, Err> {
    let obj = v
        .as_object()
        .ok_or_else(|| format!("`components` must be an object, got {}", type_name(v)))?;
    let mut out = std::collections::BTreeMap::new();
    for (k, val) in obj.iter() {
        if k.starts_with("x-") {
            continue;
        }
        match k.as_str() {
            "actions" => {}
            other => {
                return Err(format!("unknown `components` key {other:?}: only `actions` is allowed").into());
            }
        }
        let actions = val
            .as_object()
            .ok_or_else(|| format!("`components.actions` must be an object, got {}", type_name(val)))?;
        for (name, ra_v) in actions.iter() {
            let ra = ra_v
                .as_object()
                .ok_or_else(|| format!("`components.actions.{name}` must be an object, got {}", type_name(ra_v)))?;
            // Peer-fields check.
            let has_fields = ra.contains_key("fields");
            for (rk, rv) in ra.iter() {
                if rk.starts_with("x-") {
                    continue;
                }
                match rk.as_str() {
                    "fields" | "description" => {}
                    "target" | "update" | "copy" | "remove" => {
                        return Err(format!(
                            "`components.actions.{name}` has peer `{rk}` next to `fields`; \
                             action fields belong inside `fields`, not as peers"
                        )
                        .into());
                    }
                    other => {
                        return Err(format!(
                            "`components.actions.{name}` has unknown key {other:?}: only `fields`, `description`, and `x-*` are allowed"
                        )
                        .into());
                    }
                }
                if rk == "description" && !rv.is_string() {
                    return Err(format!("`components.actions.{name}.description` must be a string").into());
                }
            }
            let fields_v = if has_fields {
                &ra["fields"]
            } else {
                return Err(format!("`components.actions.{name}` is missing the required `fields` object").into());
            };
            let fields_obj = fields_v.as_object().ok_or_else(|| {
                format!(
                    "`components.actions.{name}.fields` must be an object, got {}",
                    type_name(fields_v)
                )
            })?;
            let fields = parse_fields(fields_obj, Version::V1_2, None)
                .map_err(|e| format!("in components.actions.{name}: {e}"))?;
            out.insert(name.clone(), fields);
        }
    }
    Ok(out)
}

fn resolve_component_ref(r: &str) -> Result<String, String> {
    const PREFIX: &str = "#/components/actions/";
    if !r.starts_with("#/components/actions/") {
        return Err(format!(
            "invalid $ref {r:?}: only `#/components/actions/<name>` references are valid \
             reusable action references"
        ));
    }
    let tail = &r[PREFIX.len()..];
    if tail.is_empty() {
        return Err("invalid $ref: `#/components/actions/` with no component name".into());
    }
    // Per RFC 6901 §6 (URI fragment JSON Pointer), percent-decode before
    // checking `/` segment delimiters and unescaping `~1`/`~0`.
    let decoded = uri::percent_decode(tail);
    if decoded.contains('/') {
        return Err(format!(
            "invalid $ref {r:?}: component name segment contains an unescaped `/`. \
             JSON Pointer requires `~1` for `/` and `~0` for `~`."
        ));
    }
    let name = jsonpointer_unescape(&decoded)?;
    Ok(name)
}

fn jsonpointer_unescape(s: &str) -> Result<String, String> {
    // Standard JSON Pointer unescape: ~1 -> /, ~0 -> ~. An unescaped
    // `~<other>` is malformed per RFC 6901.
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            if i + 1 >= bytes.len() {
                return Err(format!(
                    "malformed JSON Pointer segment {s:?}: `~` at end must be `~0` (for `~`) or `~1` (for `/`)"
                ));
            }
            match bytes[i + 1] {
                b'0' => {
                    out.push('~');
                    i += 2;
                    continue;
                }
                b'1' => {
                    out.push('/');
                    i += 2;
                    continue;
                }
                other => {
                    return Err(format!(
                        "malformed JSON Pointer segment {s:?}: unescaped `~{}` — write `~0` for `~` and `~1` for `/`",
                        other as char
                    ));
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    Ok(out)
}

fn parse_version(s: &str) -> Result<Version, Err> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return Err(format!(
            "unsupported overlay version {s:?}: must be a `<major>.<minor>.<patch>` string \
             in the 1.x family (e.g. 1.0.0, 1.1.0, 1.2.0)"
        )
        .into());
    }
    let (major, minor, patch) = (parts[0], parts[1], parts[2]);
    let major = parse_version_part(major, s, "major")?;
    let minor = parse_version_part(minor, s, "minor")?;
    // Reject pre-release/build, signs, and leading zeros on patch.
    let _patch = parse_version_part(patch, s, "patch")?;
    if major != 1 {
        return Err(
            format!("unsupported overlay version {s:?}: this forge supports the Overlay 1.x family only").into(),
        );
    }
    Ok(match minor {
        0 => Version::V1_0,
        1 => Version::V1_1,
        2 => Version::V1_2,
        m => Version::FutureV1(m),
    })
}

fn parse_version_part(part: &str, full: &str, label: &str) -> Result<u32, Err> {
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "unsupported overlay version {full:?}: {label} must be a plain non-negative integer (no `-pre` or `+build`)"
        )
        .into());
    }
    if part.len() > 1 && part.starts_with('0') {
        return Err(format!("unsupported overlay version {full:?}: {label} must not have leading zeros").into());
    }
    part.parse::<u32>()
        .map_err(|_| format!("unsupported overlay version {full:?}: {label} is out of range").into())
}

fn validate_uri_field(name: &str, s: &str) -> Result<(), Err> {
    // Forbid fragments on $self and extends.
    if uri::has_fragment(s) {
        return Err(format!(
            "`{name}` URI {s:?} contains a `#` fragment, which is forbidden: both $self and \
             extends must be fragment-free per the 1.2 spec (and this build enforces it in \
             every version)"
        )
        .into());
    }
    // Security: only `file:`, `urn:`, and relative references are allowed.
    let scheme = uri::scheme(s);
    if let Some(ref sc) = scheme
        && sc != "file"
        && sc != "urn"
    {
        if sc == "http" || sc == "https" {
            return Err(format!(
                "`{name}` URI {s:?} uses the {sc} scheme, which this forge refuses: \
                 forge never opens a network connection to resolve overlay references. \
                 Use a file: URI or a relative path to a file on disk."
            )
            .into());
        }
        return Err(format!(
            "`{name}` URI {s:?} uses the {sc} scheme, which is not supported for overlay \
             references: only file:, urn:, and relative URI references are permitted."
        )
        .into());
    }
    // Validate RFC 3986 syntax upfront so malformed URIs (e.g. `"http ://..."`)
    // are rejected even in Mode B before any resolution.
    uri::validate_reference(s).map_err(|e| format!("`{name}` URI {s:?} is invalid: {e}"))?;
    // Enforce local-only `file:` authorities upfront (empty or `localhost`)
    // across Mode A and Mode B.
    if scheme.as_deref() == Some("file") {
        uri::validate_file_authority(s).map_err(|e| format!("`{name}` URI {e}"))?;
    }
    Ok(())
}
