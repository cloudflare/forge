//! The adapter for Fern's `x-fern-*` extensions.

use super::{Group, Normalize, Source};

pub(super) struct Fern;

impl Source for Fern {
    fn name(&self) -> &'static str {
        "fern"
    }

    fn path_item(&self, key: &str) -> Option<&dyn Normalize> {
        conditional_filter(key)
    }

    fn definition(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-sdk-method-name" => Some(&"x-forge-method-name"),
            "x-fern-sdk-group-name" => Some(&Group("x-forge-group-name")),
            "x-fern-availability" => Some(&"x-forge-availability"),
            _ => conditional_filter(key),
        }
    }

    fn parameter(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-parameter-name" => Some(&"x-forge-parameter-name"),
            _ => conditional_filter(key),
        }
    }

    fn body(&self, key: &str) -> Option<&dyn Normalize> {
        conditional_filter(key)
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-type-name" => Some(&"x-forge-model-name"),
            "x-fern-property-name" => Some(&"x-forge-property-name"),
            _ => conditional_filter(key),
        }
    }
}

/// Fern's filtering extensions, accepted at every placement where Forge reads
/// `x-forge-skip` and `x-forge-only-for` (RFC 0003).
fn conditional_filter(key: &str) -> Option<&'static dyn Normalize> {
    match key {
        "x-fern-ignore" => Some(&"x-forge-skip"),
        "x-fern-audiences" => Some(&"x-forge-only-for"),
        _ => None,
    }
}
