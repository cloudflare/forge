//! The normalization adapters from compatibility extensions to Forge's native
//! `x-forge-*` vocabulary.
//!
//! Each source owns the rules for every OpenAPI object kind it supports. The
//! walker depends only on [`Source`], so adding an adapter does not require
//! changing its traversal or dispatch.

mod cloudflare;
mod fern;
mod stainless;
#[cfg(test)]
mod tests;

use serde_json::Value;

use super::Sources;

/// The result of normalizing one extension value.
pub(super) struct Replacement {
    /// The value written under the native key.
    pub(super) value: Value,
    /// Whether a group array was joined into a dotted string.
    pub(super) joined: bool,
}

/// Normalizes one compatibility extension.
pub(super) trait Normalize: Sync {
    /// The native key that says the same thing.
    fn native(&self) -> &'static str;

    /// Returns the native value, or none when the compatibility value says
    /// something the native key cannot represent.
    fn normalize(&self, original: &Value) -> Option<Replacement>;
}

/// Copies a value under a different key.
pub(super) struct Rename(pub(super) &'static str);

impl Normalize for Rename {
    fn native(&self) -> &'static str {
        self.0
    }

    fn normalize(&self, original: &Value) -> Option<Replacement> {
        Some(Replacement {
            value: original.clone(),
            joined: false,
        })
    }
}

/// Turns a group path array into its dotted-string form when that is lossless.
pub(super) struct Group(pub(super) &'static str);

impl Normalize for Group {
    fn native(&self) -> &'static str {
        self.0
    }

    fn normalize(&self, original: &Value) -> Option<Replacement> {
        let Value::Array(names) = original else {
            return Some(Replacement {
                value: original.clone(),
                joined: false,
            });
        };
        let Some(value) = dotted(names) else {
            return Some(Replacement {
                value: original.clone(),
                joined: false,
            });
        };
        Some(Replacement {
            value: Value::String(value),
            joined: true,
        })
    }
}

/// Copies a boolean, but leaves a target list alone because the native key
/// cannot represent a skip that applies to only some targets.
pub(super) struct BoolOrTargets(pub(super) &'static str);

impl Normalize for BoolOrTargets {
    fn native(&self) -> &'static str {
        self.0
    }

    fn normalize(&self, original: &Value) -> Option<Replacement> {
        if original.is_array() {
            return None;
        }
        Some(Replacement {
            value: original.clone(),
            joined: false,
        })
    }
}

/// One compatibility key and how it is normalized.
pub(super) type Rule = (&'static str, &'static dyn Normalize);

/// A compatibility source.
pub(super) trait Source: Sync {
    /// The name accepted by `--from`.
    fn name(&self) -> &'static str;

    /// Rules that apply to operations and aliases.
    fn definitions(&self) -> &'static [Rule] {
        &[]
    }

    /// Rules that apply to Parameter Objects.
    fn parameters(&self) -> &'static [Rule] {
        &[]
    }

    /// Rules that apply to Schema Objects.
    fn schemas(&self) -> &'static [Rule] {
        &[]
    }

    fn definition(&self, key: &str) -> Option<&'static dyn Normalize> {
        find(self.definitions(), key)
    }

    fn parameter(&self, key: &str) -> Option<&'static dyn Normalize> {
        find(self.parameters(), key)
    }

    fn schema(&self, key: &str) -> Option<&'static dyn Normalize> {
        find(self.schemas(), key)
    }
}

/// Every available adapter. Its position is the bit used by [`Sources`].
pub(super) static ALL: [&dyn Source; 3] = [&cloudflare::Cloudflare, &fern::Fern, &stainless::Stainless];

impl Source for Sources {
    fn name(&self) -> &'static str {
        "selected sources"
    }

    fn definition(&self, key: &str) -> Option<&'static dyn Normalize> {
        selected(self).find_map(|source| source.definition(key))
    }

    fn parameter(&self, key: &str) -> Option<&'static dyn Normalize> {
        selected(self).find_map(|source| source.parameter(key))
    }

    fn schema(&self, key: &str) -> Option<&'static dyn Normalize> {
        selected(self).find_map(|source| source.schema(key))
    }
}

pub(super) fn named(name: &str) -> Option<usize> {
    ALL.iter().position(|source| source.name() == name)
}

fn selected(sources: &Sources) -> impl Iterator<Item = &'static dyn Source> {
    ALL.iter()
        .enumerate()
        .filter(|(index, _)| sources.contains(*index))
        .map(|(_, source)| *source)
}

fn find(table: &'static [Rule], key: &str) -> Option<&'static dyn Normalize> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, normalize)| *normalize)
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
