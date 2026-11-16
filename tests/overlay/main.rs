//! Tests for `forge overlay`: applying OpenAPI Overlays (v1.0, v1.1, v1.2)
//! to an OpenAPI document.
//!
//! Spec references:
//! - v1.0: <https://spec.openapis.org/overlay/v1.0.0>
//! - v1.1: <https://spec.openapis.org/overlay/v1.1.0>
//! - v1.2: <https://spec.openapis.org/overlay/v1.2.0>

#![cfg(feature = "cli")]

#[cfg(feature = "cli")]
mod cli;
#[cfg(feature = "cli")]
mod common;
#[cfg(feature = "cli")]
mod compliant_sets;
#[cfg(feature = "cli")]
mod components;
#[cfg(feature = "cli")]
mod copy;
#[cfg(feature = "cli")]
mod oai_conformance;
#[cfg(feature = "cli")]
mod remove;
#[cfg(feature = "cli")]
mod targeting;
#[cfg(feature = "cli")]
mod update;
#[cfg(feature = "cli")]
mod validation;
