//! Tests for the private adapter registry.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Level {
    Definition,
    Parameter,
    Schema,
}

/// Every compatibility key, with the source it is from and the level it is
/// read at.
const KEYS: [(&str, Level, &str); 9] = [
    ("cloudflare", Level::Schema, "x-sensitive"),
    ("fern", Level::Definition, "x-fern-sdk-method-name"),
    ("fern", Level::Definition, "x-fern-sdk-group-name"),
    ("fern", Level::Definition, "x-fern-ignore"),
    ("fern", Level::Definition, "x-fern-availability"),
    ("fern", Level::Parameter, "x-fern-parameter-name"),
    ("fern", Level::Schema, "x-fern-type-name"),
    ("fern", Level::Schema, "x-fern-property-name"),
    ("stainless", Level::Schema, "x-stainless-skip"),
];

fn read<'a>(source: &'a dyn Source, level: Level, key: &str) -> Option<&'a dyn Normalize> {
    match level {
        Level::Definition => source.definition(key),
        Level::Parameter => source.parameter(key),
        Level::Schema => source.schema(key),
    }
}

/// Reads `key` from every source, as the walk does when all are selected.
fn read_all(level: Level, key: &str) -> Option<&'static dyn Normalize> {
    ALL.iter().find_map(|source| read(*source, level, key))
}

#[test]
fn a_key_is_read_only_at_its_level() {
    for (name, level, key) in KEYS {
        for other in [Level::Definition, Level::Parameter, Level::Schema] {
            assert_eq!(
                read(named(name).unwrap(), other, key).is_some(),
                other == level,
                "{key} at {other:?}"
            );
        }
    }
}

#[test]
fn a_key_is_read_only_when_its_source_is_selected() {
    for (name, level, key) in KEYS {
        for selected in ALL {
            assert_eq!(
                read(*selected, level, key).is_some(),
                selected.name() == name,
                "{key} from {name}, with {} selected",
                selected.name()
            );
        }
    }
}

#[test]
fn every_adapter_is_in_all_sources() {
    for (name, level, key) in KEYS {
        assert!(read_all(level, key).is_some(), "{name}: {key}");
    }
}

#[test]
fn every_normalizer_writes_a_native_key() {
    for (_, level, original) in KEYS {
        let normalizer = read_all(level, original).unwrap();
        let native = normalizer.normalize(&Value::Bool(true));

        assert!(
            native.is_some_and(|native| native.key.starts_with("x-forge-")),
            "{original}"
        );
    }
}

#[test]
fn only_the_stainless_skip_may_have_no_native_value() {
    for (_, level, original) in KEYS {
        let normalizer = read_all(level, original).unwrap();

        assert_eq!(
            normalizer.normalize(&serde_json::json!(["terraform"])).is_none(),
            original == "x-stainless-skip",
            "{original}"
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
        for level in [Level::Definition, Level::Parameter, Level::Schema] {
            assert!(read_all(level, key).is_none(), "{key} at {level:?}");
        }
    }
}
