//! The scout of the gatekeeper target: what an OpenAPI document says that
//! the author of a gatekeeper would otherwise search it for, and the
//! questions it leaves open.
//!
//! It reads the document as JSON, and not as a `Forge`, for two reasons.
//! What it reports is mostly what a `Forge` does not keep: the servers,
//! the security schemes and the scopes of an operation, the headers of a
//! response, the statuses of the errors. And it has to work on a document
//! that does not link, since one use of it is to say why.
//!
//! Every fact is what the document declares, but for two that are
//! guesses, and say so: how an operation pages, and that an operation
//! sent with `POST` may read.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::{Config, METHODS};

/// How deep into a response the scout looks for what has no type.
const DEPTH: usize = 4;

/// The most paths of a response that the scout lists for one reason.
const PATHS: usize = 12;

/// A question that the document leaves open, for a person to answer.
pub struct Question {
    /// The `operationId` of the operation it is about, or `None` when it is
    /// about the API.
    pub about: Option<String>,
    /// The question, which says what the document has that raises it.
    pub text: String,
}

/// What the scout found in a document.
pub struct Catalog {
    /// What the document says of the API: its servers, its security
    /// schemes, and what about the document will limit the clients.
    pub api: Value,
    /// What it says of each operation, in the order of the document.
    pub operations: Vec<Value>,
    /// What it leaves open.
    pub questions: Vec<Question>,
    /// What to tell whoever generates from the config: the operations of
    /// the config that look like they page, and have no pagination there.
    pub warnings: Vec<String>,
}

impl Catalog {
    /// Reads `doc`. With `config`, the operations it picks are marked, and
    /// the questions about them are asked.
    pub fn new(doc: &Value, config: Option<&Config>) -> Catalog {
        let api = api(doc);
        let mut operations = operations(doc);
        if let Some(config) = config {
            for operation in &mut operations {
                let id = operation["operationId"].as_str().unwrap_or_default();
                if config.operations.contains_key(id) {
                    operation["selected"] = json!(true);
                }
            }
        }
        let questions = questions(&api, &operations, config);
        // A path parameter the config gives a schema is no longer closed.
        for operation in &mut operations {
            let id = operation["operationId"].as_str().unwrap_or_default();
            let Some(chosen) = config.and_then(|config| config.operations.get(id)) else {
                continue;
            };
            let Some(trust) = operation["trust"].as_object_mut() else {
                continue;
            };
            if let Some(closed) = trust.get_mut("closedPathParameters").and_then(Value::as_array_mut) {
                closed.retain(|name| !name.as_str().is_some_and(|name| chosen.parameters.contains_key(name)));
                if closed.is_empty() {
                    trust.remove("closedPathParameters");
                }
            }
            if trust.is_empty() {
                operation.as_object_mut().map(|operation| operation.remove("trust"));
            }
        }
        // How an operation of the config pages is what the config says,
        // and no longer a guess.
        let mut warnings = Vec::new();
        for operation in &mut operations {
            let id = operation["operationId"].as_str().unwrap_or_default().to_owned();
            let Some(chosen) = config.and_then(|config| config.operations.get(&id)) else {
                continue;
            };
            match (&chosen.pagination, operation["pagination"]["style"].as_str()) {
                (Some(pagination), _) => {
                    operation["pagination"] = json!({"style": pagination.style.as_str(), "basis": "config"});
                }
                (None, Some(style)) => warnings.push(format!(
                    "{id} looks like it pages by {style}, and the config has no pagination for it, so it has no pager"
                )),
                (None, None) => {}
            }
        }
        Catalog {
            api,
            operations,
            questions,
            warnings,
        }
    }

    /// Returns what the scout found of the operation `id`.
    pub fn operation(&self, id: &str) -> Option<&Value> {
        self.operations.iter().find(|operation| operation["operationId"] == id)
    }

    /// Returns catalog.json: everything the scout found.
    pub fn json(&self) -> String {
        let questions: Vec<Value> = self
            .questions
            .iter()
            .map(|question| json!({"about": question.about, "question": question.text}))
            .collect();
        let mut text = serde_json::to_string_pretty(&json!({
            "api": self.api,
            "questions": questions,
            "operations": self.operations,
        }))
        .expect("a JSON value is written as JSON");
        text.push('\n');
        text
    }

    /// Returns CATALOG.md: the API, the questions, and a line for each
    /// operation, by tag. It is what to read first, and catalog.json has
    /// the rest of each operation.
    pub fn markdown(&self) -> String {
        let mut text = String::from(CATALOG_INTRO);
        text.push_str(&api_lines(&self.api));
        text.push_str("\n## Questions\n\n");
        text.push_str(&question_lines(&self.questions));
        let mut tags: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
        for operation in &self.operations {
            let tag = operation["tags"][0].as_str().unwrap_or("(no tag)");
            tags.entry(tag).or_default().push(operation);
        }
        text.push_str("\n## Operations\n");
        for (tag, operations) in tags {
            text.push_str(&format!("\n### {tag}\n\n"));
            for operation in operations {
                text.push_str(&operation_line(operation));
            }
        }
        text
    }
}

const CATALOG_INTRO: &str = "\
# Catalog

Forge wrote this from the provider's OpenAPI document, before any operation was chosen. It is what the document says that a gatekeeper needs, so that nobody has to search the document for it. catalog.json has the same, with the parameters, the statuses and the scopes of each operation.

What the document declares is given as it is. Two things are guesses, and are marked: how an operation pages, and that an operation sent with `POST` may only read. Check a guess against the provider's documentation before the config says it.

";

