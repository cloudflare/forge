use forge::{Forge, Group, Name};

use crate::common::{group, method, parse, parse_err};

#[test]
fn string_group_name_splits_on_dots() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "accounts.members", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let members = group(&forge, "accounts.members");
    assert_eq!(members.parent(), Some(group(&forge, "accounts")));
}

#[test]
fn group_name_that_is_neither_a_string_nor_an_array_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": 1, "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("a string or an array of strings"), "{err}");
}

#[test]
fn array_group_name_has_a_group_per_element() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": ["accounts", "members"], "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let members = group(&forge, "accounts.members");
    assert_eq!(members.parent(), Some(group(&forge, "accounts")));
}

#[test]
fn array_element_with_a_dot_is_one_group() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": ["zones.settings"], "x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let groups: Vec<Group> = forge.groups().collect();
    let [settings] = groups[..] else {
        panic!("want one group, got {groups:?}");
    };
    assert_eq!(settings.name(), &Name::new("zones.settings"));
    assert_eq!(settings.parent(), None);
}

/// Returns a document with one method, `GET /a`, whose group path is written
/// as `group`.
fn method_in(group: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a": {{"get": {{"x-forge-group-name": {group}, "x-forge-method-name": "get",
            "responses": {{"204": {{"description": "ok"}}}}}}}}}}
        }}"#
    )
}

/// Returns the one group that has a method, where the group path put it.
#[track_caller]
fn group_with_the_method(forge: &Forge) -> Group<'_> {
    let mut groups = forge.groups().filter(|group| group.methods().count() > 0);
    let (Some(group), None) = (groups.next(), groups.next()) else {
        panic!(
            "want one group with methods, got {:?}",
            forge.groups().collect::<Vec<_>>()
        );
    };
    group
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
            group_with_the_method(&forge).path().eq(want.iter()),
            "{written} is not the path {names:?}"
        );
    }
}

#[test]
fn a_dotted_string_and_an_array_with_that_name_are_different_groups() {
    let string = parse(&method_in(r#""zones.settings""#));
    let array = parse(&method_in(r#"["zones.settings"]"#));

    assert_eq!(group_with_the_method(&string).path().count(), 2);
    assert_eq!(group_with_the_method(&array).path().count(), 1);
    assert_eq!(string.groups().count(), 2, "zones and zones.settings");
    assert_eq!(array.groups().count(), 1);
}

#[test]
fn groups_with_equal_names_are_one_group() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "abuse-reports", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": ["abuse_reports"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert_eq!(forge.groups().count(), 1);
    assert_eq!(group(&forge, "abuse_reports").methods().len(), 2);
}

#[test]
fn subgroup_and_method_can_share_a_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"delete": {"x-forge-group-name": "members", "x-forge-method-name": "delete",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"post": {"x-forge-group-name": ["members", "delete"], "x-forge-method-name": "bulk",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    method(&forge, "members.delete");
    method(&forge, "members.delete.bulk");
}

#[test]
fn operation_without_a_group_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn vendor_group_and_method_names_do_not_make_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {
            "x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn empty_group_name_is_no_group() {
    for group in [r#""""#, "[]"] {
        let forge = parse(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-forge-group-name": {group}, "x-forge-method-name": "get",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert_eq!(forge.groups().count(), 0, "{group}");
    }
}

#[test]
fn operation_without_a_method_name_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn empty_method_name_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(forge.groups().count(), 0);
}

#[test]
fn skipped_operation_is_not_a_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-group-name": "a", "x-forge-method-name": "create", "x-forge-skip": true,
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let names: Vec<&Name> = group(&forge, "a").methods().map(|method| method.name()).collect();
    assert_eq!(names, [&Name::new("list")]);
}

#[test]
fn group_name_without_letters_is_an_error() {
    for group in [
        r#"["accounts", "", "members"]"#,
        r#""accounts..members""#,
        r#"".accounts""#,
        r#""accounts.""#,
        r#"".""#,
    ] {
        let err = parse_err(&format!(
            r#"{{
              "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-forge-group-name": {group}, "x-forge-method-name": "list",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        assert!(
            err.contains("GET /a: x-forge-group-name has a group name"),
            "{group}: {err}"
        );
    }
}

#[test]
fn duplicate_method_in_a_group_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
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
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "list_all",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "listAll",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert!(err.contains("GET /a") && err.contains("GET /b"), "{err}");
}

#[test]
fn groups_are_depth_first() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": ["a", "b", "c"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": "x", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/c": {"get": {"x-forge-group-name": ["a", "d"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    // Each group is followed by everything below it, whatever the order of
    // siblings.
    let groups: Vec<Group> = forge.groups().collect();
    assert_eq!(groups.len(), 5);
    for (i, group) in groups.iter().enumerate() {
        let below = group.descendants().count();
        for after in &groups[i + 1..i + 1 + below] {
            assert!(
                iter_parents(*after).any(|parent| parent == *group),
                "{after:?} follows {group:?} but is not below it, in {groups:?}"
            );
        }
    }
}

fn iter_parents(group: Group<'_>) -> impl Iterator<Item = Group<'_>> {
    std::iter::successors(group.parent(), |group| group.parent())
}

#[test]
fn group_description_comes_from_x_forge_commands() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"accounts": {"description": "Accounts."}}
        }"#,
    );

    assert_eq!(group(&forge, "accounts").description(), "Accounts.");
}

