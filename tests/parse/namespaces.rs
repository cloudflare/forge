use std::borrow::Cow;

use forge::{Err, File, Forge, Name, Namespace, Plugin, run};

use crate::common::{method, namespace, parse, parse_err};

#[test]
fn string_namespace_name_splits_on_dots() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "accounts.members", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let members = namespace(&forge, "accounts.members");
    assert_eq!(members.parent(), Some(namespace(&forge, "accounts")));
}

#[test]
fn deprecated_group_name_is_a_namespace_alias() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "accounts.members", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let members = namespace(&forge, "accounts.members");
    assert_eq!(members.parent(), Some(namespace(&forge, "accounts")));
}

#[test]
#[expect(deprecated, reason = "this test exercises the deprecated Rust aliases")]
fn deprecated_rust_aliases_forward_to_namespaces() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let groups: Vec<forge::Group<'_>> = forge.groups().collect();
    assert_eq!(groups, forge.namespaces().collect::<Vec<_>>());
    assert_eq!(groups[0].methods().next().unwrap().group(), groups[0]);
}

struct LegacyPlugin;

impl Plugin for LegacyPlugin {
    type File = LegacyFile;

    fn generate_group(&self, namespace: Namespace<'_>) -> Result<impl Iterator<Item = Self::File>, Err> {
        Ok(std::iter::once(LegacyFile(namespace.name().kebab())))
    }
}

struct LegacyFile(String);

impl File for LegacyFile {
    fn path(&self) -> &str {
        &self.0
    }

    fn content(&self) -> Result<Cow<'_, [u8]>, Err> {
        Ok(Cow::Borrowed(b"legacy"))
    }
}

#[test]
fn run_calls_a_deprecated_generate_group_implementation() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let files = run(&forge, &LegacyPlugin).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path(), "accounts");
}

#[test]
fn namespace_key_wins_over_deprecated_group_name_in_either_order() {
    for definition in [
        r#""x-forge-group-name": "old", "x-forge-namespace": "new""#,
        r#""x-forge-namespace": "new", "x-forge-group-name": "old""#,
    ] {
        let forge = parse(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{{definition}, "x-forge-method-name": "list",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert_eq!(forge.namespaces().count(), 1);
        namespace(&forge, "new");
    }
}

#[test]
fn namespace_name_that_is_neither_a_string_nor_an_array_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": 1, "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("a string or an array of strings"), "{err}");
}

#[test]
fn array_namespace_name_has_a_namespace_per_element() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": ["accounts", "members"], "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let members = namespace(&forge, "accounts.members");
    assert_eq!(members.parent(), Some(namespace(&forge, "accounts")));
}

#[test]
fn array_element_with_a_dot_is_one_namespace() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": ["zones.settings"], "x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let namespaces: Vec<Namespace> = forge.namespaces().collect();
    let [settings] = namespaces[..] else {
        panic!("want one namespace, got {namespaces:?}");
    };
    assert_eq!(settings.name(), &Name::new("zones.settings"));
    assert_eq!(settings.parent(), None);
}

/// Returns a document with one method, `GET /a`, whose namespace path is written
/// as `namespace`.
fn method_in(namespace: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{"x-forge-namespace": {namespace}, "x-forge-method-name": "get",
            "responses": {{"204": {{"description": "ok"}}}}}}}}}}
        }}"#
    )
}

/// Returns the one namespace that has a method, where the namespace path put it.
#[track_caller]
fn namespace_with_the_method(forge: &Forge) -> Namespace<'_> {
    let mut namespaces = forge.namespaces().filter(|namespace| namespace.methods().count() > 0);
    let (Some(namespace), None) = (namespaces.next(), namespaces.next()) else {
        panic!(
            "want one namespace with methods, got {:?}",
            forge.namespaces().collect::<Vec<_>>()
        );
    };
    namespace
}

