//! The adapter for Stainless's `x-stainless-*` extensions.

use super::{Normalize, Source};

pub(super) struct Stainless;

impl Source for Stainless {
    fn name(&self) -> &'static str {
        "stainless"
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            // `x-stainless-skip` is a boolean, or an array of target names,
            // both of which `x-forge-skip` now takes natively. The native
            // array is read as a list of condition names (see RFC 0003),
            // which consumers pin on the CLI.
            "x-stainless-skip" => Some(&"x-forge-skip"),
            _ => None,
        }
    }
}