/// Returns the lines of CATALOG.md about the API.
fn api_lines(api: &Value) -> String {
    let mut text = String::from("## The API\n\n");
    let string = |value: &Value, key: &str| value[key].as_str().unwrap_or_default().to_owned();
    text.push_str(&format!(
        "- {} {}, OpenAPI {}.\n",
        string(api, "title"),
        string(api, "version"),
        string(api, "openapi")
    ));
    for server in api["servers"].as_array().into_iter().flatten() {
        let variables: Vec<String> = server["variables"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, variable)| {
                let values: Vec<&str> = variable["enum"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                if values.is_empty() {
                    format!("`{name}`")
                } else {
                    format!("`{name}`, one of `{}`", values.join("`, `"))
                }
            })
            .collect();
        text.push_str(&format!("- Server: `{}`", string(server, "url")));
        if !variables.is_empty() {
            text.push_str(&format!(", with {}", variables.join("; ")));
        }
        text.push_str(".\n");
    }
    for scheme in api["security"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "- Security scheme `{}`: {}.\n",
            string(scheme, "name"),
            string(scheme, "summary")
        ));
    }
    for warning in api["warnings"].as_array().into_iter().flatten() {
        text.push_str(&format!("- Warning: {}\n", warning.as_str().unwrap_or_default()));
    }
    text
}

/// Returns `questions` as the lines of a list, those about the API first.
pub fn question_lines(questions: &[Question]) -> String {
    let mut text = String::new();
    for question in questions {
        match &question.about {
            None => text.push_str(&format!("- {}\n", question.text)),
            Some(id) => text.push_str(&format!("- `{id}`: {}\n", question.text)),
        }
    }
    if text.is_empty() {
        text.push_str("- None.\n");
    }
    text
}

/// Returns the line of CATALOG.md for an operation.
fn operation_line(operation: &Value) -> String {
    let string = |key: &str| operation[key].as_str().unwrap_or_default();
    let mut notes = vec![string("kind").to_owned()];
    if operation["readCandidate"] == true {
        notes.push("may only read (guess)".to_owned());
    }
    if let Some(style) = operation["pagination"]["style"].as_str() {
        let basis = operation["pagination"]["basis"].as_str().unwrap_or_default();
        notes.push(format!("pages by {style} ({basis})"));
    }
    if let Some(reason) = operation["notGenerated"].as_str() {
        notes.push(format!("not generated: {reason}"));
    }
    if operation["deprecated"] == true {
        notes.push("deprecated".to_owned());
    }
    let selected = if operation["selected"] == true {
        " (in the config)"
    } else {
        ""
    };
    let summary = match string("summary") {
        "" => String::new(),
        summary => format!(" {summary}."),
    };
    format!(
        "- `{}`{selected}: `{} {}`.{summary} {}.\n",
        string("operationId"),
        string("method"),
        string("path"),
        notes.join(", ")
    )
}

/// Returns what `doc` says of the API.
fn api(doc: &Value) -> Value {
    let info = &doc["info"];
    let mut warnings = Vec::new();
    if doc.get("swagger").is_some() || doc["openapi"].as_str().is_none_or(|version| !version.starts_with('3')) {
        warnings.push("The document is not OpenAPI 3, which is all that Forge reads.".to_owned());
    }
    let mut references = References::default();
    references.count(doc);
    if references.to_schemas == 0 {
        warnings.push(
            "No operation refers to a shared schema, so every type is written in place: the same object has a type of its own in each operation, and a file of the clients can have lines too long to read."
                .to_owned(),
        );
    }
    if !references.not_covered.is_empty() {
        let examples: Vec<&str> = references.not_covered.iter().take(3).map(String::as_str).collect();
        warnings.push(format!(
            "{} `$ref`s point where Forge does not follow one, such as `{}`. An operation that uses one is an error when it is in the config.",
            references.not_covered.len(),
            examples.join("`, `")
        ));
    }
    let servers: Vec<Value> = doc["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|server| {
            let mut value = json!({"url": server["url"]});
            if let Some(variables) = server["variables"].as_object() {
                let variables: Map<String, Value> = variables
                    .iter()
                    .map(|(name, variable)| {
                        let mut kept = json!({"default": variable["default"]});
                        if variable.get("enum").is_some() {
                            kept["enum"] = variable["enum"].clone();
                        }
                        (name.clone(), kept)
                    })
                    .collect();
                value["variables"] = Value::Object(variables);
            }
            value
        })
        .collect();
    let schemes: Vec<Value> = doc["components"]["securitySchemes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, scheme)| security_scheme(name, scheme))
        .collect();
    json!({
        "title": info["title"],
        "version": info["version"],
        "openapi": doc.get("openapi").or_else(|| doc.get("swagger")),
        "servers": servers,
        "security": schemes,
        "warnings": warnings,
    })
}

/// Returns what a security scheme is: its kind, how a request carries it,
/// and the URLs and scopes of its OAuth flows.
fn security_scheme(name: &str, scheme: &Value) -> Value {
    let string = |key: &str| scheme[key].as_str().unwrap_or_default();
    let mut value = json!({"name": name, "type": scheme["type"]});
    let summary = match string("type") {
        "http" => {
            value["scheme"] = scheme["scheme"].clone();
            format!("the `Authorization` header, with the scheme `{}`", string("scheme"))
        }
        "apiKey" => {
            value["in"] = scheme["in"].clone();
            value["parameter"] = scheme["name"].clone();
            format!("an API key in the {} `{}`", string("in"), string("name"))
        }
        "oauth2" => {
            let mut flows = Map::new();
            for (flow, described) in scheme["flows"].as_object().into_iter().flatten() {
                let mut kept = Map::new();
                for key in ["authorizationUrl", "tokenUrl", "refreshUrl"] {
                    if let Some(url) = described.get(key) {
                        kept.insert(key.to_owned(), url.clone());
                    }
                }
                let scopes: Vec<&String> = described["scopes"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(scope, _)| scope)
                    .collect();
                kept.insert("scopes".to_owned(), json!(scopes));
                flows.insert(flow.clone(), Value::Object(kept));
            }
            let names: Vec<&str> = flows.keys().map(String::as_str).collect();
            let summary = format!("OAuth 2, with the flows `{}`", names.join("`, `"));
            value["flows"] = Value::Object(flows);
            summary
        }
        "openIdConnect" => {
            value["openIdConnectUrl"] = scheme["openIdConnectUrl"].clone();
            "OpenID Connect".to_owned()
        }
        other => format!("of the type `{other}`"),
    };
    value["summary"] = json!(summary);
    value
}

