//! The gatekeeper generator, following rfcs/gatekeeper.md.
//!
//! A gatekeeper covers a few operations of an API, which a config file
//! picks and names. The config is applied to the document before it is
//! linked, so that the operations it leaves out, and the models only they
//! use, are never part of the [`Forge`]. The generator then writes the
//! TypeScript clients of what is left, and operations.json, which says what
//! the config says about each operation. For the agent that writes the rest
//! of the gatekeeper, it also writes a guide, and a worksheet of the
//! decisions each operation needs.
//!
//! The clients are those of the TypeScript SDK, with another transport: it
//! sends each request through a provider, which the gatekeeper implements
//! and which has the URL of the API and its credentials, and a method
//! returns the status and headers of its response with the body. Every
//! group has two clients, one of the operations that read and one of those
//! that write.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use forge::{Err, Forge, Json, Location, Method, Plugin, Type};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::ts;
use crate::ts::client::Role;

/// The sources of the runtime library, by path in the generated `_/`: the
/// codecs of the TypeScript SDK's, and errors and a transport of its own.
const RUNTIME: [(&str, &str); 4] = [
    ("codec.ts", include_str!("ts/lib/src/codec.ts")),
    ("error.ts", include_str!("gatekeeper/lib/src/error.ts")),
    ("index.ts", include_str!("gatekeeper/lib/src/index.ts")),
    ("transport.ts", include_str!("gatekeeper/lib/src/transport.ts")),
];

/// The clients of a group: one of the operations that read, for the code
/// of a session, and one of those that write, for the code that applies an
/// approved action. A client does not have the methods of the other, and
/// each is created from a file of its own, so that a lint rule can say
/// which modules may import the one that writes.
const ROLES: [Role; 2] = [
    Role {
        client: "ReadClient",
        bind: "bindRead",
        create: "createReadClient",
        has: reads,
        entry: Some("read.ts"),
    },
    Role {
        client: "WriteClient",
        bind: "bindWrite",
        create: "createWriteClient",
        has: writes,
        entry: Some("write.ts"),
    },
];

/// Reports whether `method` reads, as the config says or else as its HTTP
/// method does.
fn reads(method: Method<'_>) -> bool {
    ts::client::provider_fact(method, "kind").and_then(Json::as_str) == Some(Kind::Read.as_str())
}

fn writes(method: Method<'_>) -> bool {
    !reads(method)
}

/// The extension that carries what the config says about an operation from
/// [`Config::apply`] to the generator.
const EXTENSION: &str = ts::PROVIDER_EXTENSION;

/// The fixed fields of a Path Item Object that are operations.
const METHODS: [&str; 8] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/// The config of a gatekeeper: the operations it covers, and what the
/// document does not say about them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The operations to generate, by `operationId`. Every other operation
    /// is left out.
    operations: BTreeMap<String, Operation>,
    /// Field names for properties whose wire names make no name, or the
    /// same name as another, such as `+1` and `-1`: the field name, by wire
    /// name. It applies to every schema that has the property.
    #[serde(default)]
    properties: BTreeMap<String, String>,
    /// Parameters to leave out of every operation that has them, by name,
    /// such as one that takes a credential. A path parameter cannot be
    /// left out.
    #[serde(default, rename = "omitParameters")]
    omit_parameters: Vec<String>,
    /// What says that a 2XX response is a failure, for an API that answers
    /// one with a 2XX. An operation can have its own.
    failure: Option<Failure>,
    /// What an `int64` is in the generated types: a `bigint` without this,
    /// since a number does not hold every one.
    int64: Option<Int64>,
}

/// What says that a 2XX response is a failure: the property of its body
/// that has this value, which is a string, a number, a boolean or null.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    property: String,
    equals: Value,
}

/// What an `int64` is in the generated types.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Int64 {
    Bigint,
    /// For an API whose `int64`s are counts and positions that a number
    /// holds.
    Number,
}

/// What the config says about an operation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    /// The group path, with dots between group names. Empty for the root.
    #[serde(default)]
    group: String,
    /// The method name.
    name: String,
    /// Whether the operation reads or writes. Without it, GET and HEAD
    /// read, and every other method writes.
    kind: Option<Kind>,
    /// Whether a request can ask for the response only if it has changed,
    /// with `If-None-Match` or `If-Modified-Since`. The method then returns
    /// a 304 response, which is otherwise thrown. Only for an operation
    /// that reads.
    #[serde(default)]
    conditional: bool,
    /// Parameters of the operation to leave out, by name, next to those the
    /// config leaves out of every operation.
    #[serde(default, rename = "omitParameters")]
    omit_parameters: Vec<String>,
    /// What says that a 2XX response of the operation is a failure, in
    /// place of what the config says for every operation.
    failure: Option<Failure>,
    /// How the operation pages, if it does.
    pagination: Option<Pagination>,
}

/// Whether an operation only reads, or changes something.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Read,
    Write,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Read => "read",
            Kind::Write => "write",
        }
    }
}

/// How an operation pages.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pagination {
    style: PaginationStyle,
    /// The property of the response that holds the items, when the
    /// response is not the array of items itself.
    items: Option<String>,
    /// For the style `offset`, the parameter that says how many items to
    /// leave out. It is `offset` without this.
    offset: Option<String>,
    /// The parameter that says how many items a page has at most. For the
    /// style `offset`, it is `limit` without this.
    limit: Option<String>,
    /// For the style `cursor`, the parameter that takes the cursor of the
    /// page to return.
    cursor: Option<String>,
    /// For the style `cursor`, the property of the response that has the
    /// cursor of the next page.
    next: Option<String>,
    /// The property of the response that is true when there is another
    /// page, if it has one.
    more: Option<String>,
    /// The property of the response that is true when the page is the
    /// last, if it has one. A pagination has this or `more`, not both.
    last: Option<String>,
}

impl Pagination {
    /// Returns what the pagination names, by key, in the order
    /// operations.json has them.
    fn names(&self) -> [(&'static str, &Option<String>); 6] {
        [
            ("offset", &self.offset),
            ("limit", &self.limit),
            ("cursor", &self.cursor),
            ("next", &self.next),
            ("more", &self.more),
            ("last", &self.last),
        ]
    }
}

/// How a request asks for the next page.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum PaginationStyle {
    /// With the URL that the `Link` header of a response has as
    /// `rel="next"`.
    LinkHeader,
    /// With the number of items before the page, in a parameter.
    Offset,
    /// With a cursor that the response before it has, in a parameter.
    Cursor,
}

impl PaginationStyle {
    fn as_str(self) -> &'static str {
        match self {
            PaginationStyle::LinkHeader => "link-header",
            PaginationStyle::Offset => "offset",
            PaginationStyle::Cursor => "cursor",
        }
    }
}

impl Config {
    /// Reads the config at `path`.
    pub fn read(path: &Path) -> Result<Config, Err> {
        let parse = || -> Result<Config, Err> { Ok(serde_json::from_slice(&fs::read(path)?)?) };
        parse().map_err(|err| format!("{}: {err}", path.display()).into())
    }

    /// Applies the config to the OpenAPI document `doc`:
    ///
    /// - An operation of the config is named by it, and gets the
    ///   `x-gatekeeper` extension.
    /// - Every other operation gets `x-forge-skip: true`.
    /// - Every operation loses its `x-forge-aliases`, since the config is
    ///   what names methods.
    /// - A property of the config gets its `x-forge-property-name`, unless
    ///   it has one.
    /// - A string loses its `date-time` or `date` format, so that the SDK
    ///   keeps it as the string it is on the wire.
    ///
    /// An operation of the config that the document does not have is an
    /// error, and so is one that writes and is conditional.
    pub fn apply(&self, doc: &mut Value) -> Result<(), Err> {
        let mut found = BTreeSet::new();
        // A path item is under `paths`, or under `components.pathItems` when
        // a path refers to it.
        let parameters = doc.pointer("/components/parameters").cloned();
        let mut omitted = BTreeSet::new();
        for pointer in ["/paths", "/components/pathItems"] {
            let items = doc.pointer_mut(pointer).and_then(Value::as_object_mut);
            for item in items.into_iter().flat_map(Map::values_mut) {
                self.apply_to_path_item(item, parameters.as_ref(), &mut found, &mut omitted)?;
            }
        }
        if let Some(name) = self
            .omit_parameters
            .iter()
            .find(|name| !omitted.contains(name.as_str()))
        {
            return Err(format!("no operation of the config has the parameter {name}").into());
        }
        let missing: Vec<&str> = self
            .operations
            .keys()
            .map(String::as_str)
            .filter(|id| !found.contains(id))
            .collect();
        if !missing.is_empty() {
            return Err(format!("no operation has the operationId {}", missing.join(", ")).into());
        }
        self.apply_to_schemas(doc);
        Ok(())
    }