/// A string is names separated by dots, and an array is the names, which are
/// not split, so a dot in an array's name stays in it.
#[test]
fn a_dotted_string_is_split_and_a_name_in_an_array_is_not() {
    for (written, names) in [
        (r#""a.b""#, vec!["a", "b"]),
        (r#""a.b.c""#, vec!["a", "b", "c"]),
        (r#"["a", "b"]"#, vec!["a", "b"]),
        (r#"["a.b"]"#, vec!["a.b"]),
        (r#"["a.b", "c"]"#, vec!["a.b", "c"]),
        (r#"["a", "b.c"]"#, vec!["a", "b.c"]),
        (r#"["a.b", "c.d"]"#, vec!["a.b", "c.d"]),
    ] {
        let forge = parse(&method_in(written));

        let want: Vec<Name> = names.iter().map(|name| Name::new(name)).collect();
        assert!(
            namespace_with_the_method(&forge).path().eq(want.iter()),
            "{written} is not the path {names:?}"
        );
    }
}

#[test]
fn a_dotted_string_and_an_array_with_that_name_are_different_namespaces() {
    let string = parse(&method_in(r#""zones.settings""#));
    let array = parse(&method_in(r#"["zones.settings"]"#));

    assert_eq!(namespace_with_the_method(&string).path().count(), 2);
    assert_eq!(namespace_with_the_method(&array).path().count(), 1);
    assert_eq!(string.namespaces().count(), 2, "zones and zones.settings");
    assert_eq!(array.namespaces().count(), 1);
}

#[test]
fn namespaces_with_equal_names_are_one_namespace() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-namespace": "abuse-reports", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-namespace": ["abuse_reports"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert_eq!(forge.namespaces().count(), 1);
    assert_eq!(namespace(&forge, "abuse_reports").methods().len(), 2);
}

#[test]
fn subnamespace_and_method_can_share_a_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"delete": {"x-forge-namespace": "members", "x-forge-method-name": "delete",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"post": {"x-forge-namespace": ["members", "delete"], "x-forge-method-name": "bulk",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    method(&forge, "members.delete");
    method(&forge, "members.delete.bulk");
}

#[test]
fn operation_without_a_namespace_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.namespaces().count(), 0);
}

#[test]
fn vendor_namespace_and_method_names_do_not_make_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {
            "x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.namespaces().count(), 0);
}

#[test]
fn empty_namespace_name_is_no_namespace() {
    for namespace in [r#""""#, "[]"] {
        let forge = parse(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-forge-namespace": {namespace}, "x-forge-method-name": "get",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert_eq!(forge.namespaces().count(), 0, "{namespace}");
    }
}

#[test]
fn operation_without_a_method_name_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "a",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.namespaces().count(), 0);
}

#[test]
fn empty_method_name_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "a", "x-forge-method-name": "",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.namespaces().count(), 0);
}

#[test]
fn skipped_operation_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-namespace": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-namespace": "a", "x-forge-method-name": "create", "x-forge-skip": true,
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let names: Vec<&Name> = namespace(&forge, "a").methods().map(|method| method.name()).collect();
    assert_eq!(names, [&Name::new("list")]);
}

#[test]
fn namespace_name_without_letters_is_an_error() {
    for namespace in [
        r#"["accounts", "", "members"]"#,
        r#""accounts..members""#,
        r#"".accounts""#,
        r#""accounts.""#,
        r#"".""#,
    ] {
        let err = parse_err(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-forge-namespace": {namespace}, "x-forge-method-name": "list",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert!(
            err.contains("GET /a: x-forge-namespace has a namespace name"),
            "{namespace}: {err}"
        );
    }
}

#[test]
fn duplicate_method_in_a_namespace_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-namespace": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-namespace": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert!(err.contains("GET /a") && err.contains("GET /b"), "{err}");
}

#[test]
fn method_names_are_equal_as_names() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-namespace": "a", "x-forge-method-name": "list_all",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-namespace": "a", "x-forge-method-name": "listAll",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert!(err.contains("GET /a") && err.contains("GET /b"), "{err}");
}

#[test]
fn namespaces_are_depth_first() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-namespace": ["a", "b", "c"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-namespace": "x", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/c": {"get": {"x-forge-namespace": ["a", "d"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    // Each namespace is followed by everything below it, whatever the order of
    // siblings.
    let namespaces: Vec<Namespace> = forge.namespaces().collect();
    assert_eq!(namespaces.len(), 5);
    for (i, namespace) in namespaces.iter().enumerate() {
        let below = namespace.descendants().count();
        for after in &namespaces[i + 1..i + 1 + below] {
            assert!(
                iter_parents(*after).any(|parent| parent == *namespace),
                "{after:?} follows {namespace:?} but is not below it, in {namespaces:?}"
            );
        }
    }
}

fn iter_parents(namespace: Namespace<'_>) -> impl Iterator<Item = Namespace<'_>> {
    std::iter::successors(namespace.parent(), |namespace| namespace.parent())
}

#[test]
fn namespace_description_comes_from_x_forge_commands() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"accounts": {"description": "Accounts."}}
        }"#,
    );

    assert_eq!(namespace(&forge, "accounts").description(), "Accounts.");
}

#[test]
fn subnamespace_description_is_in_its_parents_command() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": ["accounts", "members"], "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"accounts": {"namespaces": {"members": {"description": "Members."}}}}
        }"#,
    );

    assert_eq!(namespace(&forge, "accounts.members").description(), "Members.");
}

