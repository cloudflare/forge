use forge::Scalar;

use crate::common::{method, parse, scalar};

#[test]
fn responses_are_the_2xx_sorted_by_status() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "responses": {
              "2XX": {"description": "ok"},
              "201": {"description": "ok"},
              "400": {"description": "no"},
              "200": {"description": "ok"}
            }}}}
        }"#,
    );

    let statuses: Vec<&str> = method(&forge, "a.create")
        .responses()
        .map(|response| response.status())
        .collect();
    assert_eq!(statuses, ["200", "201", "2XX"]);
}

#[test]
fn errors_are_the_rest_sorted_with_default_last() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {
              "default": {"description": "no"},
              "500": {"description": "no"},
              "4XX": {"description": "no"},
              "404": {"description": "no"},
              "200": {"description": "ok"},
              "400": {"description": "no"},
              "304": {"description": "no"}
            }}}}
        }"#,
    );

    let statuses: Vec<&str> = method(&forge, "a.get")
        .errors()
        .map(|response| response.status())
        .collect();
    assert_eq!(statuses, ["304", "400", "404", "4XX", "500", "default"]);
}

#[test]
fn response_has_its_description() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "The pet."}}}}}
        }"#,
    );

    let ok = method(&forge, "a.get").responses().next().unwrap();
    assert_eq!(ok.description(), "The pet.");
}

#[test]
fn response_without_content_has_none() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"delete": {"x-forge-group-name": "a", "x-forge-method-name": "delete",
            "responses": {"204": {"description": "ok"}}}}}
        }"#,
    );

    let ok = method(&forge, "a.delete").responses().next().unwrap();
    assert_eq!(ok.contents().len(), 0);
    assert!(ok.json().is_none());
}

#[test]
fn response_ref_is_followed() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"4XX": {"$ref": "#/components/responses/Failure"}}}}},
          "components": {"responses": {
            "Failure": {"description": "Failed.", "content": {"application/json": {"schema": {"type": "string"}}}}
          }}
        }"##,
    );

    let failure = method(&forge, "a.get").errors().next().unwrap();
    assert_eq!(failure.status(), "4XX");
    assert_eq!(failure.description(), "Failed.");
    assert_eq!(scalar(failure.json().unwrap().ty()), Scalar::String);
}

#[test]
fn response_content_that_is_not_json_is_typed() {
    let forge = parse(
        r#"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "download",
            "responses": {"200": {"description": "ok", "content": {
              "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
              "text/csv": {"schema": {"type": "string"}}
            }}}}}}
        }"#,
    );

    let ok = method(&forge, "a.download").responses().next().unwrap();
    assert!(ok.json().is_none());
    let types: Vec<Scalar> = ok.contents().map(|content| scalar(content.ty())).collect();
    assert_eq!(types, [Scalar::Binary, Scalar::String]);
}
