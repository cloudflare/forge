use forge::{Availability, Forge, HttpMethod, Json, Scalar};

use crate::common::{field_names, group, intersection, method, model, object, parse, parse_err, scalar};

/// Returns a document with one operation, `PATCH /a/{id}/status`, whose own
/// method would be `a.status.edit`, with `x-forge-aliases` written as
/// `aliases` and `fields`, which end with a comma.
fn aliased(aliases: &str, fields: &str) -> String {
    format!(
        r#"{{
          "openapi": "3.0.3", "info": {{"title": "t", "version": "1"}},
          "paths": {{"/a/{{id}}/status": {{"patch": {{{fields}
            "x-fern-sdk-group-name": ["a", "status"], "x-fern-sdk-method-name": "edit",
            "x-forge-aliases": {aliases},
            "summary": "Edit status", "description": "Changes the status.",
            "parameters": [{{"name": "id", "in": "path", "required": true, "schema": {{"type": "string"}}}}],
            "requestBody": {{"content": {{"application/json": {{"schema": {{"type": "object",
              "properties": {{"status": {{"type": "string"}}}}}}}}}}}},
            "responses": {{
              "200": {{"description": "ok", "content": {{"application/json": {{"schema": {{"type": "boolean"}}}}}}}},
              "404": {{"description": "missing"}}
            }}}}}}}}
        }}"#
    )
}

/// Returns every method, as its group path and name joined by dots in
/// snake case, such as `a.pause`, in the order the groups are walked.
fn methods(forge: &Forge) -> Vec<String> {
    let mut paths = Vec::new();
    for group in forge.groups() {
        for method in group.methods() {
            let mut path: Vec<String> = group.path().map(|name| name.snake()).collect();
            path.push(method.name().snake());
            paths.push(path.join("."));
        }
    }
    paths
}

const PAUSE_AND_TERMINATE: &str = r#"[
  {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"},
  {"x-fern-sdk-group-name": ["a"], "x-fern-sdk-method-name": "terminate"}
]"#;

#[test]
fn each_alias_is_a_method_and_the_operation_is_not() {
    let forge = parse(&aliased(PAUSE_AND_TERMINATE, ""));

    assert_eq!(methods(&forge), ["a.pause", "a.terminate"]);
}

#[test]
fn aliases_share_the_rest_of_the_operation() {
    let forge = parse(&aliased(PAUSE_AND_TERMINATE, r#""deprecated": true,"#));

    for path in ["a.pause", "a.terminate"] {
        let m = method(&forge, path);
        assert_eq!(*m.http_method(), HttpMethod::Patch, "{path}");
        assert_eq!(m.path(), "/a/{id}/status", "{path}");
        assert_eq!(m.summary(), "Edit status", "{path}");
        assert_eq!(m.description(), "Changes the status.", "{path}");
        assert!(m.is_deprecated(), "{path}");
        let request = intersection(m.request().unwrap());
        let members: Vec<Vec<&str>> = request.members().map(|ty| field_names(object(ty))).collect();
        assert_eq!(members, [vec!["id"], vec!["status"]], "{path}");
        let statuses: Vec<&str> = m.responses().map(|r| r.status()).collect();
        assert_eq!(statuses, ["200"], "{path}");
        let json = m.responses().next().and_then(|r| r.json()).unwrap();
        assert_eq!(scalar(json.ty()), Scalar::Boolean, "{path}");
        let errors: Vec<&str> = m.errors().map(|r| r.status()).collect();
        assert_eq!(errors, ["404"], "{path}");
    }
}

#[test]
fn each_alias_has_its_own_availability_hidden_confirmation_and_extensions() {
    let forge = parse(&aliased(
        r#"[
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause",
            "x-fern-availability": "generally-available", "x-forge-hidden": true,
            "x-forge-params": {"status": {"default": "pause", "hidden": true}}},
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "terminate",
            "x-fern-availability": "beta", "x-forge-require-confirmation": "Sure?", "x-a": 1, "x-b": 2}
        ]"#,
        "",
    ));

    let pause = method(&forge, "a.pause");
    assert_eq!(pause.availability(), Some(Availability::GenerallyAvailable));
    assert!(pause.is_hidden());
    assert_eq!(pause.confirmation(), None);
    let names: Vec<&str> = pause.extensions().map(|(name, _)| name).collect();
    assert_eq!(names, ["x-forge-params"]);
    let status = pause
        .extension("x-forge-params")
        .and_then(|params| params.get("status"));
    assert_eq!(
        status.and_then(|s| s.get("default")).and_then(Json::as_str),
        Some("pause")
    );

    let terminate = method(&forge, "a.terminate");
    assert_eq!(terminate.availability(), Some(Availability::Beta));
    assert!(!terminate.is_hidden());
    assert_eq!(terminate.confirmation(), Some("Sure?"));
    let extensions: Vec<(&str, &Json)> = terminate.extensions().collect();
    assert_eq!(extensions, [("x-a", &Json::Number(1.0)), ("x-b", &Json::Number(2.0))]);
}