    /// Names and marks the operations of the path item `item`, and adds to
    /// `found` those that are of the config, and to `omitted` the
    /// parameters that the config leaves out of every operation and that
    /// one of them had. `components` is the `components.parameters` of the
    /// document.
    fn apply_to_path_item<'a>(
        &'a self,
        item: &mut Value,
        components: Option<&Value>,
        found: &mut BTreeSet<&'a str>,
        omitted: &mut BTreeSet<&'a str>,
    ) -> Result<(), Err> {
        // The parameters of the path item are given to each operation, so
        // that one can be left out of an operation and not of the others.
        let shared = match item.as_object_mut().and_then(|item| item.shift_remove("parameters")) {
            Some(Value::Array(shared)) => shared,
            _ => Vec::new(),
        };
        for method in METHODS {
            let Some(operation) = item.get_mut(method).and_then(Value::as_object_mut) else {
                continue;
            };
            let mut parameters = match operation.shift_remove("parameters") {
                Some(Value::Array(own)) => merged(&shared, own, components),
                _ => shared.clone(),
            };
            // An alias is a method even when its operation is skipped.
            operation.shift_remove("x-forge-aliases");
            let id = operation.get("operationId").and_then(Value::as_str);
            let Some((id, selected)) = id.and_then(|id| self.operations.get_key_value(id)) else {
                operation.insert("x-forge-skip".to_owned(), Value::Bool(true));
                operation.insert("parameters".to_owned(), Value::Array(parameters));
                continue;
            };
            found.insert(id.as_str());
            for name in &self.omit_parameters {
                if omit(&mut parameters, name, id, components)? {
                    omitted.insert(name.as_str());
                }
            }
            for name in &selected.omit_parameters {
                if !omit(&mut parameters, name, id, components)? {
                    return Err(format!("{id} has no parameter {name}").into());
                }
            }
            // The config is what says which operations there are.
            operation.shift_remove("x-forge-skip");
            operation.insert("x-forge-group-name".to_owned(), json!(selected.group));
            operation.insert("x-forge-method-name".to_owned(), json!(selected.name));
            let mut extension = selected.extension(id, method)?;
            if let Some(failure) = selected.failure.as_ref().or(self.failure.as_ref()) {
                if failure.equals.is_array() || failure.equals.is_object() {
                    return Err(format!(
                        "{id}: the failure of a response equals a string, a number, a boolean or null"
                    )
                    .into());
                }
                extension["failure"] = json!({"property": failure.property, "equals": failure.equals});
            }
            let headers = headers(&parameters, components);
            if !headers.is_empty() {
                extension["headers"] = Value::Array(headers);
            }
            operation.insert(EXTENSION.to_owned(), extension);
            operation.insert("parameters".to_owned(), Value::Array(parameters));
        }
        Ok(())
    }

    /// Names the properties of the config, and removes the formats of dates
    /// and, when the config says so, of `int64`s, in `value` and everything
    /// inside it.
    fn apply_to_schemas(&self, value: &mut Value) {
        match value {
            Value::Object(map) => {
                // A type is a string, or since OpenAPI 3.1 an array of them,
                // as for a string that can be null.
                let is = |name: &str| match map.get("type") {
                    Some(Value::String(ty)) => ty == name,
                    Some(Value::Array(types)) => types.iter().any(|ty| ty == name),
                    _ => false,
                };
                let remove = match map.get("format").and_then(Value::as_str) {
                    Some("date-time" | "date") => is("string"),
                    // Without its format, an integer is a number.
                    Some("int64") => is("integer") && self.int64 == Some(Int64::Number),
                    _ => false,
                };
                if remove {
                    map.shift_remove("format");
                }
                for (key, value) in map.iter_mut() {
                    match value {
                        // The keys of `properties` are the names of
                        // properties, not keywords of a schema: one can be
                        // named `properties` or `format`.
                        Value::Object(properties) if key == "properties" => {
                            for (wire_name, name) in &self.properties {
                                if let Some(Value::Object(property)) = properties.get_mut(wire_name) {
                                    property.entry("x-forge-property-name").or_insert_with(|| json!(name));
                                }
                            }
                            for property in properties.values_mut() {
                                self.apply_to_schemas(property);
                            }
                        }
                        value => self.apply_to_schemas(value),
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.apply_to_schemas(value);
                }
            }
            _ => {}
        }
    }
}

/// Returns the parameter that `parameter` is or refers to, in
/// `components`, which is the `components.parameters` of the document.
fn resolved<'a>(parameter: &'a Value, components: Option<&'a Value>) -> Option<&'a Value> {
    match parameter.get("$ref").and_then(Value::as_str) {
        Some(reference) => reference
            .strip_prefix("#/components/parameters/")
            .and_then(|name| components?.get(name)),
        None => Some(parameter),
    }
}

/// Returns the name and the location of `parameter`.
fn named<'a>(parameter: &'a Value, components: Option<&'a Value>) -> Option<(&'a str, &'a str)> {
    let parameter = resolved(parameter, components)?;
    Some((parameter.get("name")?.as_str()?, parameter.get("in")?.as_str()?))
}

/// Returns the parameters of an operation: those of its path item,
/// `shared`, that it does not have itself, then its `own`.
fn merged(shared: &[Value], own: Vec<Value>, components: Option<&Value>) -> Vec<Value> {
    let mut parameters: Vec<Value> = shared
        .iter()
        .filter(|parameter| {
            let name = named(parameter, components);
            name.is_none() || !own.iter().any(|own| named(own, components) == name)
        })
        .cloned()
        .collect();
    parameters.extend(own);
    parameters
}

/// Removes the parameters named `name` from `parameters`, which are those
/// of the operation `id`, and reports whether there was one. A path
/// parameter cannot be removed, since the path has it.
fn omit(parameters: &mut Vec<Value>, name: &str, id: &str, components: Option<&Value>) -> Result<bool, Err> {
    let is = |parameter: &Value| named(parameter, components).is_some_and(|(other, _)| other == name);
    if parameters
        .iter()
        .any(|parameter| is(parameter) && named(parameter, components).is_some_and(|(_, location)| location == "path"))
    {
        return Err(format!("{id}: {name} is a path parameter, which cannot be left out").into());
    }
    let before = parameters.len();
    parameters.retain(|parameter| !is(parameter));
    Ok(parameters.len() != before)
}

/// Returns the header parameters among `parameters`, which are those of an
/// operation: each with its `name`, whether it is `required`, and its
/// `default` if it has one. The model of the API has no header parameters,
/// so a request type has none, and this is how a gatekeeper learns of
/// them. `components` is the `components.parameters` that a parameter can
/// refer to.
///
/// `Content-Type` and `Authorization` are left out, as OpenAPI says to.
/// It says so of `Accept` too, which is kept: an API can ask for a media
/// type of its own in it, as a version.
fn headers(parameters: &[Value], components: Option<&Value>) -> Vec<Value> {
    let mut headers: Vec<Value> = Vec::new();
    for parameter in parameters {
        let Some(parameter) = resolved(parameter, components) else {
            continue;
        };
        let Some(name) = parameter.get("name").and_then(Value::as_str) else {
            continue;
        };
        let ignored = ["content-type", "authorization"]
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored));
        if parameter.get("in").and_then(Value::as_str) != Some("header") || ignored {
            continue;
        }
        let mut header = json!({
            "name": name,
            "required": parameter.get("required").and_then(Value::as_bool).unwrap_or(false),
        });
        if let Some(default) = parameter.pointer("/schema/default") {
            header["default"] = default.clone();
        }
        headers.push(header);
    }
    headers
}

