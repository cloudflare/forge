//! Compatibility-source adapters for [`super::normalize`].
//!
//! A [`Source`] names the normalizers that apply to operations, parameters,
//! and schemas. A key is listed only at the OpenAPI object kind where Forge
//! reads its native replacement; elsewhere it is left alone. [`Normalize`]
//! owns the complete mutation for one compatibility key, so a future
//! normalizer is not required to be a one-to-one rename.
//!
//! To add a compatibility source, implement [`Source`] in a module here and
//! add its value to [`ALL`]. To add a key to an existing source, add its
//! [`Rule`] to the applicable table. Normalization introduces no new Forge
//! semantics: the corresponding native key must already exist.

mod cloudflare;
mod fern;
mod stainless;
#[cfg(test)]
mod tests;

use serde_json::{Map, Value};

use super::{Change, Detail, Options};

/// One compatibility key and the normalizer that owns it.
pub(super) type Rule = (&'static str, &'static dyn Normalize);

/// A source of compatibility extensions.
pub(super) trait Source: Sync {
    /// The name accepted by `--from`.
    fn name(&self) -> &'static str;

    /// Normalizers for operations and aliases.
    fn definition(&self) -> &'static [Rule] {
        &[]
    }

    /// Normalizers for Parameter Objects.
    fn parameter(&self) -> &'static [Rule] {
        &[]
    }

    /// Normalizers for Schema Objects.
    fn schema(&self) -> &'static [Rule] {
        &[]
    }
}

/// Normalizes one compatibility extension in its containing object.
pub(super) trait Normalize: Sync {
    /// Returns the change that was made, or none when this value has no native
    /// representation and the object is left alone.
    fn normalize(&self, container: &mut Map<String, Value>, original: &str, options: &Options) -> Option<Change>;
}

/// Renames one extension to its native equivalent.
///
/// Every current compatibility rule is a rename, with one of the value forms
/// below. A future rule that restructures an object can implement [`Normalize`]
/// directly instead.
pub(super) struct Rename {
    native: &'static str,
    form: Form,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Same,
    Namespace,
    BoolOrTargets,
}

impl Rename {
    pub(super) const fn same(native: &'static str) -> Rename {
        Rename {
            native,
            form: Form::Same,
        }
    }

    pub(super) const fn namespace(native: &'static str) -> Rename {
        Rename {
            native,
            form: Form::Namespace,
        }
    }

    pub(super) const fn bool_or_targets(native: &'static str) -> Rename {
        Rename {
            native,
            form: Form::BoolOrTargets,
        }
    }

    fn supports(self: &Rename, value: &Value) -> bool {
        self.form != Form::BoolOrTargets || !value.is_array()
    }

    fn value(self: &Rename, value: Value) -> (Value, Option<Detail>) {
        let Form::Namespace = self.form else {
            return (value, None);
        };
        let Value::Array(names) = &value else {
            return (value, None);
        };
        let Some(path) = dotted(names) else {
            return (value, None);
        };
        (
            Value::String(path),
            Some(Detail::new(
                "namespace path written as a dotted string",
                "namespace paths written as dotted strings",
            )),
        )
    }
}

impl Normalize for Rename {
    fn normalize(&self, container: &mut Map<String, Value>, original: &str, options: &Options) -> Option<Change> {
        let value = container.get(original)?;
        if !self.supports(value) {
            return None;
        }

        // The native value wins when both are present. Keeping compatibility
        // keys makes this object already normalized; otherwise the old key is
        // removed without touching the native one.
        if container.contains_key(self.native) {
            if options.leave_old_extensions {
                return None;
            }
            container.shift_remove(original);
            return Some(Change::plain());
        }

        let at = container
            .keys()
            .position(|key| key == original)
            .expect("the compatibility key was found in its container");
        let original_value = if options.leave_old_extensions {
            value.clone()
        } else {
            container
                .shift_remove(original)
                .expect("the compatibility key was found in its container")
        };
        let (native_value, detail) = self.value(original_value);
        container.shift_insert(at, self.native.to_owned(), native_value);
        Some(match detail {
            Some(detail) => Change::described(detail),
            None => Change::plain(),
        })
    }
}

/// Every available compatibility source.
pub(super) static ALL: [&dyn Source; 3] = [&cloudflare::Cloudflare, &fern::Fern, &stainless::Stainless];

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