#[test]
fn alias_does_not_fall_back_to_the_operation() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}]"#,
        r#""x-fern-availability": "beta", "x-forge-hidden": true, "x-forge-require-confirmation": "Sure?",
          "x-forge-params": {"status": {}},"#,
    ));

    let pause = method(&forge, "a.pause");
    assert_eq!(pause.availability(), None);
    assert!(!pause.is_hidden());
    assert_eq!(pause.confirmation(), None);
    assert_eq!(pause.extension("x-forge-params"), None);
    assert_eq!(pause.extensions().len(), 0);
}

#[test]
fn alias_without_a_group_or_name_is_not_a_method() {
    let forge = parse(&aliased(
        r#"[
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"},
          {"x-fern-sdk-group-name": "a"},
          {"x-fern-sdk-method-name": "resume"},
          {"x-fern-sdk-group-name": "", "x-fern-sdk-method-name": "restart"}
        ]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.pause"]);
}

#[test]
fn element_that_is_not_an_object_is_ignored() {
    let forge = parse(&aliased(
        r#"["pause", null, 1, true, ["a"], {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.pause"]);
}

#[test]
fn empty_aliases_make_no_method() {
    let forge = parse(&aliased("[]", ""));

    assert_eq!(methods(&forge), Vec::<String>::new());
}

#[test]
fn aliases_that_are_not_an_array_are_an_error() {
    let err = parse_err(&aliased(
        r#"{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}"#,
        "",
    ));

    assert!(err.contains("an array of aliases"), "{err}");
}

#[test]
fn alias_and_another_method_with_equal_names_are_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause",
              "responses": {"204": {"description": "ok"}}}},
            "/b": {"post": {"x-forge-aliases": [
              {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "resume"},
              {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "Pause"}
            ], "responses": {"204": {"description": "ok"}}}}
          }
        }"#,
    );

    assert!(
        err.contains(r#"POST /b: x-forge-aliases[1]: method "pause" is also GET /a"#),
        "{err}"
    );
}

#[test]
fn two_aliases_with_equal_names_are_an_error() {
    let err = parse_err(&aliased(
        r#"[
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"},
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}
        ]"#,
        "",
    ));

    assert!(
        err.contains(r#"x-forge-aliases[1]: method "pause" is also PATCH"#),
        "{err}"
    );
}

#[test]
fn alias_group_name_without_letters_is_an_error_naming_the_alias() {
    let err = parse_err(&aliased(
        r#"[{"x-fern-sdk-group-name": "a..b", "x-fern-sdk-method-name": "pause"}]"#,
        "",
    ));

    assert!(
        err.contains("PATCH /a/{id}/status: x-forge-aliases[0]: x-fern-sdk-group-name"),
        "{err}"
    );
}

#[test]
fn alias_availability_is_checked() {
    let err = parse_err(&aliased(
        r#"[1, {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause", "x-fern-availability": "ga"}]"#,
        "",
    ));

    assert!(
        err.contains(r#"x-forge-aliases[1]: x-fern-availability "ga" is not"#),
        "{err}"
    );
}

#[test]
fn repeated_key_forge_reads_in_an_alias_is_an_error() {
    let err = parse_err(&aliased(
        r#"[{"x-fern-sdk-method-name": "pause", "x-fern-sdk-method-name": "resume"}]"#,
        "",
    ));

    assert!(err.contains("duplicate field `x-fern-sdk-method-name`"), "{err}");
}

#[test]
fn ignored_operation_still_has_its_aliases() {
    let forge = parse(&aliased(PAUSE_AND_TERMINATE, r#""x-fern-ignore": true,"#));

    assert_eq!(methods(&forge), ["a.pause", "a.terminate"]);
}

#[test]
fn ignored_alias_is_not_a_method() {
    let forge = parse(&aliased(
        r#"[
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause", "x-fern-ignore": true},
          {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "terminate", "x-fern-ignore": false}
        ]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.terminate"]);
}

#[test]
fn aliases_are_not_extensions() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause", "x-a": 1,
             "x-forge-aliases": [{"x-fern-sdk-group-name": "b", "x-fern-sdk-method-name": "nested"}]}]"#,
        "",
    ));

    let pause = method(&forge, "a.pause");
    let names: Vec<&str> = pause.extensions().map(|(name, _)| name).collect();
    assert_eq!(names, ["x-a"]);
    assert_eq!(methods(&forge), ["a.pause"]);
}

