//! The adapter for Cloudflare's compatibility extensions.

use super::Key;

/// The keys of a Schema Object.
pub(super) const SCHEMA: [(&str, Key); 1] = [("x-sensitive", Key::same("x-forge-sensitive"))];
