//! The adapter for Stainless's `x-stainless-*` extensions.
//!
//! `x-stainless-skip` may be a list of the targets to skip a property for,
//! which a native skip, that is for every target, does not say.

use super::Key;

/// The keys of a Schema Object.
pub(super) const SCHEMA: [(&str, Key); 1] = [("x-stainless-skip", Key::bool_or_targets("x-forge-skip"))];