impl Operation {
    /// Returns the `x-gatekeeper` extension of the operation `id`, whose
    /// field in the Path Item Object is `method`.
    fn extension(&self, id: &str, method: &str) -> Result<Value, Err> {
        let kind = self.kind.unwrap_or(match method {
            "get" | "head" => Kind::Read,
            _ => Kind::Write,
        });
        // The client of reads is what the code of a session has, and a read
        // can be sent twice. Only a POST can be said to read, as a search
        // or a query is.
        if kind == Kind::Read && !matches!(method, "get" | "head" | "post") {
            return Err(format!("{id} is sent with {}, so it cannot be a read", method.to_uppercase()).into());
        }
        // A client that has a `then` is taken for a promise when awaited.
        if self.name == "then" {
            return Err(format!("{id} cannot be named then").into());
        }
        let mut extension = json!({"operationId": id, "kind": kind.as_str()});
        if self.conditional {
            if kind == Kind::Write {
                return Err(format!("{id} writes, so it cannot be conditional").into());
            }
            extension["conditional"] = json!(true);
        }
        if self.pagination.is_some() && kind == Kind::Write {
            return Err(format!("{id} writes, so it cannot have pagination").into());
        }
        if let Some(pagination) = &self.pagination {
            let mut value = json!({"style": pagination.style.as_str()});
            if let Some(items) = &pagination.items {
                value["items"] = json!(items);
            }
            let style = pagination.style;
            let (allowed, needed, defaults): (&[&str], &[&str], &[&str]) = match style {
                PaginationStyle::LinkHeader => (&[], &[], &[]),
                PaginationStyle::Offset => (&["offset", "limit", "more", "last"], &[], &["offset", "limit"]),
                PaginationStyle::Cursor => (&["cursor", "next", "limit", "more", "last"], &["cursor", "next"], &[]),
            };
            if pagination.more.is_some() && pagination.last.is_some() {
                return Err(format!("{id}: a pagination has more or last, not both").into());
            }
            for (key, name) in pagination.names() {
                match name {
                    Some(_) if !allowed.contains(&key) => {
                        let style = style.as_str();
                        return Err(format!("{id}: {key} is not for pagination of the style {style}").into());
                    }
                    Some(name) => value[key] = json!(name),
                    None if needed.contains(&key) => {
                        return Err(format!("{id} pages by {}, so its pagination needs {key}", style.as_str()).into());
                    }
                    // A parameter that has the name of its key by default.
                    None if defaults.contains(&key) => value[key] = json!(key),
                    None => {}
                }
            }
            extension["pagination"] = value;
        }
        Ok(extension)
    }
}

/// Generates the files of a gatekeeper from a document a [`Config`] was
/// applied to.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the TypeScript clients, then operations.json,
    /// the guide and the worksheet.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let text = |path: &str, content: String| File::Text {
            path: path.to_owned(),
            content,
        };
        let texts = [
            text("operations.json", manifest(forge)?),
            text("GUIDE.md", GUIDE.to_owned()),
            text("WORKSHEET.md", worksheet(forge)),
        ];
        let clients = ts::generate(forge, ts::Transport::Provider, &ROLES, &RUNTIME)?;
        Ok(clients.map(File::Sdk).chain(texts))
    }
}

/// The guide for the agent that writes the gatekeeper: what the generated
/// files change in the steps of the kit's `write-gatekeeper` skill.
const GUIDE: &str = include_str!("gatekeeper/GUIDE.md");

/// Returns WORKSHEET.md, for an agent to fill in and a person to review:
/// the decisions the spec cannot make. The questions every read has are
/// asked once, before the operations that read, each of which has the
/// questions that are its own. The operations that write follow, in the
/// same way.
fn worksheet(forge: &Forge) -> String {
    let methods: Vec<Method<'_>> = forge.groups().flat_map(|group| group.methods()).collect();
    let mut text = String::from(WORKSHEET_INTRO);
    text.push_str(WORKSHEET_READS);
    for &method in methods.iter().filter(|&&method| reads(method)) {
        heading(&mut text, method, "reads");
        text.push_str(ANSWERS);
        if method.http_method().as_str() == "POST" {
            text.push_str(
                "- It is sent with `POST`, and the config says it reads. Why it changes nothing and can be sent twice:\n",
            );
        }
        let fact = |key| ts::client::provider_fact(method, key);
        if fact("conditional").and_then(Json::as_bool) == Some(true) {
            text.push_str(
                "- It is conditional. Whether its cache revalidates with the `ETag`, and where that is kept:\n",
            );
        }
        // The manifest has already said what is wrong with a pagination.
        if let Some(Ok(pagination)) = fact("pagination").map(|pagination| paging(method, "", pagination)) {
            text.push_str(&paging_line(&pagination));
        }
        text.push_str(&response_lines(method));
        text.push_str(&headers_line(method));
    }
    text.push_str(WORKSHEET_WRITES);
    for &method in methods.iter().filter(|&&method| writes(method)) {
        heading(&mut text, method, "writes");
        text.push_str(ANSWERS);
        if method.http_method().as_str() == "DELETE" {
            text.push_str(
                "- It is sent with `DELETE`, so rule 1 of the skill's opt-out policy (it deletes or removes content) applies to question 5. Why not, if its `autoApprovable` is `true`:\n",
            );
        }
        text.push_str(&response_lines(method));
        text.push_str(&headers_line(method));
    }
    text
}

/// Returns the line of the worksheet about how an operation pages, from
/// what operations.json says of it.
fn paging_line(pagination: &Value) -> String {
    let string = |key: &str| pagination.get(key).and_then(Value::as_str);
    let items = match string("field") {
        Some(field) => format!("the items are in `data.{field}`"),
        None => "the response is the array of items".to_owned(),
    };
    let end = match (string("more"), string("last")) {
        (Some(more), _) => format!("`data.{more}` is true when there is another page"),
        (_, Some(last)) => format!("`data.{last}` is true when the page is the last"),
        _ => "nothing in the response says whether there is another page".to_owned(),
    };
    let limit = match string("limit") {
        Some(limit) => format!(" and `{limit}`"),
        None => String::new(),
    };
    let how = match (string("offset"), string("cursor"), string("next")) {
        (Some(offset), _, _) => format!("a call asks for a page with `{offset}`{limit}, {items}, and {end}"),
        (_, Some(cursor), Some(next)) => format!(
            "a call asks for the next page with `{cursor}`, set to the `data.{next}` of the page before{limit}, {items}, and {end}"
        ),
        _ => items,
    };
    let style = string("style").unwrap_or_default();
    format!("- Paging: it pages by `{style}`: {how}. The kit cursor that wraps it, and what each page reports:\n")
}

/// Returns the lines of the worksheet about what a response of `method`
/// is: that its body can say it failed, and that the document gives its
/// body no type.
fn response_lines(method: Method<'_>) -> String {
    let mut text = String::new();
    let failure = ts::client::provider_fact(method, "failure");
    if let Some(property) = failure.and_then(|failure| failure.get("property")?.as_str()) {
        text.push_str(&format!(
            "- A 2XX response fails when its `{property}` says so, and is thrown with that status. What in its body tells a denial from what is indeterminate:\n"
        ));
    }
    if untyped(method) {
        text.push_str(
            "- The document gives its response no type, so `data` is what the provider sent, with the provider's names. What you check of it before you map it:\n",
        );
    }
    text
}

/// Returns the line of the worksheet about the header parameters of
/// `method`, or nothing when it declares none.
fn headers_line(method: Method<'_>) -> String {
    let headers = ts::client::provider_fact(method, "headers").and_then(Json::as_array);
    let headers: Vec<String> = headers
        .into_iter()
        .flatten()
        .map(|header| {
            let name = header.get("name").and_then(Json::as_str).unwrap_or_default();
            let mut notes = Vec::new();
            if header.get("required").and_then(Json::as_bool) == Some(true) {
                notes.push("required".to_owned());
            }
            if let Some(default) = header.get("default").and_then(Json::as_str) {
                notes.push(format!("`{default}` by default"));
            }
            if notes.is_empty() {
                format!("`{name}`")
            } else {
                format!("`{name}` ({})", notes.join(", "))
            }
        })
        .collect();
    if headers.is_empty() {
        return String::new();
    }
    format!(
        "- Headers it declares, which its request type does not have and the clients do not send: {}. For each, its value, and whether the provider sets it or each call does:\n",
        headers.join(", ")
    )
}

/// Prints the heading of `method` in the worksheet: how the client named
/// `client` calls it, its `operationId`, its request line and its summary.
fn heading(text: &mut String, method: Method<'_>, client: &str) {
    let mut call: Vec<String> = method.group().path().map(|name| name.camel()).collect();
    call.push(method.name().camel());
    let id = ts::client::provider_fact(method, "operationId")
        .and_then(Json::as_str)
        .unwrap_or_default();
    text.push_str(&format!("\n### `{client}.{}`\n\n", call.join(".")));
    text.push_str(&format!(
        "`{id}`: `{} {}`\n",
        method.http_method().as_str(),
        method.path()
    ));
    let summary = method.summary().trim();
    if !summary.is_empty() {
        text.push_str(&format!("\n{}\n", summary.replace('\n', " ")));
    }
    text.push('\n');
}

