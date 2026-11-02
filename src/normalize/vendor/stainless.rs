//! The adapter for Stainless's `x-stainless-*` extensions.

use super::{BoolOrTargets, Rule, Source};

pub(super) struct Stainless;

static SKIP: BoolOrTargets = BoolOrTargets("x-forge-skip");
static SCHEMA: [Rule; 1] = [("x-stainless-skip", &SKIP)];

impl Source for Stainless {
    fn name(&self) -> &'static str {
        "stainless"
    }

    fn schemas(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
