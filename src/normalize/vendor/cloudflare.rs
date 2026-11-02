//! The adapter for Cloudflare's compatibility extensions.

use super::{Rename, Rule, Source};

pub(super) struct Cloudflare;

static SENSITIVE: Rename = Rename("x-forge-sensitive");
static SCHEMA: [Rule; 1] = [("x-sensitive", &SENSITIVE)];

impl Source for Cloudflare {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    fn schemas(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
