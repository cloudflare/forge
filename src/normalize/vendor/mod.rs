//! The normalization mappings from keys other tools write to the native
//! extensions that say the same thing. The current parser still reads the
//! compatibility keys directly; moving it to native keys is a separate change.
//!
//! Each adapter, [`cloudflare`], [`deprecated`], [`fern`] and [`stainless`], is
//! a table per kind of object that maps its compatibility keys onto native
//! ones, and says whether the value is written as the native key's is.
//!
//! A key has to be in the table of the kind of object `forge` reads its native
//! key at, so that a rewrite does not give a key a meaning it did not have. An
//! extension that says something `forge` has no primitive for is not here.

mod cloudflare;
mod deprecated;
mod fern;
mod stainless;
#[cfg(test)]
mod tests;

use super::{Source, Sources};

/// What a key of another tool becomes.
#[derive(Clone, Copy)]
pub(super) struct Key {
    /// The native key that says the same.
    pub(super) native: &'static str,
    /// How the value is written when it is written as the native key's is.
    pub(super) form: Form,
}

/// How the value of a key is written as the native key's is.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Form {
    /// As it is.
    Same,
    /// A group path: an array of names is the names joined by dots.
    Group,
    /// A boolean, or a list of the targets, which a native key does not say.
    BoolOrTargets,
}

impl Key {
    /// Returns a key whose value is written as the native key's is.
    const fn same(native: &'static str) -> Key {
        Key {
            native,
            form: Form::Same,
        }
    }

    /// Returns a key whose value is a group path.
    const fn group(native: &'static str) -> Key {
        Key {
            native,
            form: Form::Group,
        }
    }

    /// Returns a key whose value is a boolean, or a list of targets.
    const fn bool_or_targets(native: &'static str) -> Key {
        Key {
            native,
            form: Form::BoolOrTargets,
        }
    }
}

/// Returns what `key` becomes on an operation or an alias, if an adapter reads
/// it there.
pub(super) fn definition(key: &str, sources: Sources) -> Option<Key> {
    find(Source::Deprecated, sources, &deprecated::DEFINITION, key)
        .or_else(|| find(Source::Fern, sources, &fern::DEFINITION, key))
}

/// Returns what `key` becomes on a Parameter Object, if an adapter reads it
/// there.
pub(super) fn parameter(key: &str, sources: Sources) -> Option<Key> {
    find(Source::Deprecated, sources, &deprecated::PARAMETER, key)
        .or_else(|| find(Source::Fern, sources, &fern::PARAMETER, key))
}

/// Returns what `key` becomes on a Schema Object, if an adapter reads it there.
pub(super) fn schema(key: &str, sources: Sources) -> Option<Key> {
    find(Source::Deprecated, sources, &deprecated::SCHEMA, key)
        .or_else(|| find(Source::Cloudflare, sources, &cloudflare::SCHEMA, key))
        .or_else(|| find(Source::Fern, sources, &fern::SCHEMA, key))
        .or_else(|| find(Source::Stainless, sources, &stainless::SCHEMA, key))
}

fn find(source: Source, sources: Sources, table: &[(&str, Key)], key: &str) -> Option<Key> {
    if !sources.contains(source) {
        return None;
    }
    table.iter().find(|(name, _)| *name == key).map(|(_, key)| *key)
}
