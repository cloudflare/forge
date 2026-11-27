//! Tests for `forge openapi` subcommands: today this is the `overlay` verb,
//! which applies OpenAPI Overlays (v1.0, v1.1, v1.2) to an OpenAPI document.
//!
//! Spec references:
//! - v1.0: <https://spec.openapis.org/overlay/v1.0.0>
//! - v1.1: <https://spec.openapis.org/overlay/v1.1.0>
//! - v1.2: <https://spec.openapis.org/overlay/v1.2.0>

#![cfg(feature = "cli")]

mod overlay;

// Re-export the shared helper module at the crate root so the `overlay`
// test submodules can keep using `crate::common::...` after the nest.
pub(crate) use overlay::common;
