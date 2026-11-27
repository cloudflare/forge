//! The adapter for Stainless's `x-stainless-*` extensions.

use super::{Normalize, Source};

pub(super) struct Stainless;

impl Source for Stainless {
    fn name(&self) -> &'static str {
        "stainless"
    }

    fn path_item(&self, key: &str) -> Option<&dyn Normalize> {
        skip(key)
    }

    fn definition(&self, key: &str) -> Option<&dyn Normalize> {
        skip(key)
    }

    fn parameter(&self, key: &str) -> Option<&dyn Normalize> {
        skip(key)
    }

    fn body(&self, key: &str) -> Option<&dyn Normalize> {
        skip(key)
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        skip(key)
    }
}

/// `x-stainless-skip` is a boolean, or an array of target names, both of
/// which `x-forge-skip` takes natively at every placement (RFC 0003).
fn skip(key: &str) -> Option<&'static dyn Normalize> {
    match key {
        "x-stainless-skip" => Some(&"x-forge-skip"),
        _ => None,
    }
}