/// The `$ref`s of a document, counted by where they point.
#[derive(Default)]
struct References {
    /// How many point to `components.schemas`.
    to_schemas: usize,
    /// Those that Forge does not follow, each once.
    not_covered: BTreeSet<String>,
}

impl References {
    fn count(&mut self, value: &Value) {
        match value {
            Value::Object(object) => {
                if let Some(Value::String(reference)) = object.get("$ref") {
                    self.add(reference);
                }
                // A discriminator names the schema of each case with a
                // `$ref`, or with the name of a schema.
                if let Some(mapping) = object.get("mapping").and_then(Value::as_object) {
                    for reference in mapping.values().filter_map(Value::as_str) {
                        if reference.starts_with('#') {
                            self.add(reference);
                        }
                    }
                }
                // An example is data, in which a `$ref` is not one.
                for (key, value) in object {
                    if key != "example" && key != "examples" {
                        self.count(value);
                    }
                }
            }
            Value::Array(values) => values.iter().for_each(|value| self.count(value)),
            _ => {}
        }
    }

    fn add(&mut self, reference: &str) {
        let mut segments = reference.split('/');
        let (start, components, kind) = (segments.next(), segments.next(), segments.next());
        if start != Some("#") || components != Some("components") {
            self.not_covered.insert(reference.to_owned());
            return;
        }
        match kind {
            Some("schemas") => self.to_schemas += 1,
            // A whole object of these, or a schema in one.
            Some("parameters" | "requestBodies" | "responses" | "pathItems") => {}
            // What Forge does not read, so that a `$ref` to it is no error.
            Some("headers" | "examples" | "links" | "callbacks" | "securitySchemes") => {}
            _ => {
                self.not_covered.insert(reference.to_owned());
            }
        }
    }
}

/// Returns what `doc` says of each operation, in the order it has them.
fn operations(doc: &Value) -> Vec<Value> {
    let mut operations = Vec::new();
    for (path, item) in doc["paths"].as_object().into_iter().flatten() {
        let item = follow(doc, item);
        for method in METHODS {
            if let Some(operation) = item.get(method).filter(|operation| operation.is_object()) {
                operations.push(operation_facts(doc, path, method, item, operation));
            }
        }
    }
    operations
}

/// Returns `value`, or what its `$ref` points to in `doc`, following
/// `$ref`s. One that points to nothing is returned as it is.
fn follow<'a>(doc: &'a Value, mut value: &'a Value) -> &'a Value {
    for _ in 0..16 {
        let Some(reference) = value.get("$ref").and_then(Value::as_str) else {
            return value;
        };
        let Some(target) = reference.strip_prefix('#').and_then(|pointer| doc.pointer(pointer)) else {
            return value;
        };
        value = target;
    }
    value
}

/// Returns what `doc` says of the operation `operation`, which is sent
/// with `method` to `path`, and whose path item is `item`.
fn operation_facts(doc: &Value, path: &str, method: &str, item: &Value, operation: &Value) -> Value {
    let string = |key: &str| operation[key].as_str().unwrap_or_default();
    let upper = method.to_uppercase();
    let mut facts = json!({
        "operationId": operation["operationId"],
        "method": upper,
        "path": path,
        "tags": operation.get("tags").cloned().unwrap_or_else(|| json!([])),
        "summary": string("summary").trim().trim_end_matches('.'),
        "kind": if matches!(method, "get" | "head") { "read" } else { "write" },
    });
    if operation["deprecated"] == true {
        facts["deprecated"] = json!(true);
    }
    if operation["operationId"].as_str().is_none() {
        facts["notGenerated"] = json!("it has no operationId for a config to name it by");
    }
    if method == "post" && reads_by_name(&format!("{} {path} {}", string("operationId"), string("summary"))) {
        facts["readCandidate"] = json!(true);
    }

    // The parameters of the path item, then the operation's own in place
    // of those of the same name and location.
    let mut parameters: Vec<&Value> = Vec::new();
    for parameter in [item, operation]
        .into_iter()
        .flat_map(|holder| holder["parameters"].as_array().into_iter().flatten())
    {
        let parameter = follow(doc, parameter);
        parameters.retain(|other| other["name"] != parameter["name"] || other["in"] != parameter["in"]);
        parameters.push(parameter);
    }
    let mut located = Map::new();
    let mut closed = Vec::new();
    for location in ["path", "query", "header"] {
        let names: Vec<Value> = parameters
            .iter()
            .filter(|parameter| parameter["in"] == location)
            .map(|parameter| {
                let schema = follow(doc, &parameter["schema"]);
                if location == "path" && schema.get("enum").is_some() {
                    closed.push(parameter["name"].clone());
                }
                json!({"name": parameter["name"], "required": parameter["required"] == true})
            })
            .collect();
        if !names.is_empty() {
            located.insert(location.to_owned(), Value::Array(names));
        }
    }
    facts["parameters"] = Value::Object(located);

    // What it asks of a credential: its own `security`, or the document's.
    if let Some(security) = operation.get("security").or_else(|| doc.get("security")) {
        facts["security"] = security.clone();
    }

    let mut success = Vec::new();
    let mut errors = Vec::new();
    let mut response = None;
    let mut headers: BTreeSet<String> = BTreeSet::new();
    let mut other_content = None;
    for (status, described) in operation["responses"].as_object().into_iter().flatten() {
        let described = follow(doc, described);
        let (schema, content) = json_content(doc, described);
        if status.starts_with('2') {
            success.push(json!(status));
            if response.is_none() {
                response = schema;
            }
            if content == "other" {
                other_content = Some(status.as_str());
            }
            headers.extend(
                described["headers"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, _)| name.to_lowercase()),
            );
        } else if !status.starts_with('3') {
            errors.push(json!({"status": status, "body": content}));
        }
    }
    facts["responses"] = json!({"success": success, "errors": errors});
    let (body, body_content) = json_content(doc, follow(doc, &operation["requestBody"]));
    if body_content == "other" {
        facts["notGenerated"] = json!("its request body is not JSON");
    } else if let Some(status) = other_content {
        facts["notGenerated"] = json!(format!("its {status} response is not JSON"));
    }

    let query: Vec<&str> = parameters
        .iter()
        .filter(|parameter| parameter["in"] == "query")
        .filter_map(|parameter| parameter["name"].as_str())
        .collect();
    let body_fields: Vec<&str> = match body.map(|body| fields(doc, body)) {
        Some(fields) if method != "get" => fields.into_iter().map(|(name, _)| name).collect(),
        _ => Vec::new(),
    };
    if matches!(method, "get" | "post")
        && let Some(pagination) = pagination(doc, &query, &body_fields, response, &headers)
    {
        facts["pagination"] = pagination;
    }

    let mut trust = Map::new();
    if !closed.is_empty() {
        trust.insert("closedPathParameters".to_owned(), Value::Array(closed));
    }
    if let Some(response) = response {
        let mut found = Trust::default();
        found.walk(doc, response, String::new(), 0);
        for (key, paths) in [("untyped", found.untyped), ("allOptional", found.all_optional)] {
            if !paths.is_empty() {
                let more = paths.len().saturating_sub(PATHS);
                let mut listed: Vec<Value> = paths.into_iter().take(PATHS).map(Value::String).collect();
                if more > 0 {
                    listed.push(json!(format!("and {more} more")));
                }
                trust.insert(key.to_owned(), Value::Array(listed));
            }
        }
    }
    if !trust.is_empty() {
        facts["trust"] = Value::Object(trust);
    }
    facts
}

