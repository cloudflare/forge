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

use forge::{Err, Forge, Json, Method, Plugin, Type};
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
}

/// Where a response says what the next page is.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum PaginationStyle {
    /// In the `Link` header, as `rel="next"`.
    LinkHeader,
}

impl PaginationStyle {
    fn as_str(self) -> &'static str {
        match self {
            PaginationStyle::LinkHeader => "link-header",
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
        for pointer in ["/paths", "/components/pathItems"] {
            let items = doc.pointer_mut(pointer).and_then(Value::as_object_mut);
            for item in items.into_iter().flat_map(Map::values_mut) {
                self.apply_to_path_item(item, &mut found)?;
            }
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
    /// `found` those that are of the config.
    fn apply_to_path_item<'a>(&'a self, item: &mut Value, found: &mut BTreeSet<&'a str>) -> Result<(), Err> {
        for method in METHODS {
            let Some(operation) = item.get_mut(method).and_then(Value::as_object_mut) else {
                continue;
            };
            // An alias is a method even when its operation is skipped.
            operation.shift_remove("x-forge-aliases");
            let id = operation.get("operationId").and_then(Value::as_str);
            let Some((id, selected)) = id.and_then(|id| self.operations.get_key_value(id)) else {
                operation.insert("x-forge-skip".to_owned(), Value::Bool(true));
                continue;
            };
            found.insert(id.as_str());
            // The config is what says which operations there are.
            operation.shift_remove("x-forge-skip");
            operation.insert("x-forge-group-name".to_owned(), json!(selected.group));
            operation.insert("x-forge-method-name".to_owned(), json!(selected.name));
            operation.insert(EXTENSION.to_owned(), selected.extension(id, method)?);
        }
        Ok(())
    }

    /// Names the properties of the config, and removes the date formats, in
    /// `value` and everything inside it.
    fn apply_to_schemas(&self, value: &mut Value) {
        match value {
            Value::Object(map) => {
                let format = map.get("format").and_then(Value::as_str);
                // A type is a string, or since OpenAPI 3.1 an array of them,
                // as for a string that can be null.
                let is_string = match map.get("type") {
                    Some(Value::String(ty)) => ty == "string",
                    Some(Value::Array(types)) => types.iter().any(|ty| ty == "string"),
                    _ => false,
                };
                if matches!(format, Some("date-time" | "date")) && is_string {
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

/// Returns WORKSHEET.md: the operations that read, then those that write,
/// each with the decisions the spec cannot make, for an agent to fill in
/// and a person to review.
fn worksheet(forge: &Forge) -> String {
    let methods: Vec<Method<'_>> = forge.groups().flat_map(|group| group.methods()).collect();
    let mut text = String::from(WORKSHEET_INTRO);
    text.push_str("\n## Reads\n\n");
    text.push_str(WORKSHEET_READS);
    for &method in methods.iter().filter(|&&method| reads(method)) {
        heading(&mut text, method, "reads");
        if method.http_method().as_str() == "POST" {
            text.push_str(
                "- It is sent with `POST`, and the config says it reads. Why it changes nothing and can be sent twice:\n",
            );
        }
        text.push_str(FIELDS);
        text.push_str("- Session methods that return its data:\n");
        text.push_str("- Subresources each of them reports:\n");
        text.push_str(
            "- How `verifyObserverAccess` checks each kind of those for an observer, or that the data is private-only:\n",
        );
        text.push_str("- Whether the observation sets `containsRestrictedData` or `ownerInvitesOnly`:\n");
        text.push_str(
            "- Statuses and bodies that mean no access, and those that are indeterminate and are thrown again:\n",
        );
        text.push_str("- Or it only prepares an action, and is not an observation:\n");
        let fact = |key| ts::client::provider_fact(method, key);
        if fact("conditional").and_then(Json::as_bool) == Some(true) {
            text.push_str(
                "- Cache: it is conditional. Revalidated with its `ETag`, a TTL, or none, and what the cache is partitioned by:\n",
            );
        } else {
            text.push_str("- Cache: a TTL or none, and what the cache is partitioned by:\n");
        }
        if let Some(pagination) = fact("pagination") {
            let style = pagination.get("style").and_then(Json::as_str).unwrap_or_default();
            let items = pagination.get("items").and_then(Json::as_str);
            let items = match items.and_then(|items| items_field(method, Some(items))) {
                Some(field) => format!("the items are in `data.{field}`"),
                None => "the response is the array of items".to_owned(),
            };
            text.push_str(&format!(
                "- Cursor: it pages by `{style}`, and {items}. The kit cursor that wraps it, and what each page reports:\n"
            ));
        }
    }
    text.push_str("\n## Writes\n\n");
    text.push_str(WORKSHEET_WRITES);
    for &method in methods.iter().filter(|&&method| writes(method)) {
        heading(&mut text, method, "writes");
        text.push_str(FIELDS);
        text.push_str("- Session methods that stage it:\n");
        text.push_str("- Action definitions, by name. A name is permanent once it ships:\n");
        text.push_str("- Kind of each, as a tag and a label a user would enable, such as \"Edit labels\":\n");
        if method.http_method().as_str() == "DELETE" {
            text.push_str(
                "- `autoApprovable` of each. It is sent with `DELETE`, so rule 1 of the skill's opt-out policy (it deletes or removes content) applies unless you say why not:\n",
            );
        } else {
            text.push_str(
                "- `autoApprovable` of each: `true`, or `false` with the number of the rule of the skill's opt-out policy. Check each of its seven rules, such as passing a governance gate or changing permissions, and not only deletion:\n",
            );
        }
        text.push_str("- What the description shows the person who approves, and the reads that build it:\n");
        text.push_str("- How reads show it while it is pending:\n");
        text.push_str("- What a second attempt does, and what a timeout means:\n");
        text.push_str("- Revert, if it has one:\n");
    }
    text
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

/// The line of the worksheet that asks where the fields of a request come
/// from.
const FIELDS: &str =
    "- Request fields the binding fixes, and those a caller gives, with how each of those is checked:\n";

const WORKSHEET_INTRO: &str = "\
# Worksheet

Forge generated this list from the config of the gatekeeper. It has every operation the generated clients cover, with what the spec cannot decide about it. GUIDE.md says how to use it.

Copy this file out of the generated directory before you fill it in: this copy is replaced each time Forge runs. Answer every line, with \"none\" where that is the answer. A person reviews the answers with `types.d.ts`.
";

const WORKSHEET_READS: &str = "\
An operation that reads is called from session code, through the client of reads. The observation is authorized once for each session method, not for each operation, so one answer can cover several of these.
";

const WORKSHEET_WRITES: &str = "\
An operation that writes is called only from the apply handler of an action, through the client of writes. One operation can serve several actions, and one action can call several operations.
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
    if let Some(pagination) = extension.get("pagination") {
        let mut value = json!({"style": string(pagination, "style")});
        let items = string(pagination, "items");
        match (&items, items_field(method, items.as_deref())) {
            (_, None) => {
                let what = match &items {
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
        entry["pagination"] = value;
    }
    Ok(entry)
}

/// Returns the field of the response of `method` that holds the items of a
/// page, which is the property `items`: empty when `items` is `None` and
/// the response is the array itself. `None` when no response has the array.
fn items_field(method: Method<'_>, items: Option<&str>) -> Option<String> {
    fn resolved(ty: Type<'_>) -> Type<'_> {
        match ty {
            Type::Model(model) => resolved(model.ty()),
            ty => ty,
        }
    }
    let (types, _) = ts::client::response(method);
    types.into_iter().map(resolved).find_map(|ty| match (ty, items) {
        (Type::Array(_), None) => Some(String::new()),
        (Type::Object(object), Some(items)) => object
            .fields()
            .find(|field| field.wire_name() == items && matches!(resolved(field.ty()), Type::Array(_)))
            .map(|field| field.name().camel()),
        _ => None,
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
        "/shared": {"$ref": "#/components/pathItems/shared"}
      },
      "components": {
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
        assert!(reads.contains("- Cache: it is conditional."), "{reads}");
        assert!(
            reads.contains("- Cursor: it pages by `link-header`, and the response is the array of items."),
            "{reads}"
        );
        assert!(
            reads.contains("- Cursor: it pages by `link-header`, and the items are in `data.workRuns`."),
            "{reads}"
        );
        // A read that is not sent with GET is asked why it is one.
        let search = &reads[reads.find("### `reads.issues.search`").unwrap()..];
        assert!(
            search.contains("- It is sent with `POST`, and the config says it reads."),
            "{search}"
        );
        assert_eq!(reads.matches("- It is sent with `POST`").count(), 1, "{reads}");
        assert!(reads.contains("- Request fields the binding fixes"), "{reads}");
        assert!(reads.contains("- How `verifyObserverAccess` checks"), "{reads}");
        assert!(!reads.contains("issues.create"), "{reads}");
        assert!(
            writes.contains("### `writes.issues.create`\n\n`issues/create`: `POST /issues`\n"),
            "{writes}"
        );
        assert!(
            writes.contains("- `autoApprovable` of each: `true`, or `false`"),
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
