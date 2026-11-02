//! The adapter for Fern's `x-fern-*` extensions.

use super::{Rename, Rule, Source};

pub(super) struct Fern;

static METHOD_NAME: Rename = Rename::same("x-forge-method-name");
static GROUP_NAME: Rename = Rename::group("x-forge-group-name");
static SKIP: Rename = Rename::same("x-forge-skip");
static AVAILABILITY: Rename = Rename::same("x-forge-availability");
static AUDIENCES: Rename = Rename::same("x-forge-audiences");
static PARAMETER_NAME: Rename = Rename::same("x-forge-parameter-name");
static MODEL_NAME: Rename = Rename::same("x-forge-model-name");
static PROPERTY_NAME: Rename = Rename::same("x-forge-property-name");

static DEFINITION: [Rule; 5] = [
    ("x-fern-sdk-method-name", &METHOD_NAME),
    ("x-fern-sdk-group-name", &GROUP_NAME),
    ("x-fern-ignore", &SKIP),
    ("x-fern-availability", &AVAILABILITY),
    ("x-fern-audiences", &AUDIENCES),
];
static PARAMETER: [Rule; 1] = [("x-fern-parameter-name", &PARAMETER_NAME)];
static SCHEMA: [Rule; 2] = [
    ("x-fern-type-name", &MODEL_NAME),
    ("x-fern-property-name", &PROPERTY_NAME),
];

impl Source for Fern {
    fn name(&self) -> &'static str {
        "fern"
    }

    fn definition(&self) -> &'static [Rule] {
        &DEFINITION
    }

    fn parameter(&self) -> &'static [Rule] {
        &PARAMETER
    }

    fn schema(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