#[test]
fn deprecated_groups_key_describes_a_subnamespace() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": ["accounts", "members"], "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"accounts": {"groups": {"members": {"description": "Members."}}}}
        }"#,
    );

    assert_eq!(namespace(&forge, "accounts.members").description(), "Members.");
}

/// A document with a method in each of `namespaces`, and `commands` as its
/// `x-forge-commands`.
fn with_commands(namespaces: &[&str], commands: &str) -> String {
    let paths: Vec<String> = namespaces
        .iter()
        .enumerate()
        .map(|(i, namespace)| {
            let namespace = namespace
                .split('.')
                .map(|name| format!("{name:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                r#""/{i}": {{"get": {{"x-forge-namespace": [{namespace}], "x-forge-method-name": "list",
                  "responses": {{"204": {{"description": "ok"}}}}}}}}"#
            )
        })
        .collect();
    format!(
        r#"{{"openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{{}}}, "x-forge-commands": {commands}}}"#,
        paths.join(", ")
    )
}

#[test]
fn dotted_namespace_key_describes_a_subnamespace() {
    let forge = parse(&with_commands(
        &["ai.dynamic-routing.deployments", "ai.dynamic-routing"],
        r#"{"ai": {"namespaces": {
          "dynamic-routing": {"description": "Routes."},
          "dynamic-routing.deployments": {"description": "Deployments."}}}}"#,
    ));

    assert_eq!(namespace(&forge, "ai.dynamic_routing").description(), "Routes.");
    assert_eq!(
        namespace(&forge, "ai.dynamic_routing.deployments").description(),
        "Deployments."
    );
}

#[test]
fn dotted_root_key_describes_a_subnamespace() {
    let forge = parse(&with_commands(
        &["user.analytics"],
        r#"{"user.analytics": {"description": "Analytics."}}"#,
    ));

    assert_eq!(namespace(&forge, "user").description(), "");
    assert_eq!(namespace(&forge, "user.analytics").description(), "Analytics.");
}

#[test]
fn dotted_key_can_come_before_its_parents_entry() {
    let forge = parse(&with_commands(
        &["a.b.c", "a.b", "a"],
        r#"{"a.b.c": {"description": "C."}, "a": {"description": "A.", "namespaces": {"b": {"description": "B."}}}}"#,
    ));

    assert_eq!(namespace(&forge, "a").description(), "A.");
    assert_eq!(namespace(&forge, "a.b").description(), "B.");
    assert_eq!(namespace(&forge, "a.b.c").description(), "C.");
}

#[test]
fn dotted_and_nested_entries_for_a_namespace_are_an_error() {
    let err = parse_err(&with_commands(
        &["a.b"],
        r#"{"a": {"namespaces": {"b": {"description": "One."}}}, "a.b": {"description": "Two."}}"#,
    ));

    assert!(
        err.contains(r#"two entries in x-forge-commands have the name "b""#),
        "{err}"
    );
}

#[test]
fn command_matches_a_namespace_with_an_equal_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "abuse_reports", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"abuse-reports": {"description": "Abuse reports."}}
        }"#,
    );

    assert_eq!(namespace(&forge, "abuse_reports").description(), "Abuse reports.");
}

#[test]
fn namespace_without_a_command_has_no_description() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-namespace": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"zones": {"description": "Zones."}}
        }"#,
    );

    assert_eq!(namespace(&forge, "accounts").description(), "");
    assert_eq!(forge.namespaces().count(), 1);
}

#[test]
fn commands_with_equal_names_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {},
          "x-forge-commands": {"abuse-reports": {"description": "One."}, "abuse_reports": {"description": "Two."}}
        }"#,
    );

    assert!(err.contains("x-forge-commands"), "{err}");
}

#[test]
fn namespaces_are_sorted_by_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-namespace": "zones", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-namespace": ["accounts", "members"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/c": {"get": {"x-forge-namespace": "dns", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/d": {"get": {"x-forge-namespace": ["accounts", "billing"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    let paths: Vec<String> = forge
        .namespaces()
        .map(|namespace| namespace.path().map(Name::snake).collect::<Vec<_>>().join("."))
        .collect();
    assert_eq!(
        paths,
        ["accounts", "accounts.billing", "accounts.members", "dns", "zones"]
    );
}

#[test]
fn methods_are_sorted_by_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-namespace": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-namespace": "a", "x-forge-method-name": "create",
              "responses": {"204": {"description": "ok"}}},
            "delete": {"x-forge-namespace": "a", "x-forge-method-name": "delete",
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let names: Vec<String> = namespace(&forge, "a")
        .methods()
        .map(|method| method.name().snake())
        .collect();
    assert_eq!(names, ["create", "delete", "list"]);
}
