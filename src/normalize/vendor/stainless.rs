//! The adapter for Stainless's `x-stainless-*` extensions.

use super::{Rename, Rule, Source};

pub(super) struct Stainless;

static SKIP: Rename = Rename::bool_or_targets("x-forge-skip");
static SCHEMA: [Rule; 1] = [("x-stainless-skip", &SKIP)];

impl Source for Stainless {
    fn name(&self) -> &'static str {
        "stainless"
    }

    fn schema(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
