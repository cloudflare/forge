//! Tests for `forge normalize`: the keys other tools write, rewritten into the
//! native extensions that say the same things. What the rewrite gets wrong,
//! because a document is read and written again, is in `known_gaps`.

#![cfg(feature = "cli")]

mod known_gaps;
#[cfg(feature = "cli")]
mod normalize_cli;
