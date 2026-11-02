//! Tests for the private adapter registry.

use super::*;

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
                table(*source, Level::Definition, source.definitions()),
                table(*source, Level::Parameter, source.parameters()),
                table(*source, Level::Schema, source.schemas()),
            ]
            .concat()
        })
        .collect()
}

fn read(source: &dyn Source, level: Level, key: &str) -> Option<&'static dyn Normalize> {
    match level {
        Level::Definition => source.definition(key),
        Level::Parameter => source.parameter(key),
        Level::Schema => source.schema(key),
    }
}

#[test]
fn a_key_is_read_only_at_its_level() {
    for (source, level, name, _) in tables() {
        for other in [Level::Definition, Level::Parameter, Level::Schema] {
            assert_eq!(
                read(source, other, name).is_some(),
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
    for source in ALL {
        for level in [Level::Definition, Level::Parameter, Level::Schema] {
            for key in match level {
                Level::Definition => source.definitions(),
                Level::Parameter => source.parameters(),
                Level::Schema => source.schemas(),
            } {
                assert!(
                    read(&Sources::ALL, level, key.0).is_some(),
                    "{}: {}",
                    source.name(),
                    key.0
                );
            }
        }
    }
}

#[test]
fn every_rule_becomes_a_native_key() {
    for (_, _, name, normalize) in tables() {
        assert!(
            normalize.native().starts_with("x-forge-"),
            "{name} becomes {}",
            normalize.native()
        );
        assert!(!name.starts_with("x-forge-"), "{name}");
    }
}

#[test]
fn only_the_stainless_skip_may_have_no_native_value() {
    let targets = serde_json::json!(["terraform"]);
    for (_, _, name, normalize) in tables() {
        assert_eq!(
            normalize.normalize(&targets).is_none(),
            name == "x-stainless-skip",
            "{name}"
        );
    }
}

#[test]
fn the_other_extensions_of_these_tools_are_not_read() {
    for key in [
        "x-fern-enum",
        "x-fern-audiences",
        "x-fern-pagination",
        "x-fern-sdk-variables",
        "x-stainless-terraform-configurability",
        "x-stainless-deprecation-message",
        "x-forge-skip",
        "x-forge-method-name",
    ] {
        assert!(Sources::ALL.definition(key).is_none(), "{key}");
        assert!(Sources::ALL.parameter(key).is_none(), "{key}");
        assert!(Sources::ALL.schema(key).is_none(), "{key}");
    }
}
