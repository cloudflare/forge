//! Compatibility-source adapters for [`super::json::normalize`].
//!
//! A [`Source`] names the normalizers that apply to operations, parameters,
//! and schemas. A key is listed only at the OpenAPI object kind where Forge
//! reads its native replacement; elsewhere it is left alone. A [`Normalize`]
//! gives the [`Native`] form of an extension: the key that replaces it and
//! its value; the walk renames the key.
//!
//! To add a compatibility source, implement [`Source`] in a module here and
//! add its value to [`ALL`]. To add a key to an existing source, return its
//! normalizer from the applicable method. Normalization introduces no new
//! Forge semantics: the corresponding native key must already exist.

mod cloudflare;
mod fern;
mod stainless;
#[cfg(test)]
mod tests;

use serde_json::Value;

/// Every available compatibility source.
pub(super) static ALL: &[&dyn Source] = &[&cloudflare::Cloudflare, &fern::Fern, &stainless::Stainless];

/// Returns the compatibility source called `name`, if there is one.
pub(super) fn named(name: &str) -> Option<&'static dyn Source> {
    ALL.iter().find(|source| source.name() == name).copied()
}

/// A source of compatibility extensions.
pub(super) trait Source: Sync {
    /// The name accepted by `--from`.
    fn name(&self) -> &'static str;

    /// The normalizer for `key` on operations and aliases, if there is one.
    fn definition(&self, _key: &str) -> Option<&dyn Normalize> {
        None
    }

    /// The normalizer for `key` on Parameter Objects, if there is one.
    fn parameter(&self, _key: &str) -> Option<&dyn Normalize> {
        None
    }

    /// The normalizer for `key` on Schema Objects, if there is one.
    fn schema(&self, _key: &str) -> Option<&dyn Normalize> {
        None
    }
}

/// Normalizes one compatibility extension into its [`Native`] form.
pub(super) trait Normalize: Sync {
    /// The native form of an extension whose value is `value`, or none when
    /// it has no native form and the extension is left alone.
    fn normalize(&self, value: &Value) -> Option<Native>;
}

/// An extension in its native form.
pub(super) struct Native {
    /// The native key that replaces the compatibility key.
    pub(super) key: &'static str,
    /// The value in its native form, or none when it is kept as it is.
    pub(super) value: Option<Value>,
    pub(super) change: Change,
}

impl Native {
    /// Only the key renamed to `key`, with the value kept as it is.
    const fn renamed(key: &'static str) -> Native {
        Native {
            key,
            value: None,
            change: Change::plain(),
        }
    }
}

/// A change made by one normalizer.
#[derive(Clone, Copy, Debug)]
pub(super) struct Change {
    pub(super) detail: Option<Detail>,
}

impl Change {
    pub(super) const fn plain() -> Change {
        Change { detail: None }
    }

    pub(super) const fn described(detail: Detail) -> Change {
        Change { detail: Some(detail) }
    }
}

/// An optional explanation of a normalization change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Detail {
    pub(super) one: &'static str,
    pub(super) many: &'static str,
}

impl Detail {
    const fn new(one: &'static str, many: &'static str) -> Detail {
        Detail { one, many }
    }
}

/// A plain rename: the native key, with the value kept as it is.
impl Normalize for &'static str {
    fn normalize(&self, _: &Value) -> Option<Native> {
        Some(Native::renamed(self))
    }
}

/// A group path, with an array of names written as a dotted string when each
/// name reads back as it is.
pub(super) struct Group(pub(super) &'static str);

impl Normalize for Group {
    fn normalize(&self, value: &Value) -> Option<Native> {
        let Some(path) = value.as_array().and_then(|names| dotted(names)) else {
            return Some(Native::renamed(self.0));
        };
        Some(Native {
            key: self.0,
            value: Some(Value::String(path)),
            change: Change::described(Detail::new(
                "group path written as a dotted string",
                "group paths written as dotted strings",
            )),
        })
    }
}

/// A skip that is a boolean, or a list of targets, which has no native form.
pub(super) struct BoolOrTargets(pub(super) &'static str);

impl Normalize for BoolOrTargets {
    fn normalize(&self, value: &Value) -> Option<Native> {
        (!value.is_array()).then(|| Native::renamed(self.0))
    }
}

/// Returns the names of an array joined by dots, if each is a name that a
/// dotted string reads back as it is.
fn dotted(names: &[Value]) -> Option<String> {
    let mut path = String::new();
    for (i, name) in names.iter().enumerate() {
        let name = name.as_str().filter(|name| !name.is_empty() && !name.contains('.'))?;
        if i > 0 {
            path.push('.');
        }
        path.push_str(name);
    }
    Some(path)
}
