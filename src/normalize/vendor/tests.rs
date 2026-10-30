//! The vendor tables. They are here, and not in `tests/normalize/`, as they are
//! of what is private to `normalize`, and name the keys of other tools, which
//! only this module may.

use super::*;

/// A kind of object that has keys of other tools.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Level {
    Definition,
    Parameter,
    Schema,
}

/// Every key of the tables, with the kind of object it is read at.
fn tables() -> Vec<(Source, Level, &'static str, Key)> {
    let table = |source: Source, level: Level, table: &[(&'static str, Key)]| -> Vec<_> {
        table.iter().map(|&(name, key)| (source, level, name, key)).collect()
    };
    [
        table(Source::Cloudflare, Level::Schema, &cloudflare::SCHEMA),
        table(Source::Deprecated, Level::Definition, &deprecated::DEFINITION),
        table(Source::Deprecated, Level::Parameter, &deprecated::PARAMETER),
        table(Source::Deprecated, Level::Schema, &deprecated::SCHEMA),
        table(Source::Fern, Level::Definition, &fern::DEFINITION),
        table(Source::Fern, Level::Parameter, &fern::PARAMETER),
        table(Source::Fern, Level::Schema, &fern::SCHEMA),
        table(Source::Stainless, Level::Schema, &stainless::SCHEMA),
    ]
    .concat()
}

fn read(level: Level, key: &str, sources: Sources) -> Option<Key> {
    match level {
        Level::Definition => definition(key, sources),
        Level::Parameter => parameter(key, sources),
        Level::Schema => schema(key, sources),
    }
}

#[test]
fn a_key_is_read_only_at_its_level() {
    for (_, level, name, _) in tables() {
        for other in [Level::Definition, Level::Parameter, Level::Schema] {
            assert_eq!(
                read(other, name, Sources::ALL).is_some(),
                other == level,
                "{name} at {other:?}"
            );
        }
    }
}

#[test]
fn a_key_is_read_only_when_its_source_is_selected() {
    let sources = [Source::Cloudflare, Source::Deprecated, Source::Fern, Source::Stainless];
    for (source, level, name, _) in tables() {
        for selected in sources {
            assert_eq!(
                read(level, name, Sources::only(selected)).is_some(),
                selected == source,
                "{name} from {source:?}, with {selected:?} selected"
            );
        }
    }
}

#[test]
fn what_a_key_becomes_is_a_native_key_and_no_key_of_another_tool_is_one() {
    for (_, _, name, key) in tables() {
        assert!(key.native.starts_with("x-forge-"), "{name} becomes {}", key.native);
        assert!(!name.starts_with("x-forge-"), "{name}");
    }
}

#[test]
fn only_the_skip_of_a_schema_that_stainless_writes_may_be_a_list_of_targets() {
    for (_, _, name, key) in tables() {
        assert_eq!(key.form == Form::BoolOrTargets, name == "x-stainless-skip", "{name}");
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
        // The native keys, which are not for a rewrite.
        "x-forge-skip",
        "x-forge-method-name",
    ] {
        assert!(definition(key, Sources::ALL).is_none(), "{key}");
        assert!(parameter(key, Sources::ALL).is_none(), "{key}");
        assert!(schema(key, Sources::ALL).is_none(), "{key}");
    }
}
