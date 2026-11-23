//! Tests for the private adapter registry.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Level {
    PathItem,
    Definition,
    Parameter,
    Body,
    Schema,
}

const ALL_LEVELS: &[Level] = &[
    Level::PathItem,
    Level::Definition,
    Level::Parameter,
    Level::Body,
    Level::Schema,
];

/// Every compatibility key, with the source it is from and the levels it is
/// read at.
const KEYS: [(&str, &[Level], &str); 10] = [
    ("cloudflare", &[Level::Schema], "x-sensitive"),
    ("fern", &[Level::Definition], "x-fern-sdk-method-name"),
    ("fern", &[Level::Definition], "x-fern-sdk-group-name"),
    ("fern", ALL_LEVELS, "x-fern-ignore"),
    ("fern", ALL_LEVELS, "x-fern-audiences"),
    ("fern", &[Level::Definition], "x-fern-availability"),
    ("fern", &[Level::Parameter], "x-fern-parameter-name"),
    ("fern", &[Level::Schema], "x-fern-type-name"),
    ("fern", &[Level::Schema], "x-fern-property-name"),
    ("stainless", ALL_LEVELS, "x-stainless-skip"),
];

fn read<'a>(source: &'a dyn Source, level: Level, key: &str) -> Option<&'a dyn Normalize> {
    match level {
        Level::PathItem => source.path_item(key),
        Level::Definition => source.definition(key),
        Level::Parameter => source.parameter(key),
        Level::Body => source.body(key),
        Level::Schema => source.schema(key),
    }
}

/// Reads `key` from every source, as the walk does when all are selected.
fn read_all(level: Level, key: &str) -> Option<&'static dyn Normalize> {
    ALL.iter().find_map(|source| read(*source, level, key))
}

#[test]
fn a_key_is_read_only_at_its_level() {
    for (name, levels, key) in KEYS {
        for &other in ALL_LEVELS {
            assert_eq!(
                read(named(name).unwrap(), other, key).is_some(),
                levels.contains(&other),
                "{key} at {other:?}"
            );
        }
    }
}

#[test]
fn a_key_is_read_only_when_its_source_is_selected() {
    for (name, levels, key) in KEYS {
        for &level in levels {
            for selected in ALL {
                assert_eq!(
                    read(*selected, level, key).is_some(),
                    selected.name() == name,
                    "{key} from {name} at {level:?}, with {} selected",
                    selected.name()
                );
            }
        }
    }
}

#[test]
fn every_adapter_is_in_all_sources() {
    for (name, levels, key) in KEYS {
        for &level in levels {
            assert!(read_all(level, key).is_some(), "{name}: {key} at {level:?}");
        }
    }
}

#[test]
fn every_normalizer_writes_a_native_key() {
    for (_, levels, original) in KEYS {
        for &level in levels {
            let normalizer = read_all(level, original).unwrap();
            let native = normalizer.normalize(&Value::Bool(true));

            assert!(
                native.is_some_and(|native| native.key.starts_with("x-forge-")),
                "{original} at {level:?}"
            );
        }
    }
}

#[test]
fn every_normalizer_writes_a_native_key_for_an_array_too() {
    // Now that `x-forge-skip` takes an array of conditions natively and
    // `x-forge-only-for` takes an array of conditions, every compatibility
    // normalizer rewrites arrays into their native form.
    for (_, levels, original) in KEYS {
        for &level in levels {
            let normalizer = read_all(level, original).unwrap();
            let native = normalizer.normalize(&serde_json::json!(["terraform"]));

            assert!(
                native.is_some_and(|native| native.key.starts_with("x-forge-")),
                "{original} at {level:?}"
            );
        }
    }
}

#[test]
fn the_other_extensions_of_these_tools_are_not_read() {
    for key in [
        "x-fern-enum",
        "x-fern-pagination",
        "x-fern-sdk-variables",
        "x-stainless-terraform-configurability",
        "x-stainless-deprecation-message",
        "x-forge-skip",
        "x-forge-only-for",
        "x-forge-method-name",
    ] {
        for &level in ALL_LEVELS {
            assert!(read_all(level, key).is_none(), "{key} at {level:?}");
        }
    }
}