/// The line of an operation in the worksheet for its answers to the
/// questions of its section.
const ANSWERS: &str = "- Answers, by number, that are not among the shared ones:\n";

const WORKSHEET_INTRO: &str = "\
# Worksheet

Forge generated this list from the config of the gatekeeper. It has every operation the generated clients cover, with what the spec cannot decide about it. GUIDE.md says how to use it.

Copy this file out of the generated directory before you fill it in: this copy is replaced each time Forge runs. A person reviews the answers with `types.d.ts`.

Each section asks its questions once, and then lists its operations. Give an answer that several operations share once, under the shared answers, and say which operations it covers. Under an operation, give the answers that are its own, and answer the lines that only it has. Leave no question without an answer for any operation: \"none\" is an answer.
";

const WORKSHEET_READS: &str = "
## Reads

An operation that reads is called from session code, through the client of reads. The observation is authorized once for each session method, not for each operation, so one answer often covers several of these.

For every read:

1. Request fields the binding fixes, and those a caller gives, with how each of those is checked.
2. Session methods that return its data. Or that it only prepares an action, and is not an observation.
3. Subresources each of those methods reports.
4. How `verifyObserverAccess` checks each kind of those for an observer, or that the data is private-only.
5. Whether the observation sets `containsRestrictedData` or `ownerInvitesOnly`.
6. Statuses and bodies that mean no access, and those that are indeterminate and are thrown again.
7. Cache: a TTL or none, and what the cache is partitioned by.

### Shared answers
";

const WORKSHEET_WRITES: &str = "
## Writes

An operation that writes is called only from the apply handler of an action, through the client of writes. One operation can serve several actions, and one action can call several operations.

For every write:

1. Request fields the binding fixes, and those a caller gives, with how each of those is checked.
2. Session methods that stage it.
3. Action definitions, by name. A name is permanent once it ships.
4. Kind of each, as a tag and a label a user would enable, such as \"Edit labels\".
5. `autoApprovable` of each: `true`, or `false` with the number of the rule of the skill's opt-out policy. Check each of its seven rules, such as passing a governance gate or changing permissions, and not only deletion.
6. What the description shows the person who approves, and the reads that build it.
7. How reads show it while it is pending.
8. What a second attempt does, and what a timeout means.
9. Revert, if it has one.

### Shared answers
";

/// Returns operations.json: the methods in the order of their groups, each
/// with where the SDK has it, its request line, and what the config says.
fn manifest(forge: &Forge) -> Result<String, Err> {
    let mut operations = Vec::new();
    for method in forge.groups().flat_map(|group| group.methods()) {
        operations.push(entry(method)?);
    }
    let mut text = serde_json::to_string_pretty(&json!({"operations": operations}))?;
    text.push('\n');
    Ok(text)
}

/// Returns the entry of `method` in operations.json.
fn entry(method: Method<'_>) -> Result<Value, Err> {
    let group: Vec<String> = method.group().path().map(|name| name.camel()).collect();
    let name = method.name().camel();
    let request_line = format!("{} {}", method.http_method().as_str(), method.path());
    let Some(extension) = method.extension(EXTENSION) else {
        return Err(format!("{request_line} is not an operation of the config").into());
    };
    let string = |value: &Json, key: &str| value.get(key).and_then(Json::as_str).map(str::to_owned);
    let id = string(extension, "operationId").unwrap_or_default();
    if ts::client::skipped(method) {
        return Err(format!(
            "{id} ({request_line}) has a body or a response that is not JSON, which the SDK leaves out: remove it from the config"
        )
        .into());
    }
    let mut entry = json!({
        "operationId": id,
        "group": group,
        "name": name,
        "method": method.http_method().as_str(),
        "path": method.path(),
        "kind": string(extension, "kind"),
    });
    if extension.get("conditional").and_then(Json::as_bool) == Some(true) {
        entry["conditional"] = json!(true);
    }
    if let Some(headers) = extension.get("headers").and_then(Json::as_array) {
        let headers = headers.iter().map(|header| {
            let mut value = json!({
                "name": string(header, "name"),
                "required": header.get("required").and_then(Json::as_bool),
            });
            if let Some(default) = string(header, "default") {
                value["default"] = json!(default);
            }
            value
        });
        entry["headers"] = headers.collect();
    }
    if let Some(pagination) = extension.get("pagination") {
        entry["pagination"] = paging(method, &id, pagination)?;
    }
    if let Some(failure) = extension.get("failure") {
        entry["failure"] = json!({"property": string(failure, "property")});
    }
    if untyped(method) {
        entry["untyped"] = json!(true);
    }
    Ok(entry)
}

/// Returns how the operation `id` of `method` pages, for operations.json,
/// from the `pagination` of its extension, which has the names the API
/// uses. Next to `items` it gives `field`, the generated field that holds
/// them. In place of every other name it gives the generated field: of the
/// request for `offset`, `limit` and `cursor`, and of the response for
/// `next`, `more` and `last`, with dots between the fields of a path.
///
/// It is an error when the operation does not have what its pagination
/// names.
fn paging(method: Method<'_>, id: &str, pagination: &Json) -> Result<Value, Err> {
    let string = |key: &str| pagination.get(key).and_then(Json::as_str);
    let style = string("style").unwrap_or_default();
    let mut value = json!({"style": style});
    let items = string("items");
    match (items, response_field(method, items, true)) {
        (_, None) => {
            let what = match items {
                Some(items) => format!("an array in the property {items}"),
                None => "an array".to_owned(),
            };
            return Err(format!("{id} pages, but no response of it is {what}").into());
        }
        (Some(items), Some(field)) => {
            value["items"] = json!(items);
            value["field"] = json!(field);
        }
        (None, Some(_)) => {}
    }
    for key in ["offset", "limit", "cursor"] {
        if let Some(name) = string(key) {
            let Some(field) = request_field(method, name) else {
                return Err(format!("{id} pages by {style}, but has no parameter {name}").into());
            };
            value[key] = json!(field);
        }
    }
    for key in ["next", "more", "last"] {
        if let Some(name) = string(key) {
            let Some(field) = response_field(method, Some(name), false) else {
                return Err(format!("{id} pages by {style}, but no response of it has the property {name}").into());
            };
            value[key] = json!(field);
        }
    }
    Ok(value)
}

