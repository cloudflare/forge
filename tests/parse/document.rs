use crate::common::{method, parse, parse_err};

#[test]
fn version_is_the_info_version() {
    let forge = parse(r#"{"openapi": "3.0.3", "info": {"title": "t", "version": "2.1.0"}, "paths": {}}"#);

    assert_eq!(forge.version, "2.1.0");
}

#[test]
fn description_joins_title_summary_and_description() {
    let forge = parse(
        r#"{
          "openapi": "3.1.0",
          "info": {"title": "Example", "summary": "Short.", "description": "Long.", "version": "1"},
          "paths": {}
        }"#,
    );

    assert_eq!(forge.description, "Example\n\nShort.\n\nLong.");
}

#[test]
fn description_leaves_out_missing_parts() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3",
          "info": {"title": "Example", "description": "Long.", "version": "1"},
          "paths": {}
        }"#,
    );

    assert_eq!(forge.description, "Example\n\nLong.");
}

#[test]
fn base_url_is_the_first_server() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "servers": [{"url": "https://a.example.com/v1"}, {"url": "https://b.example.com"}],
          "paths": {}
        }"#,
    );

    assert_eq!(forge.base_url, "https://a.example.com/v1");
}

#[test]
fn base_url_substitutes_server_variables() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "servers": [{
            "url": "https://{region}.example.com/{version}",
            "variables": {"region": {"default": "eu", "enum": ["eu", "us"]}, "version": {"default": "v4"}}
          }],
          "paths": {}
        }"#,
    );

    assert_eq!(forge.base_url, "https://eu.example.com/v4");
}

#[test]
fn base_url_is_empty_without_servers() {
    let forge = parse(r#"{"openapi": "3.0.3", "info": {"title": "t", "version": "1"}, "paths": {}}"#);

    assert_eq!(forge.base_url, "");
}

#[test]
fn undefined_server_variable_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "servers": [{"url": "https://{region}.example.com"}],
          "paths": {}
        }"#,
    );

    assert!(err.contains("region"), "{err}");
}

#[test]
fn unclosed_server_variable_is_an_error() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "servers": [{"url": "https://{region.example.com"}],
          "paths": {}
        }"#,
    );

    assert!(err.contains("https://{region.example.com"), "{err}");
}

#[test]
fn every_version_of_3_0_3_1_and_3_2_is_read() {
    for version in [
        "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.1.0", "3.1.1", "3.1.2", "3.2.0",
    ] {
        let forge = parse(&format!(
            r#"{{
              "openapi": "{version}", "info": {{"title": "t", "version": "1"}},
              "paths": {{"/a": {{"get": {{"x-forge-group-name": "a", "x-forge-method-name": "get",
                "responses": {{"204": {{"description": "ok"}}}}}}}}}}
            }}"#
        ));

        method(&forge, "a.get");
    }
}

#[test]
fn errors_are_reported_together() {
    let err = parse_err(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "servers": [{"url": "https://{region}.example.com"}],
          "paths": {"/a": {"get": {"x-forge-group-name": ["a", "", "b"], "x-forge-method-name": "get",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    assert!(err.contains("region"), "{err}");
    assert!(err.contains("GET /a"), "{err}");
}

#[test]
fn other_versions_are_an_error() {
    for version in ["2.0", "3.3.0", "4.0.0"] {
        let err = parse_err(&format!(
            r#"{{"openapi": "{version}", "info": {{"title": "t", "version": "1"}}, "paths": {{}}}}"#
        ));

        assert!(err.contains(version), "{version}: {err}");
    }
}

#[test]
fn swagger_document_is_an_error() {
    let err = parse_err(r#"{"swagger": "2.0", "info": {"title": "t", "version": "1"}, "paths": {}}"#);

    assert!(err.contains("openapi"), "{err}");
}