#[test]
fn subgroup_description_is_in_its_parents_command() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": ["accounts", "members"], "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"accounts": {"groups": {"members": {"description": "Members."}}}}
        }"#,
    );

    assert_eq!(group(&forge, "accounts.members").description(), "Members.");
}

/// A document with a method in each of `groups`, and `commands` as its
/// `x-forge-commands`.
fn with_commands(groups: &[&str], commands: &str) -> String {
    let paths: Vec<String> = groups
        .iter()
        .enumerate()
        .map(|(i, group)| {
            let group = group
                .split('.')
                .map(|name| format!("{name:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                r#""/{i}": {{"get": {{"x-forge-group-name": [{group}], "x-forge-method-name": "list",
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
fn dotted_group_key_describes_a_subgroup() {
    let forge = parse(&with_commands(
        &["ai.dynamic-routing.deployments", "ai.dynamic-routing"],
        r#"{"ai": {"groups": {
          "dynamic-routing": {"description": "Routes."},
          "dynamic-routing.deployments": {"description": "Deployments."}}}}"#,
    ));

    assert_eq!(group(&forge, "ai.dynamic_routing").description(), "Routes.");
    assert_eq!(
        group(&forge, "ai.dynamic_routing.deployments").description(),
        "Deployments."
    );
}

#[test]
fn dotted_root_key_describes_a_subgroup() {
    let forge = parse(&with_commands(
        &["user.analytics"],
        r#"{"user.analytics": {"description": "Analytics."}}"#,
    ));

    assert_eq!(group(&forge, "user").description(), "");
    assert_eq!(group(&forge, "user.analytics").description(), "Analytics.");
}

#[test]
fn dotted_key_can_come_before_its_parents_entry() {
    let forge = parse(&with_commands(
        &["a.b.c", "a.b", "a"],
        r#"{"a.b.c": {"description": "C."}, "a": {"description": "A.", "groups": {"b": {"description": "B."}}}}"#,
    ));

    assert_eq!(group(&forge, "a").description(), "A.");
    assert_eq!(group(&forge, "a.b").description(), "B.");
    assert_eq!(group(&forge, "a.b.c").description(), "C.");
}

#[test]
fn dotted_and_nested_entries_for_a_group_are_an_error() {
    let err = parse_err(&with_commands(
        &["a.b"],
        r#"{"a": {"groups": {"b": {"description": "One."}}}, "a.b": {"description": "Two."}}"#,
    ));

    assert!(
        err.contains(r#"two entries in x-forge-commands have the name "b""#),
        "{err}"
    );
}

#[test]
fn command_matches_a_group_with_an_equal_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "abuse_reports", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"abuse-reports": {"description": "Abuse reports."}}
        }"#,
    );

    assert_eq!(group(&forge, "abuse_reports").description(), "Abuse reports.");
}

#[test]
fn group_without_a_command_has_no_description() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "accounts", "x-forge-method-name": "list",
            "responses": {"204": {"description": "ok"}}}}},
          "x-forge-commands": {"zones": {"description": "Zones."}}
        }"#,
    );

    assert_eq!(group(&forge, "accounts").description(), "");
    assert_eq!(forge.groups().count(), 1);
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
fn groups_are_sorted_by_name() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "zones", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"get": {"x-forge-group-name": ["accounts", "members"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/c": {"get": {"x-forge-group-name": "dns", "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}},
            "/d": {"get": {"x-forge-group-name": ["accounts", "billing"], "x-forge-method-name": "get",
              "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    let paths: Vec<String> = forge
        .groups()
        .map(|group| group.path().map(Name::snake).collect::<Vec<_>>().join("."))
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
            "get": {"x-forge-group-name": "a", "x-forge-method-name": "list",
              "responses": {"204": {"description": "ok"}}},
            "post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
              "responses": {"204": {"description": "ok"}}},
            "delete": {"x-forge-group-name": "a", "x-forge-method-name": "delete",
              "responses": {"204": {"description": "ok"}}}
          }}
        }"#,
    );

    let names: Vec<String> = group(&forge, "a")
        .methods()
        .map(|method| method.name().snake())
        .collect();
    assert_eq!(names, ["create", "delete", "list"]);
}