/// Returns the type that `ty` is, when it is a model.
fn resolved_type(ty: Type<'_>) -> Type<'_> {
    match ty {
        Type::Model(model) => resolved_type(model.ty()),
        ty => ty,
    }
}

/// What a type has to find a property in.
enum Shape<'f> {
    /// The fields of an object, or of the members of an `allOf`, which is
    /// how an API adds the items to what every page has.
    Fields(Vec<forge::Field<'f>>),
    /// Nothing: the document does not say what the value is, or says only
    /// that it is an object. The clients leave such a value as it is, so a
    /// property of it has its wire name.
    Untyped,
    /// A type that has no properties, such as a string.
    Other,
}

/// Returns the shape of `ty`. A type that can also be null has the shape
/// of what it is otherwise.
fn shape(ty: Type<'_>) -> Shape<'_> {
    match resolved_type(ty) {
        Type::Scalar(forge::Scalar::Unknown) => Shape::Untyped,
        Type::Object(object) if object.fields().len() == 0 => Shape::Untyped,
        Type::Object(object) => Shape::Fields(object.fields().collect()),
        Type::Intersection(intersection) => {
            let mut all = Vec::new();
            for member in intersection.members() {
                if let Shape::Fields(fields) = shape(member) {
                    all.extend(fields);
                }
            }
            if all.is_empty() {
                Shape::Untyped
            } else {
                Shape::Fields(all)
            }
        }
        Type::Union(union) => {
            let mut members = union
                .members()
                .filter(|&member| !matches!(resolved_type(member), Type::Scalar(forge::Scalar::Null)));
            match (members.next(), members.next()) {
                (Some(member), None) => shape(member),
                _ => Shape::Other,
            }
        }
        _ => Shape::Other,
    }
}

/// Reports whether a response of `method` has a body that the document
/// gives no type: the clients return it as the provider sent it.
fn untyped(method: Method<'_>) -> bool {
    let (types, _) = ts::client::response(method);
    types.into_iter().any(|ty| matches!(shape(ty), Shape::Untyped))
}

/// Returns the name of the field, in the request of `method`, of the
/// parameter or the property of the body whose wire name is `wire_name`.
/// It is the name the clients give the field, unless another has the same.
fn request_field(method: Method<'_>, wire_name: &str) -> Option<String> {
    // The parameters are the fields of the request, or of its first member
    // when a body is next to them.
    let parameters = match method.request()? {
        Type::Object(object) => Some(object),
        Type::Intersection(intersection) => match intersection.members().next()? {
            Type::Object(object) => Some(object),
            _ => None,
        },
        _ => None,
    };
    let parameter = parameters
        .into_iter()
        .flat_map(|object| object.fields())
        .find(|&field| {
            field.wire_name() == wire_name && matches!(method.location(field), Some(Location::Query { .. }))
        });
    if let Some(field) = parameter {
        return Some(field.name().camel());
    }
    let body = method.body()?.json()?.ty();
    match shape(body) {
        Shape::Fields(fields) => fields
            .into_iter()
            .find(|field| field.wire_name() == wire_name)
            .map(|field| field.name().camel()),
        Shape::Untyped => Some(wire_name.to_owned()),
        Shape::Other => None,
    }
}

/// Returns the fields that lead to the property `property` in a response
/// of `method`, with dots between them. `property` is the wire names that
/// lead to it, with dots between them, such as
/// `response_metadata.next_cursor`. With `array`, the property is an array.
/// Without `property`, it is empty when the response is itself an array.
/// `None` when no response has it.
///
/// Under a value the document gives no type, a property is taken to be
/// there, with its wire name.
fn response_field(method: Method<'_>, property: Option<&str>, array: bool) -> Option<String> {
    let (types, _) = ts::client::response(method);
    types.into_iter().find_map(|ty| {
        let Some(property) = property else {
            return matches!(resolved_type(ty), Type::Array(_)).then(String::new);
        };
        // The type the path has reached, or `None` under an untyped value.
        let mut at = Some(ty);
        let mut names = Vec::new();
        for wire_name in property.split('.') {
            match at.map(shape) {
                Some(Shape::Fields(fields)) => {
                    let field = fields.into_iter().find(|field| field.wire_name() == wire_name)?;
                    names.push(field.name().camel());
                    at = Some(field.ty());
                }
                Some(Shape::Untyped) | None => {
                    names.push(wire_name.to_owned());
                    at = None;
                }
                Some(Shape::Other) => return None,
            }
        }
        let is_array =
            at.is_none_or(|ty| matches!(resolved_type(ty), Type::Array(_) | Type::Scalar(forge::Scalar::Unknown)));
        (!array || is_array).then(|| names.join("."))
    })
}

/// A file of a gatekeeper.
pub enum File {
    /// A file of the TypeScript clients.
    Sdk(ts::File),
    /// A file written as it is.
    Text { path: String, content: String },
}

impl forge::File for File {
    fn path(&self) -> &str {
        match self {
            File::Sdk(f) => forge::File::path(f),
            File::Text { path, .. } => path,
        }
    }

    fn content(&self) -> Result<Cow<'_, [u8]>, Err> {
        match self {
            File::Sdk(f) => forge::File::content(f),
            File::Text { content, .. } => Ok(Cow::Borrowed(content.as_bytes())),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use forge::{Forge, Plugin};
    use serde_json::Value;

    use super::{Config, Generator};

    /// A document with operations of each kind, among them one that is
    /// skipped and one of a path item that a path refers to, a property
    /// named `+1` and dates.
    const SPEC: &str = r##"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/issues": {
          "get": {
            "operationId": "issues/list",
            "parameters": [
              {"name": "title.contains", "in": "query", "schema": {"type": "string"}}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/issue"}
              }}}}
            }
          },
          "post": {
            "operationId": "issues/create",
            "x-forge-aliases": [{"x-forge-method-name": "open"}],
            "responses": {"204": {"description": "ok"}}
          }
        },
        "/search": {
          "post": {
            "operationId": "search/issues",
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "$ref": "#/components/schemas/reactions"
              }}}}
            }
          }
        },
        "/logs": {
          "get": {
            "operationId": "logs/get",
            "responses": {"200": {"description": "ok", "content": {"text/plain": {"schema": {"type": "string"}}}}}
          }
        },
        "/issues/{id}": {
          "delete": {
            "operationId": "issues/delete",
            "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
            "responses": {"204": {"description": "ok"}}
          }
        },
        "/runs": {
          "get": {
            "operationId": "runs/list",
            "x-forge-skip": true,
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "object",
                "properties": {
                  "total": {"type": "integer"},
                  "work_runs": {"type": "array", "items": {"$ref": "#/components/schemas/issue"}}
                }
              }}}}
            }
          }
        },
        "/incidents": {
          "parameters": [
            {
              "name": "Accept",
              "in": "header",
              "required": true,
              "schema": {"type": "string", "default": "application/vnd.t+json;version=2"}
            },
            {"name": "Content-Type", "in": "header", "schema": {"type": "string"}}
          ],
          "get": {
            "operationId": "incidents/list",
            "parameters": [
              {"name": "offset", "in": "query", "schema": {"type": "integer"}},
              {"name": "page_size", "in": "query", "schema": {"type": "integer"}},
              {"$ref": "#/components/parameters/from"}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "allOf": [
                  {"$ref": "#/components/schemas/page"},
                  {
                    "type": "object",
                    "properties": {"incidents": {"type": "array", "items": {"$ref": "#/components/schemas/issue"}}}
                  }
                ]
              }}}}
            }
          }
        },
        "/messages": {
          "parameters": [{"name": "token", "in": "query", "schema": {"type": "string"}}],
          "get": {
            "operationId": "messages/list",
            "parameters": [
              {"name": "cursor", "in": "query", "schema": {"type": "string"}},
              {"name": "limit", "in": "query", "schema": {"type": "integer", "format": "int64"}}
            ],
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {
                "type": "object",
                "properties": {
                  "ok": {"type": "boolean"},
                  "messages": {"type": "array", "items": {"$ref": "#/components/schemas/issue"}},
                  "is_last": {"type": "boolean"},
                  "meta": {"type": "object", "properties": {"next_cursor": {"type": "string"}}}
                }
              }}}}
            }
          },
          "post": {
            "operationId": "messages/query",
            "requestBody": {"content": {"application/json": {"schema": {
              "type": "object",
              "properties": {"start_cursor": {"type": "string"}, "text": {"type": "string"}}
            }}}},
            "responses": {
              "200": {"description": "ok", "content": {"application/json": {"schema": {"type": "object"}}}}
            }
          }
        },
        "/shared": {"$ref": "#/components/pathItems/shared"}
      },
      "components": {
        "parameters": {
          "from": {"name": "From", "in": "header", "schema": {"type": "string"}}
        },
        "pathItems": {
          "shared": {
            "get": {"operationId": "shared/get", "responses": {"204": {"description": "ok"}}}
          }
        },
        "schemas": {
          "issue": {
            "type": "object",
            "properties": {
              "created_at": {"type": "string", "format": "date-time"},
              "closed_at": {"type": ["string", "null"], "format": "date-time"},
              "properties": {"type": "object", "properties": {"format": {"type": "string"}}},
              "reactions": {"$ref": "#/components/schemas/reactions"}
            }
          },
          "reactions": {
            "type": "object",
            "properties": {
              "+1": {"type": "integer"},
              "-1": {"type": "integer"}
            }
          },
          "page": {"type": "object", "properties": {"has_more": {"type": "boolean"}}},
          "unused": {"type": "object", "properties": {"day": {"type": "string", "format": "date"}}}
        }
      }
    }"##;

    /// A config for [`SPEC`] that leaves `issues/create` out.
    const CONFIG: &str = r#"{
      "operations": {
        "issues/list": {
          "group": "issues",
          "name": "list",
          "pagination": {"style": "link-header"}
        },
        "search/issues": {"group": "issues", "name": "search", "kind": "read"}
      },
      "properties": {"+1": "plus_one", "-1": "minus_one"}
    }"#;

    /// Returns the files generated for [`SPEC`] with `config` applied, by
    /// path.
    fn generate(config: &str) -> Result<BTreeMap<String, String>, String> {
        let config: Config = serde_json::from_str(config).map_err(|err| err.to_string())?;
        let mut doc: Value = serde_json::from_str(SPEC).unwrap();
        config.apply(&mut doc).map_err(|err| err.to_string())?;
        let forge: Forge = serde_json::from_value(doc).map_err(|err| err.to_string())?;
        let files = Generator.generate(&forge).map_err(|err| err.to_string())?;
        Ok(files
            .map(|file| {
                let content = forge::File::content(&file).unwrap().into_owned();
                (forge::File::path(&file).to_owned(), String::from_utf8(content).unwrap())
            })
            .filter(|(_, content)| !content.is_empty())
            .collect())
    }

    /// Every source of the runtime library is embedded, and so are the
    /// sources of the TypeScript SDK's that they import.
    #[test]
    fn runtime_is_complete() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/forge/gatekeeper/lib/src");
        let mut own: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        own.push("codec.ts".to_owned());
        own.sort();
        let embedded: Vec<&str> = super::RUNTIME.iter().map(|&(path, _)| path).collect();
        assert_eq!(own, embedded);
        for (path, source) in super::RUNTIME {
            for import in source.lines().filter_map(|line| line.split(" from './").nth(1)) {
                let file = import.trim_end_matches("';").replace(".js", ".ts");
                assert!(embedded.contains(&file.as_str()), "{path} imports {file}");
            }
        }
    }

    #[test]
    fn the_clients_send_through_a_provider() {
        let files = generate(CONFIG).unwrap();
        let client = &files["issues/client.ts"];
        assert!(
            client.contains("export type ClientOptions = BaseClientOptions;"),
            "{client}"
        );
        assert!(!client.contains("baseUrl"), "{client}");
        let index = &files["issues/index.ts"];
        assert!(
            index.contains("  Provider,\n  ProviderRequest,\n  ProviderResponse,\n  RequestOptions,\n  Result,\n"),
            "{index}"
        );
        assert!(index.contains("  ApiError,\n  DecodeError,\n"), "{index}");
        assert!(
            client.contains("const ListOperation: Operation = {\n  id: \"issues/list\",\n  kind: \"read\",\n"),
            "{client}"
        );
        let transport = &files["_/transport.ts"];
        assert!(transport.contains("export interface Provider {"), "{transport}");
        assert!(!files.contains_key("_/hooks/envelope.ts"));
    }

    #[test]
    fn the_worksheet_has_the_decisions_of_each_operation() {
        let config = r#"{
          "operations": {
            "issues/list": {
              "group": "issues",
              "name": "list",
              "conditional": true,
              "pagination": {"style": "link-header"}
            },
            "runs/list": {
              "group": "runs",
              "name": "list",
              "pagination": {"style": "link-header", "items": "work_runs"}
            },
            "issues/create": {"group": "issues", "name": "create"},
            "issues/delete": {"group": "issues", "name": "delete"},
            "search/issues": {"group": "issues", "name": "search", "kind": "read"}
          },
          "properties": {"+1": "plus_one", "-1": "minus_one"}
        }"#;
        let files = generate(config).unwrap();
        let worksheet = &files["WORKSHEET.md"];
        let (reads, writes) = worksheet.split_once("\n## Writes\n").unwrap();
        assert!(
            reads.contains("### `reads.issues.list`\n\n`issues/list`: `GET /issues`\n"),
            "{reads}"
        );
        assert_eq!(reads.matches("- It is conditional.").count(), 1, "{reads}");
        assert!(
            reads.contains("- Paging: it pages by `link-header`: the response is the array of items."),
            "{reads}"
        );
        assert!(
            reads.contains("- Paging: it pages by `link-header`: the items are in `data.workRuns`."),
            "{reads}"
        );
        // A read that is not sent with GET is asked why it is one.
        let search = &reads[reads.find("### `reads.issues.search`").unwrap()..];
        assert!(
            search.contains("- It is sent with `POST`, and the config says it reads."),
            "{search}"
        );
        assert_eq!(reads.matches("- It is sent with `POST`").count(), 1, "{reads}");
        // The questions every read has are asked once.
        assert_eq!(
            reads.matches("1. Request fields the binding fixes").count(),
            1,
            "{reads}"
        );
        assert_eq!(reads.matches("- Answers, by number").count(), 3, "{reads}");
        assert!(reads.contains("4. How `verifyObserverAccess` checks"), "{reads}");
        assert!(!reads.contains("issues.create"), "{reads}");
        assert!(
            writes.contains("### `writes.issues.create`\n\n`issues/create`: `POST /issues`\n"),
            "{writes}"
        );
        assert!(
            writes
                .matches("5. `autoApprovable` of each: `true`, or `false`")
                .count()
                == 1,
            "{writes}"
        );
        let delete = &writes[writes.find("### `writes.issues.delete`").unwrap()..];
        assert!(delete.contains("It is sent with `DELETE`, so rule 1"), "{delete}");
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        let runs = operations["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["operationId"] == "runs/list")
            .unwrap();
        assert_eq!(
            runs["pagination"],
            serde_json::json!({"style": "link-header", "items": "work_runs", "field": "workRuns"})
        );
        assert!(files["GUIDE.md"].starts_with("# Building a gatekeeper on these files\n"));
    }

    #[test]
    fn a_conditional_operation_returns_a_304() {
        let config = r#"{
          "operations": {
            "issues/list": {"group": "issues", "name": "list", "conditional": true},
            "search/issues": {"group": "issues", "name": "search", "kind": "read"}
          },
          "properties": {"+1": "plus_one", "-1": "minus_one"}
        }"#;
        let files = generate(config).unwrap();
        let client = &files["issues/client.ts"];
        assert!(
            client.contains("options?: RequestOptions): Promise<Result<ListResponse> | NotModified>;"),
            "{client}"
        );
        assert!(
            client.contains("list: (request, options) => transport.sendConditional(ListOperation, request, options),"),
            "{client}"
        );
        assert!(
            client.contains("search: (request, options) => transport.send(SearchOperation, request, options),"),
            "{client}"
        );
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(operations["operations"][0]["conditional"], true);
        assert_eq!(operations["operations"][1].get("conditional"), None);
    }

    #[test]
    fn an_operation_that_writes_cannot_be_conditional() {
        let config = r#"{
          "operations": {
            "issues/create": {"group": "issues", "name": "create", "conditional": true}
          }
        }"#;
        assert_eq!(
            generate(config).unwrap_err(),
            "issues/create writes, so it cannot be conditional"
        );
    }

    #[test]
    fn a_group_has_a_client_of_reads_and_a_client_of_writes() {
        let config = r#"{
          "operations": {
            "issues/list": {"group": "issues", "name": "list"},
            "issues/create": {"group": "issues", "name": "create"},
            "search/issues": {"group": "issues", "name": "search", "kind": "read"}
          },
          "properties": {"+1": "plus_one", "-1": "minus_one"}
        }"#;
        let files = generate(config).unwrap();
        let client = &files["issues/client.ts"];
        // Each interface is declared up to the function that creates it.
        let declared = |interface: &str, create: &str| {
            let start = client
                .find(&format!("export interface {interface} {{"))
                .expect(interface);
            let end = client.find(&format!("export function {create}(")).expect(create);
            &client[start..end]
        };
        let reads = declared("ReadClient", "createReadClient");
        assert!(
            reads.contains("list(") && reads.contains("search(") && !reads.contains("create("),
            "{reads}"
        );
        let writes = declared("WriteClient", "createWriteClient");
        assert!(
            writes.contains("create(") && !writes.contains("list(") && !writes.contains("search("),
            "{writes}"
        );
        assert!(
            client.contains("export function bindRead(transport: Transport): ReadClient {"),
            "{client}"
        );
        assert!(
            client.contains("export function bindWrite(transport: Transport): WriteClient {"),
            "{client}"
        );
        assert!(!client.contains("createClient"), "{client}");

        // The root has both clients, each with the group as the same client.
        let root = &files["client.ts"];
        assert!(root.contains("readonly issues: IssuesReadClient;"), "{root}");
        assert!(root.contains("readonly issues: IssuesWriteClient;"), "{root}");
        // What creates a client is in a file of its own, and not in the
        // index, which has the types.
        let index = &files["index.ts"];
        assert!(!index.contains("createReadClient"), "{index}");
        assert!(!index.contains("createWriteClient"), "{index}");
        assert!(
            index.contains("  ReadClient,\n  WriteClient,\n  ClientOptions,\n"),
            "{index}"
        );
        for path in ["read.ts", "issues/read.ts"] {
            let read = &files[path];
            assert!(
                read.contains("export { createReadClient } from \"./client.js\";")
                    && read.contains("export type { ReadClient } from \"./client.js\";")
                    && !read.contains("Write"),
                "{read}"
            );
        }
        let write = &files["issues/write.ts"];
        assert!(
            write.contains("export { createWriteClient } from \"./client.js\";") && !write.contains("Read"),
            "{write}"
        );
    }

    #[test]
    fn only_a_get_a_head_or_a_post_can_be_a_read() {
        let config = r#"{"operations": {"issues/delete": {"group": "issues", "name": "delete", "kind": "read"}}}"#;
        assert_eq!(
            generate(config).unwrap_err(),
            "issues/delete is sent with DELETE, so it cannot be a read"
        );
    }

    #[test]
    fn a_method_cannot_be_named_then() {
        let config = r#"{"operations": {"issues/list": {"group": "issues", "name": "then"}}}"#;
        assert_eq!(generate(config).unwrap_err(), "issues/list cannot be named then");
    }

    #[test]
    fn the_items_of_a_page_are_an_array_of_the_response() {
        let config = |operation: &str| {
            format!(r#"{{"operations": {{{operation}}}, "properties": {{"+1": "plus_one", "-1": "minus_one"}}}}"#)
        };
        let wrong = config(r#""runs/list": {"name": "list", "pagination": {"style": "link-header", "items": "typo"}}"#);
        assert_eq!(
            generate(&wrong).unwrap_err(),
            "runs/list pages, but no response of it is an array in the property typo"
        );
        let scalar =
            config(r#""runs/list": {"name": "list", "pagination": {"style": "link-header", "items": "total"}}"#);
        assert_eq!(
            generate(&scalar).unwrap_err(),
            "runs/list pages, but no response of it is an array in the property total"
        );
        let object = config(r#""runs/list": {"name": "list", "pagination": {"style": "link-header"}}"#);
        assert_eq!(
            generate(&object).unwrap_err(),
            "runs/list pages, but no response of it is an array"
        );
        let write = config(r#""issues/create": {"name": "create", "pagination": {"style": "link-header"}}"#);
        assert_eq!(
            generate(&write).unwrap_err(),
            "issues/create writes, so it cannot have pagination"
        );
    }

    #[test]
    fn an_operation_pages_by_offset() {
        let config = |pagination: &str| {
            format!(
                r#"{{
                  "operations": {{"incidents/list": {{"group": "incidents", "name": "list", "pagination": {pagination}}}}},
                  "properties": {{"+1": "plus_one", "-1": "minus_one"}}
                }}"#
            )
        };
        let files = generate(&config(
            r#"{"style": "offset", "items": "incidents", "limit": "page_size", "more": "has_more"}"#,
        ))
        .unwrap();
        // The items are found in a member of an allOf, and the names are
        // those of the generated fields.
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(
            operations["operations"][0]["pagination"],
            serde_json::json!({
                "style": "offset",
                "items": "incidents",
                "field": "incidents",
                "offset": "offset",
                "limit": "pageSize",
                "more": "hasMore"
            })
        );
        let worksheet = &files["WORKSHEET.md"];
        assert!(
            worksheet.contains(
                "- Paging: it pages by `offset`: a call asks for a page with `offset` and `pageSize`, the items are in `data.incidents`, and `data.hasMore` is true when there is another page."
            ),
            "{worksheet}"
        );

        let error = |pagination: &str| generate(&config(pagination)).unwrap_err();
        assert_eq!(
            error(r#"{"style": "offset", "items": "incidents"}"#),
            "incidents/list pages by offset, but has no parameter limit"
        );
        assert_eq!(
            error(r#"{"style": "offset", "items": "incidents", "limit": "page_size", "more": "more"}"#),
            "incidents/list pages by offset, but no response of it has the property more"
        );
        assert_eq!(
            error(r#"{"style": "link-header", "items": "incidents", "more": "has_more"}"#),
            "incidents/list: more is not for pagination of the style link-header"
        );
    }

    /// A config of the two operations of `/messages` in [`SPEC`], with
    /// `rest` after them.
    fn messages(list: &str, rest: &str) -> String {
        format!(
            r#"{{
              "operations": {{
                "messages/list": {{"group": "messages", "name": "list"{list}}},
                "messages/query": {{"group": "messages", "name": "query", "kind": "read"}}
              }},
              "properties": {{"+1": "plus_one", "-1": "minus_one"}}{rest}
            }}"#
        )
    }

    #[test]
    fn an_operation_pages_by_cursor() {
        let pagination = |pagination: &str| messages(&format!(r#", "pagination": {pagination}"#), "");
        let files = generate(&pagination(
            r#"{"style": "cursor", "items": "messages", "cursor": "cursor", "next": "meta.next_cursor", "limit": "limit", "last": "is_last"}"#,
        ))
        .unwrap();
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(
            operations["operations"][0]["pagination"],
            serde_json::json!({
                "style": "cursor",
                "items": "messages",
                "field": "messages",
                "limit": "limit",
                "cursor": "cursor",
                "next": "meta.nextCursor",
                "last": "isLast"
            })
        );
        let worksheet = &files["WORKSHEET.md"];
        assert!(
            worksheet.contains(
                "- Paging: it pages by `cursor`: a call asks for the next page with `cursor`, set to the `data.meta.nextCursor` of the page before and `limit`, the items are in `data.messages`, and `data.isLast` is true when the page is the last."
            ),
            "{worksheet}"
        );

        let error = |text: &str| generate(&pagination(text)).unwrap_err();
        assert_eq!(
            error(r#"{"style": "cursor", "items": "messages", "cursor": "cursor"}"#),
            "messages/list pages by cursor, so its pagination needs next"
        );
        assert_eq!(
            error(r#"{"style": "cursor", "items": "messages", "cursor": "after", "next": "meta.next_cursor"}"#),
            "messages/list pages by cursor, but has no parameter after"
        );
        assert_eq!(
            error(r#"{"style": "cursor", "items": "messages", "cursor": "cursor", "next": "meta.cursor"}"#),
            "messages/list pages by cursor, but no response of it has the property meta.cursor"
        );
        assert_eq!(
            error(
                r#"{"style": "cursor", "items": "messages", "cursor": "cursor", "next": "meta.next_cursor", "more": "ok", "last": "is_last"}"#
            ),
            "messages/list: a pagination has more or last, not both"
        );
    }

    #[test]
    fn a_cursor_can_be_in_the_body_and_a_response_can_have_no_type() {
        let config = r#"{
          "operations": {
            "messages/query": {
              "group": "messages",
              "name": "query",
              "kind": "read",
              "pagination": {"style": "cursor", "items": "results", "cursor": "start_cursor", "next": "next_cursor", "more": "has_more"}
            }
          }
        }"#;
        let files = generate(config).unwrap();
        // The cursor is a field of the body. The response has no type, so
        // its properties have their wire names.
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(
            operations["operations"][0]["pagination"],
            serde_json::json!({
                "style": "cursor",
                "items": "results",
                "field": "results",
                "cursor": "startCursor",
                "next": "next_cursor",
                "more": "has_more"
            })
        );
        assert_eq!(operations["operations"][0]["untyped"], true);
        let worksheet = &files["WORKSHEET.md"];
        assert!(
            worksheet.contains("- The document gives its response no type, so `data` is what the provider sent"),
            "{worksheet}"
        );
    }

    #[test]
    fn a_parameter_of_the_config_is_left_out() {
        // Of every operation that has it, among them one that has it from
        // its path item.
        let files = generate(&messages("", r#", "omitParameters": ["token"]"#)).unwrap();
        let client = &files["messages/client.ts"];
        assert!(!client.contains("token"), "{client}");
        assert!(client.contains("cursor?: string;"), "{client}");
        // Of one operation.
        let files = generate(&messages(r#", "omitParameters": ["cursor"]"#, "")).unwrap();
        let client = &files["messages/client.ts"];
        assert!(
            client.contains("token?: string;") && !client.contains("  cursor?: string;"),
            "{client}"
        );

        assert_eq!(
            generate(&messages("", r#", "omitParameters": ["tokn"]"#)).unwrap_err(),
            "no operation of the config has the parameter tokn"
        );
        assert_eq!(
            generate(&messages(r#", "omitParameters": ["after"]"#, "")).unwrap_err(),
            "messages/list has no parameter after"
        );
        let path = r#"{"operations": {"issues/delete": {"name": "delete", "omitParameters": ["id"]}}}"#;
        assert_eq!(
            generate(path).unwrap_err(),
            "issues/delete: id is a path parameter, which cannot be left out"
        );
    }

    #[test]
    fn a_response_can_say_in_its_body_that_it_failed() {
        let files = generate(&messages(
            r#", "failure": {"property": "status", "equals": "error"}"#,
            r#", "failure": {"property": "ok", "equals": false}"#,
        ))
        .unwrap();
        let client = &files["messages/client.ts"];
        // The operation's own is in place of the config's.
        assert!(
            client.contains("  failure: { property: \"status\", equals: \"error\" },\n"),
            "{client}"
        );
        assert!(
            client.contains("  failure: { property: \"ok\", equals: false },\n"),
            "{client}"
        );
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(
            operations["operations"][1]["failure"],
            serde_json::json!({"property": "ok"})
        );
        let worksheet = &files["WORKSHEET.md"];
        assert!(
            worksheet.contains("- A 2XX response fails when its `ok` says so"),
            "{worksheet}"
        );
        assert_eq!(
            generate(&messages("", r#", "failure": {"property": "ok", "equals": []}"#)).unwrap_err(),
            "messages/list: the failure of a response equals a string, a number, a boolean or null"
        );
    }

    #[test]
    fn an_int64_is_a_number_when_the_config_says_so() {
        let client = &generate(&messages("", "")).unwrap()["messages/client.ts"];
        assert!(client.contains("limit?: bigint;"), "{client}");
        let client = &generate(&messages("", r#", "int64": "number""#)).unwrap()["messages/client.ts"];
        assert!(client.contains("limit?: number;"), "{client}");
        assert!(!client.contains("bigint") && !client.contains("int64"), "{client}");
    }

    #[test]
    fn the_headers_an_operation_declares_are_listed() {
        let config = r#"{
          "operations": {
            "incidents/list": {"group": "incidents", "name": "list"},
            "issues/list": {"group": "issues", "name": "list"}
          },
          "properties": {"+1": "plus_one", "-1": "minus_one"}
        }"#;
        let files = generate(config).unwrap();
        // Those of the path item, then of the operation, without
        // Content-Type.
        let operations: Value = serde_json::from_str(&files["operations.json"]).unwrap();
        assert_eq!(
            operations["operations"][0]["headers"],
            serde_json::json!([
                {"name": "Accept", "required": true, "default": "application/vnd.t+json;version=2"},
                {"name": "From", "required": false}
            ])
        );
        assert_eq!(operations["operations"][1].get("headers"), None);
        let worksheet = &files["WORKSHEET.md"];
        assert!(
            worksheet.contains(
                "the clients do not send: `Accept` (required, `application/vnd.t+json;version=2` by default), `From`. For each,"
            ),
            "{worksheet}"
        );
        assert_eq!(worksheet.matches("- Headers it declares").count(), 1, "{worksheet}");
        // The request type has no field for a header.
        let client = &files["incidents/client.ts"];
        assert!(!client.contains("from?:") && !client.contains("accept"), "{client}");
    }

    #[test]
    fn an_operation_of_the_config_that_is_skipped_is_generated() {
        let config = r#"{
          "operations": {"runs/list": {"group": "runs", "name": "list"}},
          "properties": {"+1": "plus_one", "-1": "minus_one"}
        }"#;
        let files = generate(config).unwrap();
        assert!(files["runs/client.ts"].contains("list("), "{}", files["runs/client.ts"]);
    }

    #[test]
    fn an_operation_of_a_path_item_that_a_path_refers_to_is_one_of_the_document() {
        // It is left out when the config does not have it, as CONFIG does not.
        let files = generate(CONFIG).unwrap();
        assert!(!files["operations.json"].contains("shared/get"));
        let config = r#"{"operations": {"shared/get": {"group": "shared", "name": "get"}}}"#;
        let files = generate(config).unwrap();
        assert!(files["operations.json"].contains(r#""operationId": "shared/get""#));
        assert!(
            files["shared/client.ts"].contains("get("),
            "{}",
            files["shared/client.ts"]
        );
    }

    #[test]
    fn a_property_can_be_named_like_a_keyword_of_a_schema() {
        let config = r#"{
          "operations": {"issues/list": {"group": "issues", "name": "list"}},
          "properties": {"+1": "plus_one", "-1": "minus_one", "properties": "props", "format": "shape"}
        }"#;
        let files = generate(config).unwrap();
        let models = &files["issues/models.ts"];
        assert!(models.contains("props?: "), "{models}");
        assert!(models.contains("props?: { shape?: string };"), "{models}");
    }

    #[test]
    fn operations_json_lists_the_operations_of_the_config() {
        let files = generate(CONFIG).unwrap();
        assert_eq!(
            files["operations.json"],
            r#"{
  "operations": [
    {
      "operationId": "issues/list",
      "group": [
        "issues"
      ],
      "name": "list",
      "method": "GET",
      "path": "/issues",
      "kind": "read",
      "pagination": {
        "style": "link-header"
      }
    },
    {
      "operationId": "search/issues",
      "group": [
        "issues"
      ],
      "name": "search",
      "method": "POST",
      "path": "/search",
      "kind": "read"
    }
  ]
}
"#
        );
    }

    #[test]
    fn only_the_operations_of_the_config_are_in_the_sdk() {
        let files = generate(CONFIG).unwrap();
        let client = &files["issues/client.ts"];
        assert!(
            client.contains("list(request?: ListRequest, options?: RequestOptions): Promise<Result<ListResponse>>;"),
            "{client}"
        );
        assert!(
            client.contains(
                "search(request?: SearchRequest, options?: RequestOptions): Promise<Result<SearchResponse>>;"
            ),
            "{client}"
        );
        assert!(!client.contains("create(") && !client.contains("open("), "{client}");
        let models: String = files
            .iter()
            .filter(|(path, _)| path.ends_with("models.ts"))
            .map(|(_, content)| content.as_str())
            .collect();
        assert!(!models.contains("Unused"), "{models}");
    }

    #[test]
    fn a_date_that_can_be_null_is_a_string() {
        let files = generate(CONFIG).unwrap();
        let models = &files["issues/models.ts"];
        assert!(models.contains("closedAt?: string | null;"), "{models}");
        assert!(!models.contains("Temporal"), "{models}");
    }

    #[test]
    fn properties_are_named_and_dates_are_strings() {
        let files = generate(CONFIG).unwrap();
        let models = &files["issues/models.ts"];
        // Without the names, `+1` and `-1` are both the name "1", which is
        // an error.
        assert!(models.contains("plusOne?: number;"), "{models}");
        assert!(models.contains("minusOne?: number;"), "{models}");
        assert!(models.contains(r#"["+1", "plusOne"],"#), "{models}");
        assert!(models.contains("createdAt?: string;"), "{models}");
        assert!(!models.contains("Temporal"), "{models}");
    }

    /// The SDK leaves out a property or a query parameter whose wire name
    /// has a character such as `.` or `+`.
    #[test]
    fn a_field_whose_wire_name_is_not_valid_is_kept() {
        let files = generate(CONFIG).unwrap();
        let client = &files["issues/client.ts"];
        assert!(client.contains("titleContains?: string;"), "{client}");
        assert!(
            client.contains(r#"query: { titleContains: "title.contains" },"#),
            "{client}"
        );
        assert!(
            !files["issues/models.ts"].contains("[key: string]: unknown"),
            "{}",
            files["issues/models.ts"]
        );
    }

    #[test]
    fn a_method_other_than_get_writes_unless_the_config_says_it_reads() {
        let files = generate(r#"{"operations": {"issues/create": {"name": "create"}}}"#).unwrap();
        assert!(files["operations.json"].contains(r#""kind": "write""#));
        assert!(files["operations.json"].contains(r#""group": [],"#));
        // The alias of the operation makes no method.
        assert!(!files["client.ts"].contains("open("), "{}", files["client.ts"]);
    }

    #[test]
    fn an_operation_the_document_does_not_have_is_an_error() {
        let err = generate(r#"{"operations": {"issues/get": {"name": "get"}, "pulls/get": {"name": "pull"}}}"#);
        assert_eq!(
            err.unwrap_err(),
            "no operation has the operationId issues/get, pulls/get"
        );
    }

    #[test]
    fn an_operation_that_is_not_json_is_an_error() {
        let err = generate(r#"{"operations": {"logs/get": {"name": "logs"}}}"#).unwrap_err();
        assert!(
            err.starts_with("logs/get (GET /logs) has a body or a response that is not JSON"),
            "{err}"
        );
    }

    #[test]
    fn an_unknown_key_of_the_config_is_an_error() {
        let err = generate(r#"{"operations": {"issues/list": {"name": "list", "paginate": true}}}"#).unwrap_err();
        assert!(err.contains("unknown field `paginate`"), "{err}");
    }
}
