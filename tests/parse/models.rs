use forge::{Name, Scalar};

use crate::common::{
    field, group, method, model, model_of, models, object, parse, responding_with_schemas, response_type, scalar,
};

#[test]
fn response_model_is_placed_in_its_group() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3",
          "info": { "title": "Example", "version": "1.0.0" },
          "paths": {
            "/zones": {
              "get": {
                "x-forge-group-name": "zones",
                "x-forge-method-name": "list",
                "responses": {
                  "200": {
                    "description": "OK",
                    "content": {
                      "application/json": { "schema": { "$ref": "#/components/schemas/Zone" } }
                    }
                  }
                }
              }
            }
          },
          "components": {
            "schemas": {
              "Zone": { "type": "object", "properties": { "id": { "type": "string" } } }
            }
          }
        }"##,
    );

    assert_eq!(model(&forge, "Zone").group(), Some(group(&forge, "zones")));
}

#[test]
fn model_used_in_sibling_groups_is_in_their_parent() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/c": {"get": {"x-forge-group-name": ["a", "b", "c"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}},
            "/d": {"get": {"x-forge-group-name": ["a", "b", "d"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}}
          },
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model(&forge, "M").group(), Some(group(&forge, "a.b")));
}

#[test]
fn model_used_in_a_group_and_its_subgroup_is_in_the_group() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}},
            "/c": {"get": {"x-forge-group-name": ["a", "b", "c"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}}
          },
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model(&forge, "M").group(), Some(group(&forge, "a")));
}

#[test]
fn model_used_in_top_level_groups_is_at_the_top_level() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}},
            "/x": {"get": {"x-forge-group-name": "x", "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}}
          },
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    let m = model(&forge, "M");
    assert_eq!(m.group(), None);
    assert_eq!(forge.models().collect::<Vec<_>>(), [m]);
}

#[test]
fn model_used_through_another_model_is_placed_by_every_use() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/b": {"get": {"x-forge-group-name": ["a", "b"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Outer"}}}}}}},
            "/c": {"get": {"x-forge-group-name": ["a", "c"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Inner"}}}}}}}
          },
          "components": {"schemas": {
            "Outer": {"type": "object", "properties": {"inner": {"$ref": "#/components/schemas/Inner"}}},
            "Inner": {"type": "object", "properties": {"id": {"type": "string"}}}
          }}
        }"##,
    );

    assert_eq!(model(&forge, "Outer").group(), Some(group(&forge, "a.b")));
    assert_eq!(model(&forge, "Inner").group(), Some(group(&forge, "a")));
}

#[test]
fn params_bodies_and_errors_use_models() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": "a", "x-forge-method-name": "create",
            "parameters": [{"name": "filter", "in": "query", "schema": {"$ref": "#/components/schemas/Filter"}}],
            "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Input"}}}},
            "responses": {"400": {"description": "no", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Failure"}}}}}}}},
          "components": {"schemas": {
            "Filter": {"type": "string"},
            "Input": {"type": "object", "properties": {"name": {"type": "string"}}},
            "Failure": {"type": "object", "properties": {"message": {"type": "string"}}}
          }}
        }"##,
    );

    let a = group(&forge, "a");
    for name in ["Filter", "Input", "Failure"] {
        assert_eq!(model(&forge, name).group(), Some(a), "{name}");
    }
}

#[test]
fn schema_no_method_uses_is_not_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Used"}}}}}}},
            "/skipped": {"get": {"x-forge-group-name": ["a"], "x-forge-method-name": "skipped", "x-forge-skip": true,
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Skipped"}}}}}}},
            "/ungrouped": {"get": {"x-forge-method-name": "ungrouped",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Ungrouped"}}}}}}}
          },
          "components": {"schemas": {
            "Used": {"type": "string"},
            "Skipped": {"type": "string"},
            "Ungrouped": {"type": "string"},
            "Unused": {"type": "string"}
          }}
        }"##,
    );

    assert_eq!(models(&forge), ["Used"]);
}

#[test]
fn model_can_refer_to_itself() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Node"}"##,
        r##"{"Node": {"type": "object", "properties": {"next": {"$ref": "#/components/schemas/Node"}}}}"##,
    ));

    let node = model(&forge, "Node");
    assert_eq!(model_of(field(object(node.ty()), "next").ty()), node);
    assert_eq!(node.group(), Some(group(&forge, "a")));
}

#[test]
fn model_is_named_after_its_schema() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/zone_settings"}"##,
        r#"{"zone_settings": {"type": "string"}}"#,
    ));

    assert_eq!(model(&forge, "zone_settings").name(), &Name::new("zone_settings"));
}

#[test]
fn model_is_named_by_x_forge_model_name() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/not_found"}"##,
        r#"{"not_found": {"type": "object", "x-forge-model-name": "Missing"}}"#,
    ));

    assert_eq!(model(&forge, "not_found").name(), &Name::new("Missing"));
}

