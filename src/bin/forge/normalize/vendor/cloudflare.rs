//! The adapter for Cloudflare's compatibility extensions.

use super::{Normalize, Source};

pub(super) struct Cloudflare;

impl Source for Cloudflare {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    fn schema(&self, key: &str) -> Option<&dyn Normalize> {
        match key {
            "x-sensitive" => Some(&"x-forge-sensitive"),
            _ => None,
        }
    }
}
