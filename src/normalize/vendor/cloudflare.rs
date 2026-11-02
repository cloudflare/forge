//! The adapter for Cloudflare's compatibility extensions.

use super::{Rename, Rule, Source};

pub(super) struct Cloudflare;

static SENSITIVE: Rename = Rename::same("x-forge-sensitive");
static SCHEMA: [Rule; 1] = [("x-sensitive", &SENSITIVE)];

impl Source for Cloudflare {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    fn schema(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