#[test]
fn vendor_model_name_is_not_read() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/not_found"}"##,
        r#"{"not_found": {"type": "object", "x-fern-type-name": "Missing"}}"#,
    ));

    assert_eq!(model(&forge, "not_found").name(), &Name::new("not_found"));
}

#[test]
fn model_description_is_its_description_or_else_title() {
    let forge = parse(&responding_with_schemas(
        r##"{"anyOf": [{"$ref": "#/components/schemas/Described"}, {"$ref": "#/components/schemas/Titled"}]}"##,
        r#"{
          "Described": {"type": "string", "title": "Title.", "description": "Description."},
          "Titled": {"type": "integer", "title": "Title."}
        }"#,
    ));

    assert_eq!(model(&forge, "Described").description(), "Description.");
    assert_eq!(model(&forge, "Titled").description(), "Title.");
}

#[test]
fn model_can_be_deprecated() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Old"}"##,
        r#"{"Old": {"type": "string", "deprecated": true}}"#,
    ));

    assert!(model(&forge, "Old").is_deprecated());
}

#[test]
fn schema_in_defs_is_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.1.0", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Tree/$defs/Node"}}}}}}}},
          "components": {"schemas": {
            "Tree": {"type": "object", "$defs": {"Node": {"type": "string"}}}
          }}
        }"##,
    );

    let node = model_of(response_type(&forge, "a.get"));
    assert_eq!(node.schema_name(), "Tree/$defs/Node");
    assert_eq!(node.name(), &Name::new("Tree Node"));
    assert_eq!(models(&forge), ["Tree/$defs/Node"]);
}

#[test]
fn model_that_is_a_ref_is_the_other_model() {
    let forge = parse(&responding_with_schemas(
        r##"{"$ref": "#/components/schemas/Alias"}"##,
        r##"{"Alias": {"$ref": "#/components/schemas/Base"}, "Base": {"type": "string"}}"##,
    ));

    let base = model_of(model(&forge, "Alias").ty());
    assert_eq!(base.schema_name(), "Base");
    assert_eq!(scalar(base.ty()), Scalar::String);
    assert_eq!(base.group(), Some(group(&forge, "a")));
}

#[test]
fn schema_used_only_by_content_that_is_not_json_is_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"post": {"x-forge-group-name": ["a", "files"], "x-forge-method-name": "upload",
            "requestBody": {"content": {"multipart/form-data": {"schema": {"$ref": "#/components/schemas/Upload"}}}},
            "responses": {"200": {"description": "ok", "content": {"text/csv": {"schema": {"$ref": "#/components/schemas/Report"}}}}}}}},
          "components": {"schemas": {
            "Upload": {"type": "object", "properties": {"file": {"type": "string", "format": "binary"}}},
            "Report": {"type": "string"}
          }}
        }"##,
    );

    assert_eq!(models(&forge), ["Report", "Upload"]);
    let files = group(&forge, "a.files");
    assert_eq!(model(&forge, "Upload").group(), Some(files));
    assert_eq!(model(&forge, "Report").group(), Some(files));
    let upload = method(&forge, "a.files.upload")
        .body()
        .unwrap()
        .contents()
        .next()
        .unwrap();
    let upload = model_of(upload.ty());
    assert_eq!(upload.schema_name(), "Upload");
    assert_eq!(scalar(field(object(upload.ty()), "file").ty()), Scalar::Binary);
}

#[test]
fn use_by_content_that_is_not_json_places_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/M"}}}}}}},
            "/b": {"post": {"x-forge-group-name": "b", "x-forge-method-name": "upload",
              "requestBody": {"content": {"multipart/form-data": {"schema": {
                "type": "object", "properties": {"meta": {"$ref": "#/components/schemas/M"}}
              }}}},
              "responses": {"204": {"description": "ok"}}}}
          },
          "components": {"schemas": {"M": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        }"##,
    );

    assert_eq!(model(&forge, "M").group(), None);
}

#[test]
fn schema_used_only_in_a_response_header_is_not_a_model() {
    let forge = parse(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {"/a": {"get": {"x-forge-group-name": "a", "x-forge-method-name": "get",
            "parameters": [{"name": "X-Trace", "in": "header", "schema": {"$ref": "#/components/schemas/Trace"}}],
            "responses": {"204": {"description": "ok",
              "headers": {"X-Rate-Limit": {"schema": {"$ref": "#/components/schemas/RateLimit"}}}}}}}},
          "components": {"schemas": {
            "Trace": {"type": "string"},
            "RateLimit": {"type": "integer"}
          }}
        }"##,
    );

    // A header parameter's schema is a use, but a response header's is not.
    assert_eq!(models(&forge), ["Trace"]);
}
