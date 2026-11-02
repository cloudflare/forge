//! Tests for the private adapter registry.

use super::*;
use crate::normalize::{Options, Sources};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Level {
    Definition,
    Parameter,
    Schema,
}

fn tables() -> Vec<(&'static dyn Source, Level, &'static str, &'static dyn Normalize)> {
    let table = |source: &'static dyn Source, level: Level, table: &'static [Rule]| -> Vec<_> {
        table
            .iter()
            .map(|&(name, normalize)| (source, level, name, normalize))
            .collect()
    };
    ALL.iter()
        .flat_map(|source| {
            [
                table(*source, Level::Definition, source.definition()),
                table(*source, Level::Parameter, source.parameter()),
                table(*source, Level::Schema, source.schema()),
            ]
            .concat()
        })
        .collect()
}

fn read(sources: &Sources, level: Level, key: &str) -> Option<&'static dyn Normalize> {
    match level {
        Level::Definition => sources.definition(key),
        Level::Parameter => sources.parameter(key),
        Level::Schema => sources.schema(key),
    }
}

#[test]
fn a_key_is_read_only_at_its_level() {
    for (source, level, name, _) in tables() {
        let sources = Sources::named(source.name()).unwrap();
        for other in [Level::Definition, Level::Parameter, Level::Schema] {
            assert_eq!(
                read(&sources, other, name).is_some(),
                other == level,
                "{name} at {other:?}"
            );
        }
    }
}

#[test]
fn a_key_is_read_only_when_its_source_is_selected() {
    for (source, level, name, _) in tables() {
        for selected in ALL {
            let sources = Sources::named(selected.name()).unwrap();
            assert_eq!(
                read(&sources, level, name).is_some(),
                selected.name() == source.name(),
                "{name} from {}, with {} selected",
                source.name(),
                selected.name()
            );
        }
    }
}

#[test]
fn every_adapter_is_in_all_sources() {
    let sources = Sources::all();
    for (source, level, name, _) in tables() {
        assert!(read(&sources, level, name).is_some(), "{}: {name}", source.name());
    }
}

#[test]
fn every_rule_writes_a_native_key() {
    for (_, _, original, normalize) in tables() {
        let mut container = serde_json::Map::from_iter([(original.to_owned(), Value::Bool(true))]);

        assert!(
            normalize
                .normalize(&mut container, original, &Options::default())
                .is_some()
        );
        assert!(!container.contains_key(original), "{original}");
        assert!(
            container.keys().all(|key| key.starts_with("x-forge-")),
            "{original}: {container:?}"
        );
    }
}

#[test]
fn only_the_stainless_skip_may_have_no_native_value() {
    for (_, _, original, normalize) in tables() {
        let mut container = serde_json::Map::from_iter([(original.to_owned(), serde_json::json!(["terraform"]))]);

        assert_eq!(
            normalize
                .normalize(&mut container, original, &Options::default())
                .is_none(),
            original == "x-stainless-skip",
            "{original}"
        );
    }
}

#[test]
fn the_other_extensions_of_these_tools_are_not_read() {
    let sources = Sources::all();
    for key in [
        "x-fern-enum",
        "x-fern-pagination",
        "x-fern-sdk-variables",
        "x-stainless-terraform-configurability",
        "x-stainless-deprecation-message",
        "x-forge-skip",
        "x-forge-method-name",
    ] {
        assert!(sources.definition(key).is_none(), "{key}");
        assert!(sources.parameter(key).is_none(), "{key}");
        assert!(sources.schema(key).is_none(), "{key}");
    }
}