#[test]
fn keys_of_an_alias_that_are_not_extensions_are_ignored() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause",
             "summary": "Pause", "deprecated": false, "path": "/b"}]"#,
        "",
    ));

    let pause = method(&forge, "a.pause");
    assert_eq!(pause.summary(), "Edit status");
    assert_eq!(pause.path(), "/a/{id}/status");
    assert_eq!(pause.extensions().len(), 0);
}

#[test]
fn operation_without_aliases_keeps_its_own_method() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert_eq!(methods(&forge), ["a.get"]);
}

#[test]
fn model_used_by_aliases_in_two_top_level_groups_is_at_the_top_level() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/m": {"get": {
            "x-fern-sdk-group-name": "a.b", "x-fern-sdk-method-name": "get",
            "x-forge-aliases": [
              {"x-fern-sdk-group-name": "a.b", "x-fern-sdk-method-name": "get"},
              {"x-fern-sdk-group-name": "x", "x-fern-sdk-method-name": "get"}
            ],
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}}},
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model(&forge, "M").group(), None);
    assert_eq!(forge.models().count(), 1);
    assert_eq!(group(&forge, "a.b").models().count(), 0);
}

#[test]
fn model_used_by_aliases_in_one_group_is_in_that_group() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/m": {"get": {
            "x-fern-sdk-group-name": "x", "x-fern-sdk-method-name": "get",
            "x-forge-aliases": [
              {"x-fern-sdk-group-name": "a.b", "x-fern-sdk-method-name": "get"},
              {"x-fern-sdk-group-name": "a.c", "x-fern-sdk-method-name": "get"}
            ],
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}}},
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model(&forge, "M").group(), Some(group(&forge, "a")));
}

#[test]
fn alias_is_named_by_its_operation_id() {
    let forge = parse(&aliased(
        r#"[{"operationId": "a.pause"}, {"operationId": "b.c.resume", "x-a": 1}]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.pause", "b.c.resume"]);
    let resume = method(&forge, "b.c.resume");
    let names: Vec<&str> = resume.extensions().map(|(name, _)| name).collect();
    assert_eq!(names, ["x-a"]);
}

#[test]
fn alias_fern_extensions_win_over_its_operation_id() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause", "operationId": "b.resume"}]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.pause"]);
}

#[test]
fn alias_with_one_fern_extension_falls_back_to_its_operation_id() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "operationId": "b.resume"}]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["b.resume"]);
}

#[test]
fn alias_does_not_take_the_operation_id_of_the_operation() {
    let forge = parse(&aliased(
        r#"[{"x-fern-sdk-group-name": "a"}, {}, {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}]"#,
        r#""operationId": "b.resume","#,
    ));

    assert_eq!(methods(&forge), ["a.pause"]);
}

#[test]
fn alias_operation_id_without_a_dot_is_not_a_method() {
    let forge = parse(&aliased(r#"[{"operationId": "pause"}]"#, ""));

    assert_eq!(methods(&forge), Vec::<String>::new());
}

#[test]
fn ignored_alias_with_an_operation_id_is_not_a_method() {
    let forge = parse(&aliased(
        r#"[{"operationId": "a.pause", "x-fern-ignore": true}, {"operationId": "a.resume"}]"#,
        "",
    ));

    assert_eq!(methods(&forge), ["a.resume"]);
}

#[test]
fn alias_operation_id_name_without_letters_is_an_error_naming_the_alias() {
    let err = parse_err(&aliased(r#"[{"operationId": "a."}, {"operationId": "a..pause"}]"#, ""));

    assert!(
        err.contains(
            "PATCH /a/{id}/status: x-forge-aliases[0]: operationId has a method name with no letters or digits"
        ),
        "{err}"
    );
    assert!(
        err.contains(
            "PATCH /a/{id}/status: x-forge-aliases[1]: operationId has a group name with no letters or digits"
        ),
        "{err}"
    );
}

#[test]
fn alias_operation_id_and_fern_alias_with_equal_names_are_an_error() {
    let err = parse_err(&aliased(
        r#"[{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "pause"}, {"operationId": "a.pause"}]"#,
        "",
    ));

    assert!(
        err.contains(r#"x-forge-aliases[1]: method "pause" is also PATCH"#),
        "{err}"
    );
}

#[test]
fn alias_operation_id_that_is_not_a_string_is_an_error() {
    let err = parse_err(&aliased(r#"[{"operationId": ["a", "pause"]}]"#, ""));

    assert!(err.contains("expected a string"), "{err}");
}
