//! The adapter for Stainless's `x-stainless-*` extensions.

use std::borrow::Cow;

use super::{BoolOrTargets, Normalize, Source};

pub(super) struct Stainless;

impl Source for Stainless {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("stainless")
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-stainless-skip" => Some(&BoolOrTargets("x-forge-skip")),
            _ => None,
        }
    }
}