/// Reports whether the name, the path or the summary of an operation sent
/// with `POST` suggests that it only reads.
fn reads_by_name(text: &str) -> bool {
    let text = text.to_lowercase();
    ["search", "query", "lookup", "graphql", "/list", "filter"]
        .iter()
        .any(|word| text.contains(word))
}

/// Returns the schema of the JSON content of a request body or a response,
/// and what its content is: "json", "none" when it has none, or "other".
fn json_content<'a>(doc: &'a Value, holder: &'a Value) -> (Option<&'a Value>, &'static str) {
    let Some(content) = holder["content"].as_object().filter(|content| !content.is_empty()) else {
        return (None, "none");
    };
    let json = content.iter().find(|(media_type, _)| {
        let media_type = media_type.split(';').next().unwrap_or_default().trim();
        media_type == "application/json" || media_type.ends_with("+json")
    });
    match json {
        Some((_, described)) => (described.get("schema").map(|schema| follow(doc, schema)), "json"),
        None => (None, "other"),
    }
}

/// Returns the properties of `schema`, and of the members of its `allOf`,
/// each with its schema.
fn fields<'a>(doc: &'a Value, schema: &'a Value) -> Vec<(&'a str, &'a Value)> {
    fn add<'a>(doc: &'a Value, schema: &'a Value, depth: usize, out: &mut Vec<(&'a str, &'a Value)>) {
        let schema = follow(doc, schema);
        for (name, property) in schema["properties"].as_object().into_iter().flatten() {
            out.push((name.as_str(), follow(doc, property)));
        }
        if depth < 8 {
            for member in schema["allOf"].as_array().into_iter().flatten() {
                add(doc, member, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    add(doc, schema, 0, &mut out);
    out
}

/// Reports whether `schema` is an array.
fn is_array(schema: &Value) -> bool {
    schema["type"] == "array" || schema.get("items").is_some()
}

/// Returns a guess at how an operation pages, as the `pagination` of a
/// config has it, with what the guess is from, or `None` when nothing
/// suggests that it does. `query` is the names of its query parameters,
/// `body` those of the properties of its request body, `response` the
/// schema of its success response, and `headers` the lower-case names of
/// the headers that response declares.
fn pagination(
    doc: &Value,
    query: &[&str],
    body: &[&str],
    response: Option<&Value>,
    headers: &BTreeSet<String>,
) -> Option<Value> {
    let request: Vec<&str> = query.iter().chain(body).copied().collect();
    let has = |names: &[&'static str]| names.iter().copied().find(|name| request.contains(name));
    let properties = response.map(|response| fields(doc, response)).unwrap_or_default();
    let array = response.is_some_and(is_array);
    // The one property of the response that is an array has the items.
    let arrays: Vec<&str> = properties
        .iter()
        .filter(|(_, schema)| is_array(schema))
        .map(|&(name, _)| name)
        .collect();
    let items = match arrays[..] {
        [only] => Some(only),
        _ => None,
    };
    let flag = |names: &[&'static str]| {
        names.iter().copied().find(|name| {
            properties
                .iter()
                .any(|(property, schema)| property == name && schema["type"] == "boolean")
        })
    };
    let more = flag(&["more", "has_more", "hasMore", "has_next_page", "hasNextPage"]);
    let last = flag(&["is_last", "isLast", "last", "last_page"]);
    let limit = has(&[
        "limit",
        "per_page",
        "page_size",
        "pageSize",
        "count",
        "maxResults",
        "max_results",
    ]);
    let mut guess = Map::new();
    let mut set = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            guess.insert(key.to_owned(), json!(value));
        }
    };

    if headers.contains("link") {
        set("style", Some("link-header"));
        set("items", items.filter(|_| !array));
        set("basis", Some("declared"));
        set("evidence", Some("its response declares a Link header"));
        return Some(Value::Object(guess));
    }
    if let Some(offset) = has(&["offset", "startAt", "start_at", "skip"])
        && (array || items.is_some())
    {
        set("style", Some("offset"));
        set("items", items.filter(|_| !array));
        set("offset", Some(offset));
        set("limit", limit);
        set("more", more);
        set("last", last.filter(|_| more.is_none()));
        set("basis", Some("guessed"));
        set("evidence", Some("it takes an offset and returns a list"));
        return Some(Value::Object(guess));
    }
    let cursor = has(&[
        "cursor",
        "start_cursor",
        "page_token",
        "pageToken",
        "next_token",
        "nextToken",
        "starting_after",
        "after",
    ]);
    if let Some(cursor) = cursor {
        if let Some(next) = next_cursor(doc, &properties) {
            set("style", Some("cursor"));
            set("items", items.filter(|_| !array));
            set("cursor", Some(cursor));
            set("next", Some(&next));
            set("limit", limit);
            set("more", more);
            set("last", last.filter(|_| more.is_none()));
            set("basis", Some("guessed"));
            set("evidence", Some("it takes a cursor, and its response has the next one"));
            return Some(Value::Object(guess));
        }
        if array || items.is_some() {
            set("style", Some("link-header"));
            set("items", items.filter(|_| !array));
            set("basis", Some("guessed"));
            set(
                "evidence",
                Some(
                    "it takes a cursor and returns a list, and its response has no next cursor, which is then likely in a Link header",
                ),
            );
            return Some(Value::Object(guess));
        }
    }
    if has(&["page", "page_number", "pageNumber"]).is_some() && (array || items.is_some()) {
        set("style", Some("page-number"));
        set("basis", Some("guessed"));
        set(
            "evidence",
            Some(
                "it takes a page number and returns a list; a config cannot declare a page number yet, unless the next page is also in a Link header",
            ),
        );
        return Some(Value::Object(guess));
    }
    None
}

/// Returns the path of the property of a response that has the cursor of
/// the next page, among `properties` or one level under them, such as
/// `response_metadata.next_cursor`.
fn next_cursor(doc: &Value, properties: &[(&str, &Value)]) -> Option<String> {
    let is_next = |name: &str| {
        let name = name.to_lowercase();
        name.contains("next") && (name.contains("cursor") || name.contains("token") || name.contains("page"))
            || name == "next"
            || name == "cursor"
    };
    if let Some((name, _)) = properties.iter().find(|(name, _)| is_next(name)) {
        return Some((*name).to_owned());
    }
    for (name, schema) in properties {
        if let Some((inner, _)) = fields(doc, schema).into_iter().find(|(inner, _)| is_next(inner)) {
            return Some(format!("{name}.{inner}"));
        }
    }
    None
}

/// What of a response its type cannot be relied on for.
#[derive(Default)]
struct Trust {
    /// The paths the document gives no type: any value, an object with no
    /// properties, or an array of either.
    untyped: Vec<String>,
    /// The paths of objects none of whose properties is required, which is
    /// more often what the document left out than what the API does.
    all_optional: Vec<String>,
}

impl Trust {
    /// Looks at `schema`, which is at `path` in a response, `depth` levels
    /// down. An item of an array is at `[]`, and the response itself at
    /// the empty path, which is written `(the response)`.
    fn walk(&mut self, doc: &Value, schema: &Value, path: String, depth: usize) {
        let schema = follow(doc, schema);
        let named = |path: &str| {
            if path.is_empty() {
                "(the response)".to_owned()
            } else {
                path.to_owned()
            }
        };
        let composed = ["allOf", "oneOf", "anyOf"]
            .iter()
            .any(|key| schema[*key].as_array().is_some_and(|members| !members.is_empty()));
        if is_array(schema) {
            match schema.get("items") {
                Some(items) => self.walk(doc, items, format!("{path}[]"), depth),
                None => self.untyped.push(named(&format!("{path}[]"))),
            }
            return;
        }
        let properties = fields(doc, schema);
        if properties.is_empty() {
            let shaped = schema.get("enum").is_some()
                || schema.get("const").is_some()
                || schema["additionalProperties"].is_object()
                || matches!(schema["type"].as_str(), Some(kind) if kind != "object")
                || schema["type"].is_array()
                || composed;
            if !shaped {
                self.untyped.push(named(&path));
            }
            return;
        }
        let required = |schema: &Value| {
            schema["required"]
                .as_array()
                .is_some_and(|required| !required.is_empty())
        };
        let any_required = required(schema)
            || schema["allOf"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|member| required(follow(doc, member)));
        // Only near the top, where an author maps every field.
        if !any_required && depth <= 1 {
            self.all_optional.push(named(&path));
        }
        if depth >= DEPTH {
            return;
        }
        for (name, property) in properties {
            let path = if path.is_empty() {
                name.to_owned()
            } else {
                format!("{path}.{name}")
            };
            self.walk(doc, property, path, depth + 1);
        }
    }
}

/// Returns the questions that `api` and `operations` leave open. With
/// `config`, those about the operations it picks are asked too.
fn questions(api: &Value, operations: &[Value], config: Option<&Config>) -> Vec<Question> {
    let mut questions = Vec::new();
    let mut ask = |about: Option<&str>, text: String| {
        questions.push(Question {
            about: about.map(str::to_owned),
            text,
        });
    };

    let servers = api["servers"].as_array().map(Vec::as_slice).unwrap_or_default();
    match servers {
        [] => ask(
            None,
            "The document names no server. What is the URL of the API?".to_owned(),
        ),
        [server] => {
            if let Some(variables) = server["variables"]
                .as_object()
                .filter(|variables| !variables.is_empty())
            {
                let names: Vec<&str> = variables.keys().map(String::as_str).collect();
                ask(
                    None,
                    format!(
                        "The server is `{}`. Where does a connection get `{}` from, and is it fixed for the life of the connection?",
                        server["url"].as_str().unwrap_or_default(),
                        names.join("`, `")
                    ),
                );
            }
        }
        servers => ask(
            None,
            format!(
                "The document names {} servers. Which does a connection use, and what decides it?",
                servers.len()
            ),
        ),
    }

    let schemes = api["security"].as_array().map(Vec::as_slice).unwrap_or_default();
    if schemes.is_empty() {
        ask(
            None,
            "The document declares no security scheme. How does a request carry its credential?".to_owned(),
        );
    } else if !schemes.iter().any(|scheme| scheme["type"] == "oauth2") {
        ask(
            None,
            "The document declares no OAuth flow. If the gatekeeper connects with OAuth, where are the authorize and token endpoints, which scopes does it ask for, and does a token expire?"
                .to_owned(),
        );
    }

    let identity: Vec<&str> = operations
        .iter()
        .filter(|operation| {
            operation["method"] == "GET"
                && (names_the_caller(operation["path"].as_str().unwrap_or_default())
                    || says_the_caller(operation["summary"].as_str().unwrap_or_default()))
        })
        .filter_map(|operation| operation["operationId"].as_str())
        .take(3)
        .collect();
    if identity.is_empty() {
        ask(
            None,
            "No operation looks like one that returns the user of the credential. How does the gatekeeper learn whose credential it has?"
                .to_owned(),
        );
    } else {
        ask(
            None,
            format!(
                "Which operation says whose credential a connection has? `{}` may be it.",
                identity.join("`, `")
            ),
        );
    }
    ask(
        None,
        "How does the API answer a rate limit: which status, and which header says when to try again?".to_owned(),
    );
    ask(
        None,
        "Which status means that the credential itself was rejected, and not that one resource is denied?".to_owned(),
    );
    ask(
        None,
        "Does the API answer 404 for a resource that exists and the user may not see?".to_owned(),
    );

    let Some(config) = config else {
        // Before a config, of the API as a whole. A config answers for
        // each of its operations.
        let by_link = operations
            .iter()
            .filter(|operation| operation["pagination"]["style"] == "link-header")
            .count();
        if by_link > 0 {
            ask(
                None,
                format!(
                    "Some operations look like they page by a `Link` header ({by_link} of them). Does the API send the `rel=\"next\"` link with the last page too? If so, which parameter of the link says that there is another page? The `more` of a pagination names it, and without it such a listing never ends."
                ),
            );
        }
        return questions;
    };
    let selected: Vec<&Value> = operations
        .iter()
        .filter(|operation| operation["selected"] == true)
        .collect();

    // A path parameter that most of the operations have is likely what a
    // connection is bound to.
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for operation in &selected {
        for parameter in operation["parameters"]["path"].as_array().into_iter().flatten() {
            if let Some(name) = parameter["name"].as_str() {
                *counts.entry(name).or_default() += 1;
            }
        }
    }
    let bound: Vec<&str> = counts
        .iter()
        .filter(|&(_, &count)| selected.len() >= 2 && count * 4 >= selected.len() * 3)
        .map(|(&name, _)| name)
        .collect();
    if !config.bound.is_empty() {
        ask(
            None,
            format!(
                "The config says that a connection is bound to `{}`. Where does a session get it from, and how is it pinned so that a rename does not point the connection elsewhere?",
                config.bound.join("`, `")
            ),
        );
    } else if !bound.is_empty() {
        ask(
            None,
            format!(
                "Most operations of the config take `{}` in the path. Is that what a connection is bound to, so that a session sets it and never takes it from its caller? If so, the config can say `\"bound\"`.",
                bound.join("`, `")
            ),
        );
    }

    let mut link_header = false;
    for operation in selected {
        let id = operation["operationId"].as_str().unwrap_or_default();
        let about = Some(id);
        let chosen = config.operations.get(id);
        if let Some(reason) = operation["notGenerated"].as_str() {
            ask(
                about,
                format!("It cannot be generated: {reason}. Is it written by hand, or left out?"),
            );
        }
        let guess = &operation["pagination"];
        let declared = chosen.and_then(|chosen| chosen.pagination.as_ref());
        match (declared, guess["style"].as_str()) {
            (None, Some(style)) => ask(
                about,
                format!(
                    "It looks like it pages by `{style}` ({}), and the config does not say so. Does it page? Without a `pagination` in the config, it has no pager.",
                    guess["evidence"].as_str().unwrap_or_default()
                ),
            ),
            // One that names what says there is another page has answered.
            (Some(declared), _) if declared.is_link_header() => link_header |= declared.more.is_none(),
            _ => {}
        }
        if operation["readCandidate"] == true && chosen.is_some_and(|chosen| chosen.kind.is_none()) {
            ask(
                about,
                "It is sent with `POST` and its name suggests that it only reads. Does it change anything? If not, the config can say `\"kind\": \"read\"`."
                    .to_owned(),
            );
        }
        for parameter in operation["trust"]["closedPathParameters"]
            .as_array()
            .into_iter()
            .flatten()
        {
            // One that the config gives a schema has answered.
            let name = parameter.as_str().unwrap_or_default();
            if chosen.is_some_and(|chosen| chosen.parameters.contains_key(name)) {
                continue;
            }
            ask(
                about,
                format!(
                    "The path parameter `{name}` is typed as a closed list of values. Does the API also take any other value there, such as an id? If so, the config can give it a schema under `\"parameters\"`."
                ),
            );
        }
    }
    if link_header {
        ask(
            None,
            "For the operations that page by `link-header`: is the last page the one with no `rel=\"next\"` link? If the API sends that link with the last page too, the `more` of a pagination names the parameter of the link that is `true` when there is another page, such as `results`."
                .to_owned(),
        );
    }
    questions
}

/// Reports whether the summary of an operation says that it returns the
/// user or the credential of the request.
fn says_the_caller(summary: &str) -> bool {
    let summary = summary.to_lowercase();
    [
        "current user",
        "current credential",
        "current token",
        "authenticated user",
        "who am i",
    ]
    .iter()
    .any(|words| summary.contains(words))
}

/// Reports whether `path` looks like that of the operation that returns
/// the user of the credential.
fn names_the_caller(path: &str) -> bool {
    let path = path.trim_end_matches('/').to_lowercase();
    [
        "/me",
        "/user",
        "/users/me",
        "/whoami",
        "/viewer",
        "/self",
        "/users/@me",
        "/auth.test",
    ]
    .iter()
    .any(|end| path.ends_with(end))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{Catalog, Config};

    const SPEC: &str = r##"{
      "openapi": "3.0.3",
      "info": {"title": "Tracker", "version": "1"},
      "servers": [
        {"url": "https://{region}.example.com", "variables": {"region": {"default": "us", "enum": ["us", "de"]}}}
      ],
      "security": [{"token": ["read"]}],
      "paths": {
        "/orgs/{org}/issues": {
          "parameters": [
            {"$ref": "#/components/parameters/org"}
          ],
          "get": {
            "operationId": "listIssues",
            "tags": ["Issues"],
            "summary": "List issues.",
            "parameters": [
              {"name": "cursor", "in": "query", "schema": {"type": "string"}}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/Issue"}
              }}}},
              "404": {"description": "missing"}
            }
          },
          "post": {
            "operationId": "searchIssues",
            "tags": ["Issues"],
            "security": [{"token": ["read", "search"]}],
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object",
              "properties": {"offset": {"type": "integer"}, "limit": {"type": "integer"}}
            }}}},
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "object",
                "properties": {
                  "issues": {"type": "array", "items": {"$ref": "#/components/schemas/Issue"}},
                  "more": {"type": "boolean"}
                }
              }}}},
              "422": {"description": "invalid", "content": {"application/json": {"schema": {"type": "object"}}}}
            }
          }
        },
        "/orgs/{org}/issues/{issue}/events/{event}": {
          "get": {
            "operationId": "getEvent",
            "parameters": [
              {"$ref": "#/components/parameters/org"},
              {"name": "issue", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "event", "in": "path", "required": true, "schema": {"type": "string", "enum": ["latest"]}}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "object",
                "required": ["id"],
                "properties": {
                  "id": {"type": "string"},
                  "entries": {"type": "array", "items": {}},
                  "user": {"type": "object", "properties": {"name": {"type": "string"}}}
                }
              }}}}
            }
          }
        },
        "/orgs/{org}/export": {
          "get": {
            "operationId": "export",
            "parameters": [
              {"$ref": "#/components/parameters/org"}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"text/csv": {"schema": {"type": "string"}}}}
            }
          }
        }
      },
      "components": {
        "parameters": {
          "org": {"name": "org", "in": "path", "required": true, "schema": {"type": "string"}}
        },
        "schemas": {
          "Issue": {"type": "object", "properties": {"id": {"type": "string"}}}
        },
        "securitySchemes": {
          "token": {"type": "http", "scheme": "bearer"}
        }
      }
    }"##;

    fn catalog(config: Option<&str>) -> Catalog {
        let doc: Value = serde_json::from_str(SPEC).unwrap();
        let config: Option<Config> = config.map(|config| serde_json::from_str(config).unwrap());
        Catalog::new(&doc, config.as_ref())
    }

    fn questions(catalog: &Catalog) -> Vec<String> {
        catalog
            .questions
            .iter()
            .map(|question| match &question.about {
                Some(id) => format!("{id}: {}", question.text),
                None => question.text.clone(),
            })
            .collect()
    }

    #[test]
    fn the_api_has_its_servers_and_its_security_schemes() {
        let catalog = catalog(None);
        assert_eq!(
            catalog.api["servers"],
            serde_json::json!([{
                "url": "https://{region}.example.com",
                "variables": {"region": {"default": "us", "enum": ["us", "de"]}}
            }])
        );
        assert_eq!(catalog.api["security"][0]["name"], "token");
        assert_eq!(catalog.api["security"][0]["scheme"], "bearer");
        assert_eq!(catalog.api["warnings"], serde_json::json!([]));
    }

    #[test]
    fn an_operation_has_what_the_document_declares_of_it() {
        let catalog = catalog(None);
        let list = catalog.operation("listIssues").unwrap();
        assert_eq!(list["kind"], "read");
        assert_eq!(list["summary"], "List issues");
        // The parameters of the path item are its own too.
        assert_eq!(
            list["parameters"],
            serde_json::json!({
                "path": [{"name": "org", "required": true}],
                "query": [{"name": "cursor", "required": false}]
            })
        );
        // The document's security, since it has none of its own.
        assert_eq!(list["security"], serde_json::json!([{"token": ["read"]}]));
        assert_eq!(
            list["responses"],
            serde_json::json!({"success": ["200"], "errors": [{"status": "404", "body": "none"}]})
        );
        let search = catalog.operation("searchIssues").unwrap();
        assert_eq!(search["security"], serde_json::json!([{"token": ["read", "search"]}]));
        assert_eq!(
            search["responses"]["errors"],
            serde_json::json!([{"status": "422", "body": "json"}])
        );
        let export = catalog.operation("export").unwrap();
        assert_eq!(export["notGenerated"], "its 200 response is not JSON");
    }

    #[test]
    fn how_an_operation_pages_is_a_guess_that_says_so() {
        let catalog = catalog(None);
        // A cursor with no next cursor in the response.
        assert_eq!(
            catalog.operation("listIssues").unwrap()["pagination"],
            serde_json::json!({
                "style": "link-header",
                "basis": "guessed",
                "evidence": "it takes a cursor and returns a list, and its response has no next cursor, which is then likely in a Link header"
            })
        );
        // The offset is in the body, and the items in a property.
        let search = catalog.operation("searchIssues").unwrap();
        assert_eq!(search["kind"], "write");
        assert_eq!(search["readCandidate"], true);
        assert_eq!(
            search["pagination"],
            serde_json::json!({
                "style": "offset",
                "items": "issues",
                "offset": "offset",
                "limit": "limit",
                "more": "more",
                "basis": "guessed",
                "evidence": "it takes an offset and returns a list"
            })
        );
        assert!(catalog.operation("getEvent").unwrap().get("pagination").is_none());
    }

    #[test]
    fn what_a_type_cannot_be_relied_on_for_is_listed() {
        let catalog = catalog(None);
        assert_eq!(
            catalog.operation("getEvent").unwrap()["trust"],
            serde_json::json!({
                "closedPathParameters": ["event"],
                "untyped": ["entries[]"],
                "allOptional": ["user"]
            })
        );
        // Every field of an item of the list is optional.
        assert_eq!(
            catalog.operation("listIssues").unwrap()["trust"],
            serde_json::json!({"allOptional": ["[]"]})
        );
        // A parameter the config gives a schema is not closed.
        let catalog = self::catalog(Some(
            r#"{"operations": {"getEvent": {"name": "get", "parameters": {"event": {"type": "string"}}}}}"#,
        ));
        assert_eq!(
            catalog.operation("getEvent").unwrap()["trust"],
            serde_json::json!({"untyped": ["entries[]"], "allOptional": ["user"]})
        );
    }

    #[test]
    fn the_questions_are_what_the_document_leaves_open() {
        let asked = questions(&catalog(None));
        assert!(
            asked[0].starts_with("The server is `https://{region}.example.com`. Where does a connection get `region`")
        );
        assert!(
            asked[1].starts_with("The document declares no OAuth flow."),
            "{asked:?}"
        );
        assert!(
            asked[2].starts_with("No operation looks like one that returns the user"),
            "{asked:?}"
        );
        // Asked before a config, since a listing that never ends is found late.
        assert!(
            asked[6].starts_with("Some operations look like they page by a `Link` header (1 of them)."),
            "{asked:?}"
        );
        // Nothing is asked of an operation before a config picks it.
        assert_eq!(asked.len(), 7, "{asked:?}");
        // A summary can say which operation returns the caller.
        assert!(super::says_the_caller("Retrieve the Current Credentials"));
        assert!(!super::says_the_caller("List issues"));
    }

    #[test]
    fn a_config_adds_the_questions_about_its_operations() {
        let catalog = catalog(Some(
            r#"{
              "operations": {
                "listIssues": {"name": "list"},
                "searchIssues": {"name": "search"},
                "getEvent": {"name": "getEvent"},
                "export": {"name": "export"}
              }
            }"#,
        ));
        assert_eq!(catalog.operation("listIssues").unwrap()["selected"], true);
        let asked = questions(&catalog);
        let has = |start: &str| asked.iter().any(|question| question.starts_with(start));
        assert!(
            has("Most operations of the config take `org` in the path."),
            "{asked:?}"
        );
        assert!(has("listIssues: It looks like it pages by `link-header`"), "{asked:?}");
        // Generation warns of the same, since the operation gets no pager.
        assert!(
            catalog.warnings[0].starts_with("listIssues looks like it pages by link-header, and the config has no"),
            "{:?}",
            catalog.warnings
        );
        assert!(has("searchIssues: It looks like it pages by `offset`"), "{asked:?}");
        assert!(
            has("searchIssues: It is sent with `POST` and its name suggests"),
            "{asked:?}"
        );
        assert!(
            has("getEvent: The path parameter `event` is typed as a closed list"),
            "{asked:?}"
        );
        assert!(
            has("export: It cannot be generated: its 200 response is not JSON."),
            "{asked:?}"
        );

        // What the config says is not asked again.
        let catalog = super::tests::catalog(Some(
            r#"{
              "operations": {
                "listIssues": {"name": "list", "pagination": {"style": "link-header"}},
                "searchIssues": {
                  "name": "search",
                  "kind": "read",
                  "pagination": {"style": "offset", "items": "issues", "more": "more"}
                }
              }
            }"#,
        ));
        let asked = questions(&catalog);
        assert_eq!(catalog.warnings, Vec::<String>::new());
        assert_eq!(
            catalog.operation("listIssues").unwrap()["pagination"],
            serde_json::json!({"style": "link-header", "basis": "config"})
        );
        assert!(
            !asked.iter().any(|question| question.contains("It looks like it pages")),
            "{asked:?}"
        );
        assert!(
            !asked
                .iter()
                .any(|question| question.contains("suggests that it only reads")),
            "{asked:?}"
        );
        assert!(
            asked
                .iter()
                .any(|question| question.starts_with("For the operations that page by `link-header`")),
            "{asked:?}"
        );
    }

    #[test]
    fn the_catalog_lists_every_operation_by_tag() {
        let markdown = catalog(None).markdown();
        assert!(markdown.contains("- Server: `https://{region}.example.com`, with `region`, one of `us`, `de`.\n"));
        assert!(markdown.contains("\n### Issues\n\n- `listIssues`: `GET /orgs/{org}/issues`. List issues. read, pages by link-header (guessed).\n"));
        assert!(
            markdown
                .contains("- `export`: `GET /orgs/{org}/export`. read, not generated: its 200 response is not JSON.\n")
        );
    }
}
