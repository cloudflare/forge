//! Tests for `forge openapi overlay`: applying OpenAPI Overlays (v1.0, v1.1,
//! v1.2) to an OpenAPI document.
//!
//! Spec references:
//! - v1.0: <https://spec.openapis.org/overlay/v1.0.0>
//! - v1.1: <https://spec.openapis.org/overlay/v1.1.0>
//! - v1.2: <https://spec.openapis.org/overlay/v1.2.0>

mod cli;
pub mod common;
mod compliant_sets;
mod components;
mod copy;
mod logging;
mod oai_conformance;
mod real_world;
mod remove;
mod targeting;
mod update;
mod validation;
