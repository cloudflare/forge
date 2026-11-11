//! The gatekeeper generator, following rfcs/gatekeeper.md.
//!
//! A gatekeeper covers a few operations of an API, which a config file
//! picks and names. The config is applied to the document before it is
//! linked, so that the operations it leaves out, and the models only they
//! use, are never part of the [`Forge`]. The generator then writes the
//! TypeScript clients of what is left, and operations.json, which says what
//! the config says about each operation.
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

use forge::{Err, Forge, Json, Method, Plugin};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::ts;
use crate::ts::client::Role;

/// The sources of the runtime library, by path in the generated `_/`: the
/// codecs and the error of the TypeScript SDK's, and a transport of its own.
const RUNTIME: [(&str, &str); 4] = [
    ("codec.ts", include_str!("ts/lib/src/codec.ts")),
    ("error.ts", include_str!("ts/lib/src/error.ts")),
    ("index.ts", include_str!("gatekeeper/lib/src/index.ts")),
    ("transport.ts", include_str!("gatekeeper/lib/src/transport.ts")),
];

/// The clients of a group: one of the operations that read, for the code
/// of a session, and one of those that write, for the code that applies an
/// approved action. A client does not have the methods of the other.
const ROLES: [Role; 2] = [
    Role {
        client: "ReadClient",
        bind: "bindRead",
        create: "createReadClient",
        has: reads,
    },
    Role {
        client: "WriteClient",
        bind: "bindWrite",
        create: "createWriteClient",
        has: writes,
    },
];

/// Reports whether `method` reads, as the config says or else as its HTTP
/// method does.
fn reads(method: Method<'_>) -> bool {
    let kind = method.extension(EXTENSION).and_then(|extension| extension.get("kind"));
    kind.and_then(Json::as_str) == Some(Kind::Read.as_str())
}

fn writes(method: Method<'_>) -> bool {
    !reads(method)
}

/// The extension that carries what the config says about an operation from
/// [`Config::apply`] to the generator.
const EXTENSION: &str = "x-gatekeeper";

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
    /// How the operation pages, if it does.
    pagination: Option<Pagination>,
}

/// Whether an operation only reads, or changes something.
#[derive(Clone, Copy, Deserialize)]
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
    /// error.
    pub fn apply(&self, doc: &mut Value) -> Result<(), Err> {
        let mut found = BTreeSet::new();
        let items = doc.get_mut("paths").and_then(Value::as_object_mut);
        for item in items.into_iter().flat_map(Map::values_mut) {
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
                operation.insert("x-forge-group-name".to_owned(), json!(selected.group));
                operation.insert("x-forge-method-name".to_owned(), json!(selected.name));
                operation.insert(EXTENSION.to_owned(), selected.extension(id, method));
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

    /// Names the properties of the config, and removes the date formats, in
    /// `value` and everything inside it.
    fn apply_to_schemas(&self, value: &mut Value) {
        match value {
            Value::Object(map) => {
                let format = map.get("format").and_then(Value::as_str);
                if matches!(format, Some("date-time" | "date"))
                    && map.get("type").and_then(Value::as_str) == Some("string")
                {
                    map.shift_remove("format");
                }
                if let Some(Value::Object(properties)) = map.get_mut("properties") {
                    for (wire_name, name) in &self.properties {
                        if let Some(Value::Object(property)) = properties.get_mut(wire_name) {
                            property.entry("x-forge-property-name").or_insert_with(|| json!(name));
                        }
                    }
                }
                for value in map.values_mut() {
                    self.apply_to_schemas(value);
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
    fn extension(&self, id: &str, method: &str) -> Value {
        let kind = self.kind.unwrap_or(match method {
            "get" | "head" => Kind::Read,
            _ => Kind::Write,
        });
        let mut extension = json!({"operationId": id, "kind": kind.as_str()});
        if let Some(pagination) = &self.pagination {
            let mut value = json!({"style": pagination.style.as_str()});
            if let Some(items) = &pagination.items {
                value["items"] = json!(items);
            }
            extension["pagination"] = value;
        }
        extension
    }
}

/// Generates the files of a gatekeeper from a document a [`Config`] was
/// applied to.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the TypeScript clients, then operations.json.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let manifest = File::Text {
            path: "operations.json".to_owned(),
            content: manifest(forge)?,
        };
        let clients = ts::generate(forge, ts::Transport::Provider, &ROLES, &RUNTIME)?;
        Ok(clients.map(File::Sdk).chain(std::iter::once(manifest)))
    }
}

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
    if let Some(pagination) = extension.get("pagination") {
        let mut value = json!({"style": string(pagination, "style")});
        if let Some(items) = string(pagination, "items") {
            value["items"] = json!(items);
        }
        entry["pagination"] = value;
    }
    Ok(entry)
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

    /// A document with three operations, a property named `+1` and a date.
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
        }
      },
      "components": {
        "schemas": {
          "issue": {
            "type": "object",
            "properties": {
              "created_at": {"type": "string", "format": "date-time"},
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
        own.extend(["codec.ts", "error.ts"].map(String::from));
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
            index.contains("  Provider,\n  ProviderRequest,\n  RequestOptions,\n  Result,\n"),
            "{index}"
        );
        let transport = &files["_/transport.ts"];
        assert!(transport.contains("export interface Provider {"), "{transport}");
        assert!(!files.contains_key("_/hooks/envelope.ts"));
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
        let index = &files["index.ts"];
        assert!(index.contains("  createReadClient,\n  createWriteClient,\n"), "{index}");
        assert!(
            index.contains("  ReadClient,\n  WriteClient,\n  ClientOptions,\n"),
            "{index}"
        );
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
