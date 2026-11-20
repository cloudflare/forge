//! The adapter for Fern's `x-fern-*` extensions.

use super::{Group, Normalize, Source};

pub(super) struct Fern;

impl Source for Fern {
    fn name(&self) -> &'static str {
        "fern"
    }

    fn definition(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-sdk-method-name" => Some(&"x-forge-method-name"),
            "x-fern-sdk-group-name" => Some(&Group("x-forge-group-name")),
            "x-fern-ignore" => Some(&"x-forge-skip"),
            "x-fern-availability" => Some(&"x-forge-availability"),
            _ => None,
        }
    }

    fn parameter(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-parameter-name" => Some(&"x-forge-parameter-name"),
            _ => None,
        }
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-fern-type-name" => Some(&"x-forge-model-name"),
            "x-fern-property-name" => Some(&"x-forge-property-name"),
            _ => None,
        }
    }
}
