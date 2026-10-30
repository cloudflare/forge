//! The adapter for Fern's `x-fern-*` extensions.
//!
//! A group path written as one string is split on dots, as for
//! `x-forge-group-name`, which Fern itself does not do: Fern reads a string as a
//! single group. A document written for Fern uses the array, which means the
//! same in both.

use super::Key;

/// The keys of an operation or an alias.
pub(super) const DEFINITION: [(&str, Key); 4] = [
    ("x-fern-sdk-method-name", Key::same("x-forge-method-name")),
    ("x-fern-sdk-group-name", Key::group("x-forge-group-name")),
    ("x-fern-ignore", Key::same("x-forge-skip")),
    ("x-fern-availability", Key::same("x-forge-availability")),
];

/// The keys of a Parameter Object.
pub(super) const PARAMETER: [(&str, Key); 1] = [("x-fern-parameter-name", Key::same("x-forge-parameter-name"))];

/// The keys of a Schema Object.
pub(super) const SCHEMA: [(&str, Key); 2] = [
    ("x-fern-type-name", Key::same("x-forge-model-name")),
    ("x-fern-property-name", Key::same("x-forge-property-name")),
];
