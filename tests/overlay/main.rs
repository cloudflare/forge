//! Tests for `forge overlay`: applying OpenAPI Overlays (v1.0.0) to an
//! OpenAPI document.
//!
//! The rules under test come from the Overlay specification at
//! <https://spec.openapis.org/overlay/v1.0.0.html>.

#![cfg(feature = "cli")]

#[cfg(feature = "cli")]
mod cli;
#[cfg(feature = "cli")]
mod common;
#[cfg(feature = "cli")]
mod compliant_sets;
#[cfg(feature = "cli")]
mod remove;
#[cfg(feature = "cli")]
mod targeting;
#[cfg(feature = "cli")]
mod update;
#[cfg(feature = "cli")]
mod validation;
