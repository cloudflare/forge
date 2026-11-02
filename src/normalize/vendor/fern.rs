//! The adapter for Fern's `x-fern-*` extensions.

use super::{Group, Rename, Rule, Source};

pub(super) struct Fern;

static METHOD_NAME: Rename = Rename("x-forge-method-name");
static GROUP_NAME: Group = Group("x-forge-group-name");
static SKIP: Rename = Rename("x-forge-skip");
static AVAILABILITY: Rename = Rename("x-forge-availability");
static PARAMETER_NAME: Rename = Rename("x-forge-parameter-name");
static MODEL_NAME: Rename = Rename("x-forge-model-name");
static PROPERTY_NAME: Rename = Rename("x-forge-property-name");

static DEFINITION: [Rule; 4] = [
    ("x-fern-sdk-method-name", &METHOD_NAME),
    ("x-fern-sdk-group-name", &GROUP_NAME),
    ("x-fern-ignore", &SKIP),
    ("x-fern-availability", &AVAILABILITY),
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

    fn definitions(&self) -> &'static [Rule] {
        &DEFINITION
    }

    fn parameters(&self) -> &'static [Rule] {
        &PARAMETER
    }

    fn schemas(&self) -> &'static [Rule] {
        &SCHEMA
    }
}
