//! The MCP generator. It generates the tools of an MCP server in
//! TypeScript, as data a server lists and calls, typed for the official MCP
//! TypeScript SDK, `@modelcontextprotocol/server`. It generates no server:
//! each server lists and calls the tools in its own way.
//!
//! Every group with tools gets a `tools.ts` in its directory: the tools of
//! its methods, each MCP's Tool, with the JSON Schema of its arguments, its
//! output schema and its hints, as `tools/list` sends it. Under the runtime's
//! `OPERATION` symbol, which `JSON.stringify` leaves out, each holds what only
//! the server needs, as data: the API method, its path template, its query
//! parameters, headers and body media types, and the JSON Schemas of its
//! response bodies, to check responses against. The output schema is the
//! schema of a successful response's JSON body. A group's `schemas.ts` and
//! `outputs.ts` hold the schemas of the models placed in it. The root gets an
//! `index.ts` with every tool, `operation`, which reads a tool's operation,
//! and `registerTools`, which registers the tools on an `McpServer`, for the
//! SDK to validate each call's arguments against the input schema, and builds
//! each call's request from the operation; the top-level models' schemas;
//! and the runtime itself in `_/tool.ts`, which imports the SDK's
//! `fromJsonSchema`.
//!
//! Each group's files depend only on the group, so they are generated in
//! parallel with [`Plugin::generate_group`]. A tool is named after its
//! groups and method, each in camelCase, joined by `_`, such as
//! `webAssets_discovery_operations_bulkEdit`, so tools of different groups
//! never share a name. Its arguments are objects by where they go: `path`,
//! `query` and `headers`, each keyed by the parameters' names on the wire,
//! and the JSON body as `body`, as the API takes it.

use std::borrow::Cow;
use std::collections::HashSet;

use forge::ts::{self, Ident, Module, PREAMBLE, p};
use forge::{Availability, Content, Err, Field, Forge, Group, HttpMethod, Location, Method, Model, Name, Plugin, Type};
use serde_json::{Map, Value, json};

mod schema;

use schema::{Direction, Refs, Schemas, reach};

/// Generates an MCP server.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the root: `index.ts` with every tool, the
    /// runtime, and the schemas of the top-level models.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let groups: Vec<Group<'_>> = forge
            .groups()
            .filter(|&group| verdicts(group).iter().any(|(_, name)| name.is_some()))
            .collect();

        let mut files = model_files(Module::ROOT, forge.models(), forge.groups());
        files.push(File::Ts(index(forge, &groups)));
        files.extend(RUNTIME.iter().map(|&(path, source)| File::Text {
            path: RUNTIME_DIR.sub(path).as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        }));
        Ok(files.into_iter())
    }

    /// Returns the files of `group`: a `tools.ts` with the tools of its
    /// methods, and the schemas of the models placed in it.
    fn generate_group(&self, group: Group<'_>) -> Result<impl Iterator<Item = File>, Err> {
        let mut tools = Vec::new();
        for (m, name) in verdicts(group) {
            if let Some(name) = name {
                tools.push(Tool::new(m, name)?);
            }
        }
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let mut files = Vec::new();
        if !tools.is_empty() {
            files.push(File::Ts(tools_file(group, &tools)));
        }
        files.extend(model_files(
            Module::group(group),
            group.models(),
            std::iter::once(group).chain(group.descendants()),
        ));
        Ok(files.into_iter())
    }
}

/// A file of the server.
pub enum File {
    /// A generated TypeScript file.
    Ts(ts::File),
    /// A file written as it is.
    Text { path: String, content: String },
}

impl forge::File for File {
    fn path(&self) -> &str {
        match self {
            File::Ts(f) => forge::File::path(f),
            File::Text { path, .. } => path,
        }
    }

    fn content(&self) -> Result<Cow<'_, [u8]>, Err> {
        match self {
            File::Ts(f) => forge::File::content(f),
            File::Text { content, .. } => Ok(Cow::Borrowed(content.as_bytes())),
        }
    }
}

/// The directory of the runtime library.
const RUNTIME_DIR: Module = Module::new("_");

/// The module of the runtime library that the generated files import: the
/// tool type, listing tools, and building their requests.
const RUNTIME_TOOL: Module = Module::new("_/tool.ts");

/// The MCP TypeScript SDK, whose types the generated files use.
const MCP_SDK: Module = Module::new("@modelcontextprotocol/server");

/// The sources of the runtime library, by path in lib/src.
const RUNTIME: [(&str, &str); 1] = [("tool.ts", include_str!("mcp/lib/src/tool.ts"))];

/// MCP tool names are at most 128 characters.
const MAX_NAME_LENGTH: usize = 128;

/// Returns each method of `group` that isn't deprecated, with the name of
/// its tool, or `None` for a method without one.
///
/// Forge keeps the names of a group's methods unique, but two can still
/// have the same camelCase spelling, since a digit belongs to the word
/// before it: `x1b` and `x_1b`. The first method by name keeps the tool
/// name. Groups whose paths have the same spelling share a directory, which
/// [`forge::write`] refuses.
fn verdicts(group: Group<'_>) -> Vec<(Method<'_>, Option<String>)> {
    let mut names = HashSet::new();
    group
        .methods()
        .filter(|m| !m.is_deprecated())
        .map(|m| (m, check(m).filter(|name| names.insert(name.clone()))))
        .collect()
}

/// Returns the name of the tool of `m`, without building its schemas, or
/// `None` for a name over MCP's limit or a path parameter without an
/// argument.
fn check(m: Method<'_>) -> Option<String> {
    let name = tool_name(m);
    (name.len() <= MAX_NAME_LENGTH && check_path(m.path(), &path_names(m))).then_some(name)
}

/// Returns the wire names of the path parameters of `m`.
fn path_names(m: Method<'_>) -> Vec<&str> {
    parameters(m.request())
        .into_iter()
        .filter(|&f| m.location(f) == Some(Location::Path))
        .map(|f| f.wire_name())
        .collect()
}

/// Returns the types of the arguments of `m`, whose models its input
/// schema refers to.
fn input_types(m: Method<'_>) -> Vec<Type<'_>> {
    let mut types: Vec<Type<'_>> = parameters(m.request())
        .into_iter()
        .filter(|&f| m.location(f).is_some())
        .map(|f| f.ty())
        .collect();
    types.extend(
        m.headers()
            .into_iter()
            .flat_map(|h| h.fields())
            .filter(|f| !f.is_read_only())
            .map(|f| f.ty()),
    );
    types.extend(m.body().into_iter().flat_map(|b| b.contents()).map(|c| c.ty()));
    types
}

/// Returns the types of the JSON bodies of the responses of `m`, whose
/// models its response schemas refer to.
fn output_types(m: Method<'_>) -> Vec<Type<'_>> {
    m.responses()
        .chain(m.errors())
        .filter_map(|r| r.json().map(|c| c.ty()))
        .collect()
}

/// The tool of a method.
struct Tool<'f> {
    method: Method<'f>,
    name: String,
    /// The properties of the input schema, and those that are required.
    properties: Value,
    required: Vec<String>,
    /// The models in the input schema's `$defs`, by key.
    defs: std::collections::BTreeMap<String, Model<'f>>,
    /// Each query parameter's wire name, and whether it is exploded.
    query: Vec<(String, bool)>,
    /// Each header parameter's wire name.
    headers: Vec<String>,
    /// The media types the body can be sent in.
    body: Option<Vec<String>>,
    /// The schema of each response's JSON body, by status, or `None` for a
    /// response without one.
    responses: Vec<(String, Option<Value>)>,
    /// The models in the response schemas' `$defs`, by key.
    response_defs: std::collections::BTreeMap<String, Model<'f>>,
    /// The output schema: the schema of a successful response's JSON body,
    /// or `None` if a successful response has no JSON body.
    output: Option<Value>,
    /// The models in the output schema's `$defs`, by key.
    output_defs: std::collections::BTreeMap<String, Model<'f>>,
}

/// The parameters of a tool in one place, `path`, `query` or `headers`: the
/// argument that holds them, an object keyed by their wire names.
#[derive(Default)]
struct Params {
    properties: Map<String, Value>,
    required: Vec<String>,
}

impl Params {
    /// Adds `field`, a parameter named `key` that is required if `required`.
    fn add<'f>(&mut self, key: String, field: Field<'f>, required: bool, refs: &mut Refs<'f>) {
        self.properties.insert(key.clone(), Schemas::INPUT.field(field, refs));
        if required {
            self.required.push(key);
        }
    }

    /// Adds the argument `key` holding the parameters to `properties`, and
    /// to `required` if one of them is. A place without parameters has no
    /// argument.
    fn insert_into(self, key: &str, properties: &mut Map<String, Value>, required: &mut Vec<String>) {
        if self.properties.is_empty() {
            return;
        }
        let mut schema = Map::new();
        schema.insert("type".to_owned(), json!("object"));
        schema.insert("properties".to_owned(), Value::Object(self.properties));
        schema.insert("additionalProperties".to_owned(), json!(false));
        if !self.required.is_empty() {
            schema.insert("required".to_owned(), json!(self.required));
            required.push(key.to_owned());
        }
        properties.insert(key.to_owned(), Value::Object(schema));
    }
}

impl<'f> Tool<'f> {
    /// Returns the tool of `m` named `name`. [`check`] has accepted `m`.
    fn new(m: Method<'f>, name: String) -> Result<Tool<'f>, String> {
        let mut refs = Refs::new();
        let mut path_params = Params::default();
        let mut query_params = Params::default();
        let mut header_params = Params::default();
        let mut query = Vec::new();
        let mut headers = Vec::new();

        for field in parameters(m.request()) {
            match m.location(field) {
                Some(Location::Path) => path_params.add(field.wire_name().to_owned(), field, true, &mut refs),
                Some(Location::Query { exploded }) => {
                    query_params.add(field.wire_name().to_owned(), field, field.is_required(), &mut refs);
                    query.push((field.wire_name().to_owned(), exploded));
                }
                None => {}
            }
        }
        for field in m
            .headers()
            .into_iter()
            .flat_map(|h| h.fields())
            .filter(|f| !f.is_read_only())
        {
            // Header names are case-insensitive; lower case is how HTTP/2
            // and `fetch` write them.
            let name = field.wire_name().to_ascii_lowercase();
            header_params.add(name.clone(), field, field.is_required(), &mut refs);
            headers.push(name);
        }

        // A body in more than one media type is in the one the
        // `content-type` header names, or else the one its value fits.
        let contents: Vec<Content<'_>> = m.body().into_iter().flat_map(|b| b.contents()).collect();
        if contents.len() > 1 && !headers.iter().any(|h| h == "content-type") {
            let types: Vec<&str> = contents.iter().map(|c| c.media_type()).collect();
            header_params.properties.insert(
                "content-type".to_owned(),
                json!({ "type": "string", "enum": types, "description": "The media type of `body`. Without it, a string is sent as the first text type, and an object as JSON if the API takes JSON, else as multipart/form-data." }),
            );
            headers.push("content-type".to_owned());
        }

        let mut properties = Map::new();
        let mut required = Vec::new();
        path_params.insert_into("path", &mut properties, &mut required);
        query_params.insert_into("query", &mut properties, &mut required);
        header_params.insert_into("headers", &mut properties, &mut required);

        let mut body = None;
        if let Some(b) = m.body()
            && !contents.is_empty()
        {
            let mut schema = match &contents[..] {
                [only] => Schemas::INPUT.ty(only.ty(), &mut refs),
                _ => json!({ "anyOf": contents.iter().map(|c| {
                    let mut schema = Schemas::INPUT.ty(c.ty(), &mut refs);
                    if let Value::Object(map) = &mut schema {
                        map.insert("description".to_owned(), json!(format!("As {}.", c.media_type())));
                    }
                    schema
                }).collect::<Vec<_>>() }),
            };
            if let Value::Object(map) = &mut schema
                && !b.description().trim().is_empty()
            {
                map.insert("description".to_owned(), json!(b.description().trim()));
            }
            properties.insert("body".to_owned(), schema);
            if b.is_required() {
                required.push("body".to_owned());
            }
            body = Some(contents.iter().map(|c| c.media_type().to_owned()).collect());
        }

        let mut response_refs = Refs::new();
        let mut success_refs = Refs::new();
        let mut successes = Vec::new();
        let mut responses = Vec::new();
        for r in m.responses().chain(m.errors()) {
            let status = if r.status().eq_ignore_ascii_case("default") {
                "default".to_owned()
            } else {
                r.status().to_ascii_uppercase()
            };
            let mut refs = Refs::new();
            let schema = r.json().map(|c| Schemas::OUTPUT.ty(c.ty(), &mut refs));
            if status.starts_with('2') {
                successes.push(schema.clone());
                success_refs.extend(refs.iter().copied());
            }
            response_refs.extend(refs);
            responses.push((status, schema));
        }
        let output = output_schema(successes);
        let output_defs = if output.is_some() {
            Schemas::OUTPUT.defs(&success_refs)
        } else {
            std::collections::BTreeMap::new()
        };

        Ok(Tool {
            method: m,
            name,
            properties: Value::Object(properties),
            required,
            defs: Schemas::INPUT.defs(&refs),
            query,
            headers,
            body,
            responses,
            response_defs: Schemas::OUTPUT.defs(&response_refs),
            output,
            output_defs,
        })
    }

    /// Returns the hints of the tool, from the HTTP method. A method that
    /// needs confirmation is never read-only, and always destructive.
    fn annotations(&self) -> Value {
        let confirm = self.method.confirmation().is_some();
        let method = self.method.http_method();
        let read_only = matches!(method, HttpMethod::Get | HttpMethod::Head | HttpMethod::Options) && !confirm;
        let destructive = !read_only && (confirm || matches!(method, HttpMethod::Delete | HttpMethod::Put));
        let idempotent = matches!(
            method,
            HttpMethod::Get | HttpMethod::Head | HttpMethod::Options | HttpMethod::Put | HttpMethod::Delete
        );
        let mut annotations = Map::new();
        let title = self.method.summary().trim();
        if !title.is_empty() {
            annotations.insert("title".to_owned(), json!(title));
        }
        annotations.insert("readOnlyHint".to_owned(), json!(read_only));
        annotations.insert("destructiveHint".to_owned(), json!(destructive));
        annotations.insert("idempotentHint".to_owned(), json!(idempotent));
        annotations.insert("openWorldHint".to_owned(), json!(true));
        Value::Object(annotations)
    }
}

/// Returns the output schema of a method whose successful responses have
/// the JSON body schemas `successes`: the one schema, or `anyOf` the distinct
/// ones. `None` if there are none, or one has no JSON body, since its result
/// would have no structured content.
fn output_schema(successes: Vec<Option<Value>>) -> Option<Value> {
    let mut distinct: Vec<Value> = Vec::new();
    for schema in successes {
        let schema = schema?;
        if !distinct.contains(&schema) {
            distinct.push(schema);
        }
    }
    match distinct.len() {
        0 => None,
        1 => distinct.pop(),
        _ => Some(json!({ "anyOf": distinct })),
    }
}

/// Returns the fields of a method's request: an object of parameters, or an
/// intersection of the parameters and the body.
fn parameters(request: Option<Type<'_>>) -> Vec<Field<'_>> {
    match request {
        Some(Type::Object(object)) => object.fields().collect(),
        Some(Type::Intersection(intersection)) => intersection
            .members()
            .flat_map(|member| parameters(Some(member)))
            .collect(),
        _ => Vec::new(),
    }
}

/// Reports whether each parameter in `template`, such as `{zone_id}`, is one
/// of the path parameters, by wire name, so the runtime can fill it in from
/// the `path` argument.
fn check_path(template: &str, names: &[&str]) -> bool {
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
            break;
        };
        if !names.contains(&&rest[start + 1..start + len]) {
            return false;
        }
        rest = &rest[start + len + 1..];
    }
    true
}

/// Returns the name of the tool of `m`: the names of its groups and its
/// own, in camelCase, joined by `_`, such as `accounts_members_list` or
/// `webAssets_discovery_operations_bulkEdit`. `_` only ever separates
/// names, so tools of different groups can't share a name.
fn tool_name(m: Method<'_>) -> String {
    let mut names: Vec<String> = m.group().path().map(Name::camel).collect();
    names.push(m.name().camel());
    names.join("_")
}

/// Returns the description of the tool of `m`: its description, or its
/// summary, then its stage of the API if it isn't generally available, and
/// that it needs confirmation.
fn description(m: Method<'_>) -> String {
    let description = m.description().trim();
    let summary = m.summary().trim();
    let endpoint = format!("{} {}", m.http_method().as_str(), m.path());
    let mut paragraphs = Vec::new();
    if !description.is_empty() {
        paragraphs.push(description.to_owned());
    } else if !summary.is_empty() {
        paragraphs.push(summary.to_owned());
    }
    let stage = match m.availability() {
        Some(Availability::Alpha) => Some("alpha"),
        Some(Availability::Beta) => Some("beta"),
        Some(Availability::Preview) => Some("in preview"),
        Some(Availability::Deprecated) => Some("deprecated"),
        Some(Availability::GenerallyAvailable) | None => None,
    };
    if let Some(stage) = stage {
        paragraphs.push(format!("This method is {stage}."));
    }
    if let Some(confirmation) = m.confirmation() {
        let confirmation = confirmation.trim();
        let mut text = "Confirm with the user before calling this tool.".to_owned();
        if !confirmation.is_empty() {
            text.push(' ');
            text.push_str(confirmation);
        }
        paragraphs.push(text);
    }
    paragraphs.push(endpoint);
    paragraphs.join("\n\n")
}

/// The schemas a file of model constants holds.
#[derive(Clone, Copy)]
enum SchemaFile {
    /// Models in arguments, in `schemas.ts`.
    Input,
    /// Models in response bodies, in `outputs.ts`, named with `Output` so a
    /// `tools.ts` can import both.
    Output,
}

impl SchemaFile {
    fn file(self) -> &'static str {
        match self {
            SchemaFile::Input => "schemas.ts",
            SchemaFile::Output => "outputs.ts",
        }
    }

    fn schemas(self) -> Schemas {
        match self {
            SchemaFile::Input => Schemas::INPUT,
            SchemaFile::Output => Schemas::OUTPUT,
        }
    }
}

/// Returns the constant with the schema of `model` in a file of `kind`,
/// declared in its group's directory, or the root's for a top-level model.
/// Forge places each model, so any file can name its constant.
fn model_ident(model: Model<'_>, kind: SchemaFile) -> Ident {
    let dir = model.group().map_or(Module::ROOT, Module::group);
    dir.sub(kind.file()).ident(constant_name(&schema::key(model)))
}

/// Returns the name of the constant of the model whose `$defs` key is `key`:
/// the key with `-` written as `$$` and each `.XX` escape as `$XX`, and `$_`
/// in front if it starts with a digit or is a reserved word. Keys are unique
/// and the encoding is reversible, so names are too, without looking at any
/// other model; they appear only in generated code.
fn constant_name(key: &str) -> String {
    let mut name = String::with_capacity(key.len());
    for c in key.chars() {
        match c {
            '-' => name.push_str("$$"),
            '.' => name.push('$'),
            c => name.push(c),
        }
    }
    if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) || RESERVED.contains(&name.as_str()) {
        name.insert_str(0, "$_");
    }
    name
}

/// Returns the `schemas.ts` and `outputs.ts` of `dir`: a constant with the
/// schema of each model of `placed`, the models placed there, that a tool
/// of `groups` uses in its arguments or its responses. `groups` are the
/// groups whose methods can use the models: the group of `dir` and those
/// below it.
fn model_files<'f>(
    dir: Module,
    placed: impl Iterator<Item = Model<'f>>,
    groups: impl Iterator<Item = Group<'f>>,
) -> Vec<File> {
    let placed: HashSet<Model<'f>> = placed.collect();
    if placed.is_empty() {
        return Vec::new();
    }
    let mut inputs = Refs::new();
    let mut outputs = Refs::new();
    for group in groups {
        for (m, name) in verdicts(group) {
            if name.is_none() {
                continue;
            }
            for t in input_types(m) {
                reach(t, Direction::Input, &mut inputs);
            }
            for t in output_types(m) {
                reach(t, Direction::Output, &mut outputs);
            }
        }
    }
    let mut files = Vec::new();
    for (kind, reached) in [(SchemaFile::Input, inputs), (SchemaFile::Output, outputs)] {
        let mut models: Vec<Model<'f>> = reached.into_iter().filter(|m| placed.contains(m)).collect();
        if models.is_empty() {
            continue;
        }
        models.sort_by_cached_key(|&m| schema::key(m));
        files.push(File::Ts(schema_file(dir.sub(kind.file()), &models, kind)));
    }
    files
}

/// Returns the file `module` with the constant of each of `models`, which
/// are placed in its directory.
fn schema_file(module: Module, models: &[Model<'_>], kind: SchemaFile) -> ts::File {
    let mut f = ts::File::new(module);
    let schema_type = MCP_SDK.ident("JSONObject").ty();
    let doc = match kind {
        SchemaFile::Input => "",
        SchemaFile::Output => " in responses",
    };
    for &model in models {
        let ident = f.ident(model_ident(model, kind).name);
        f.doc(&format!("The schema of `{}`{doc}.", model.schema_name()));
        let json =
            serde_json::to_string_pretty(&sorted(&kind.schemas().model(model))).unwrap_or_else(|_| "{}".to_owned());
        let mut lines = json.lines().peekable();
        let mut first = true;
        while let Some(line) = lines.next() {
            let prefix: Vec<&dyn ts::Print> = if first {
                vec![&"export const ", &ident, &": ", &schema_type, &" = "]
            } else {
                Vec::new()
            };
            let suffix = if lines.peek().is_none() { ";" } else { "" };
            let mut parts = prefix;
            parts.push(&line);
            parts.push(&suffix);
            f.line(&parts);
            first = false;
        }
        p!(f, "");
    }
    f
}

/// Words that can't name a constant.
const RESERVED: &[&str] = &[
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "let",
    "static",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "await",
];

/// Returns the `tools.ts` of `group`.
fn tools_file(group: Group<'_>, tools: &[Tool<'_>]) -> ts::File {
    let mut f = ts::File::new(Module::group(group).sub("tools.ts"));
    let tool = RUNTIME_TOOL.ident("Tool").ty();
    let operation = RUNTIME_TOOL.ident("OPERATION");
    let encode_path = RUNTIME_TOOL.ident("encodePath");
    let dotted: Vec<String> = group.path().map(Name::camel).collect();
    f.doc(&format!("The tools of `{}`.", dotted.join(".")));
    p!(f, "export const tools: readonly ", tool, "[] = [");
    f.indent(|f| {
        for t in tools {
            p!(f, "{");
            f.indent(|f| {
                let m = t.method;
                p!(f, "name: ", string(&t.name), ",");
                let title = m.summary().trim();
                if !title.is_empty() {
                    p!(f, "title: ", string(title), ",");
                }
                p!(f, "description: ", string(&description(m)), ",");
                p!(f, "inputSchema: {");
                f.indent(|f| {
                    p!(f, "type: \"object\",");
                    json_property(f, "properties", &t.properties);
                    if !t.required.is_empty() {
                        json_property(f, "required", &json!(t.required));
                    }
                    p!(f, "additionalProperties: false,");
                    if !t.defs.is_empty() {
                        p!(f, "$defs: {");
                        f.indent(|f| {
                            for (key, model) in &t.defs {
                                p!(f, string(key), ": ", model_ident(*model, SchemaFile::Input), ",");
                            }
                        });
                        p!(f, "},");
                    }
                });
                p!(f, "},");
                if let Some(Value::Object(output)) = t.output.as_ref().map(sorted) {
                    p!(f, "outputSchema: {");
                    f.indent(|f| {
                        for (key, value) in &output {
                            json_property(f, &string(key), value);
                        }
                        if !t.output_defs.is_empty() {
                            p!(f, "$defs: {");
                            f.indent(|f| {
                                for (key, model) in &t.output_defs {
                                    p!(f, string(key), ": ", model_ident(*model, SchemaFile::Output), ",");
                                }
                            });
                            p!(f, "},");
                        }
                    });
                    p!(f, "},");
                }
                json_property(f, "annotations", &t.annotations());
                p!(f, "[", operation.clone(), "]: {");
                f.indent(|f| operation_fields(f, t, &encode_path));
                p!(f, "},");
            });
            p!(f, "},");
        }
    });
    p!(f, "];");
    f
}

/// Prints what the server needs to call the API method of `t`, which the tool
/// holds under the runtime's `OPERATION` symbol so that clients never see it.
fn operation_fields(f: &mut ts::File, t: &Tool<'_>, encode_path: &Ident) {
    let m = t.method;
    p!(f, "method: ", string(m.http_method().as_str()), ",");
    p!(f, "path: ", string(m.path()), ",");
    p!(f, "pathOf: ", encode_path.clone(), "`", path_template(m.path()), "`,");
    if !t.query.is_empty() {
        p!(f, "query: [");
        f.indent(|f| {
            for (wire, explode) in &t.query {
                p!(f, "{ name: ", string(wire), ", explode: ", explode.to_string(), " },");
            }
        });
        p!(f, "],");
    }
    if !t.headers.is_empty() {
        let names: Vec<String> = t.headers.iter().map(|name| string(name)).collect();
        p!(f, "headers: [", names.join(", "), "],");
    }
    if let Some(media_types) = &t.body {
        let types: Vec<String> = media_types.iter().map(|t| string(t)).collect();
        p!(f, "body: { mediaTypes: [", types.join(", "), "] },");
    }
    let extensions: Map<String, Value> = m
        .extensions()
        .map(|(name, value)| (name.to_owned(), schema::value(value)))
        .collect();
    if !extensions.is_empty() {
        json_property(f, "extensions", &Value::Object(extensions));
    }
    if !t.responses.is_empty() {
        p!(f, "responses: {");
        f.indent(|f| {
            let by_status: Map<String, Value> = t
                .responses
                .iter()
                .map(|(status, schema)| (status.clone(), schema.clone().unwrap_or(Value::Null)))
                .collect();
            json_property(f, "schemas", &Value::Object(by_status));
            if !t.response_defs.is_empty() {
                p!(f, "$defs: {");
                f.indent(|f| {
                    for (key, model) in &t.response_defs {
                        p!(f, string(key), ": ", model_ident(*model, SchemaFile::Output), ",");
                    }
                });
                p!(f, "},");
            }
        });
        p!(f, "},");
    }
}

/// Returns the `index.ts` of the root: the API, and every tool of `groups`,
/// the groups with tools.
fn index(forge: &Forge, groups: &[Group<'_>]) -> ts::File {
    let mut f = ts::File::new(Module::ROOT.sub("index.ts"));
    let tool = RUNTIME_TOOL.ident("Tool").ty();
    p!(f, "export { operation, registerTools } from './_/tool.js';");
    p!(f, "");
    f.doc("The API the tools call.");
    p!(f, "export const api = {");
    f.indent(|f| {
        p!(f, "baseUrl: ", string(&forge.base_url), ",");
        p!(f, "version: ", string(&forge.version), ",");
        p!(f, "description: ", string(forge.description.trim()), ",");
    });
    p!(f, "} as const;");
    p!(f, "");
    f.doc("Every tool, by group and then by name.");
    p!(f, "export const tools: readonly ", tool, "[] = [");
    f.indent(|f| {
        for group in groups {
            let alias: Vec<String> = group.path().map(|name| name.camel()).collect();
            let ident = Module::group(*group)
                .sub("tools.ts")
                .ident("tools")
                .alias(format!("{}Tools", ts_identifier(&alias.join("_"))));
            p!(f, "...", ident, ",");
        }
    });
    p!(f, "];");
    f
}

/// Prints the property `key` with the value `value`, as JSON over as many
/// lines as it needs.
fn json_property(f: &mut ts::File, key: &str, value: &Value) {
    let json = serde_json::to_string_pretty(&sorted(value)).unwrap_or_else(|_| "null".to_owned());
    let mut lines = json.lines().peekable();
    let mut first = true;
    while let Some(line) = lines.next() {
        let last = lines.peek().is_none();
        let prefix = if first { format!("{key}: ") } else { String::new() };
        let suffix = if last { "," } else { "" };
        p!(f, prefix, line.to_owned(), suffix);
        first = false;
    }
}

/// Returns `value` with the keys of every object in it sorted, so that the
/// JSON it prints is the same whether or not serde_json's `preserve_order`
/// feature, which `forge normalize` turns on, keeps them in the order they
/// were inserted.
fn sorted(value: &Value) -> Value {
    let mut value = value.clone();
    value.sort_all_objects();
    value
}

/// Returns `s` as a TypeScript string literal.
fn string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Returns the path template `template` as the inside of the template literal
/// that the runtime's `encodePath` tags: its text, escaped, and the name of
/// each parameter where it goes, such as `/zones/${"zone_id"}`. [`check`] has
/// accepted the template.
fn path_template(template: &str) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
            break;
        };
        out.push_str(&template_text(&rest[..start]));
        out.push_str(&format!("${{{}}}", string(&rest[start + 1..start + len])));
        rest = &rest[start + len + 1..];
    }
    out.push_str(&template_text(rest));
    out
}

/// Returns `text` escaped for the inside of a template literal.
fn template_text(text: &str) -> String {
    text.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${")
}

/// Returns `s` with every character that can't be in an identifier replaced
/// by `_`, and `_` in front if it starts with a digit.
fn ts_identifier(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

#[cfg(test)]
mod tests {
    use forge::{File as _, Forge};

    use super::Generator;

    /// Returns the files the generator makes from `spec`, by path.
    fn generate(spec: &str) -> Vec<(String, String)> {
        let forge: Forge = serde_json::from_str(spec).unwrap();
        let mut files: Vec<(String, String)> = forge::run(&forge, &Generator)
            .unwrap()
            .into_iter()
            .map(|f| {
                let content = String::from_utf8(f.content().unwrap().into_owned()).unwrap();
                (f.path().to_owned(), content)
            })
            .collect();
        files.sort();
        files
    }

    /// Returns the file at `path`.
    fn file(files: &[(String, String)], path: &str) -> String {
        files
            .iter()
            .find(|(p, _)| p == path)
            .unwrap_or_else(|| panic!("no {path} in {:?}", files.iter().map(|(p, _)| p).collect::<Vec<_>>()))
            .1
            .clone()
    }

    const PETS: &str = r##"{
      "openapi": "3.1.0",
      "info": {"title": "Pets", "version": "2"},
      "servers": [{"url": "https://api.example.com/v1"}],
      "paths": {
        "/stores/{store_id}/pets": {
          "get": {
            "x-forge-group-name": "pets",
            "x-forge-method-name": "list",
            "summary": "List pets",
            "x-api-token-group": ["Pets Read"],
            "parameters": [
              {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
              {
                "name": "tag",
                "in": "query",
                "explode": false,
                "schema": {"type": "array", "items": {"type": "string"}}
              },
              {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
            ],
            "responses": {
              "200": {
                "description": "ok",
                "content": {
                  "application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}}
                }
              },
              "4XX": {"description": "failed"}
            }
          },
          "post": {
            "x-forge-group-name": "pets",
            "x-forge-method-name": "create",
            "x-forge-require-confirmation": "This adopts a pet.",
            "parameters": [
              {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}}
            ],
            "requestBody": {
              "required": true,
              "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}
            },
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/stores/{store_id}/pets/{pet_id}": {
          "delete": {
            "x-forge-group-name": "pets",
            "x-forge-method-name": "delete",
            "parameters": [
              {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "pet_id", "in": "path", "required": true, "schema": {"type": "integer"}}
            ],
            "responses": {"200": {"description": "ok"}}
          },
          "put": {
            "x-forge-group-name": "pets",
            "x-forge-method-name": "replace",
            "deprecated": true,
            "parameters": [
              {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
              {"name": "pet_id", "in": "path", "required": true, "schema": {"type": "integer"}}
            ],
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/stores/{store_id}/photos": {
          "post": {
            "x-forge-group-name": "pets.photos",
            "x-forge-method-name": "upload",
            "parameters": [
              {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}}
            ],
            "requestBody": {
              "required": true,
              "content": {"image/png": {"schema": {"type": "string"}}}
            },
            "responses": {"200": {"description": "ok"}}
          }
        }
      },
      "components": {
        "schemas": {
          "Pet": {
            "type": "object",
            "required": ["name"],
            "properties": {
              "id": {"type": "string", "readOnly": true},
              "name": {"type": "string"},
              "friends": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}
            }
          }
        }
      }
    }"##;

    #[test]
    fn files() {
        let paths: Vec<String> = generate(PETS).into_iter().map(|(path, _)| path).collect();
        assert_eq!(
            paths,
            [
                "_/tool.ts",
                "index.ts",
                "pets/outputs.ts",
                "pets/photos/tools.ts",
                "pets/schemas.ts",
                "pets/tools.ts"
            ]
        );
    }

    #[test]
    fn index() {
        let index = file(&generate(PETS), "index.ts");
        assert!(
            index.contains(r#"import { tools as petsTools } from "./pets/tools.js";"#),
            "{index}"
        );
        assert!(index.contains(r#"baseUrl: "https://api.example.com/v1","#), "{index}");
        assert!(index.contains("...petsTools,"), "{index}");
        assert!(
            index.contains("export { operation, registerTools } from './_/tool.js';"),
            "only what a server calls: {index}"
        );
        assert!(!index.contains("export *"), "{index}");
    }

    #[test]
    fn parameters() {
        let tools = file(&generate(PETS), "pets/tools.ts");
        assert!(
            tools.contains(r#"import { OPERATION, type Tool, encodePath } from "../_/tool.js";"#),
            "{tools}"
        );
        assert!(tools.contains(r#"name: "pets_list","#), "{tools}");
        assert!(tools.contains(r#"title: "List pets","#), "{tools}");
        let list = &tools[tools.find(r#"name: "pets_list","#).unwrap()..];
        let operation = &list[list.find("    [OPERATION]: {\n").unwrap()..];
        for field in [
            "      method: \"GET\",\n",
            "      path: \"/stores/{store_id}/pets\",\n",
            "      pathOf: encodePath`/stores/${\"store_id\"}/pets`,\n",
            "      query: [\n        { name: \"tag\", explode: false },\n      ],\n",
            "      headers: [\"x-trace\"],\n",
            "      extensions: {\n",
            "      responses: {\n",
        ] {
            assert!(operation.contains(field), "{field} under the operation: {operation}");
        }
        assert!(!tools.contains("request: ("), "the request is data, not code: {tools}");
        let list = &tools[tools.find(r#"name: "pets_list","#).unwrap()..];
        let input = &list[list.find("inputSchema: {").unwrap()..list.find("outputSchema").unwrap()];
        for place in [r#""path": {"#, r#""query": {"#, r#""headers": {"#] {
            assert!(input.contains(place), "parameters by where they go: {input}");
        }
        assert!(input.contains(r#""store_id": {"#), "keyed by wire name: {input}");
        assert!(
            input.contains(r#""x-trace": {"#),
            "a header by its name in lower case: {input}"
        );
        assert!(
            input.contains("required: [\n        \"path\"\n      ],"),
            "only the path is required: {input}"
        );
        assert!(tools.contains(r#""x-api-token-group": ["#), "{tools}");
        assert!(tools.contains(r#""readOnlyHint": true"#), "{tools}");
    }

    #[test]
    fn body_and_shared_models() {
        let files = generate(PETS);
        let tools = file(&files, "pets/tools.ts");
        assert!(
            tools.contains(r#"body: { mediaTypes: ["application/json"] },"#),
            "{tools}"
        );
        assert!(tools.contains(r#""Pet": Pet,"#), "{tools}");
        assert!(
            tools.contains("Confirm with the user before calling this tool. This adopts a pet."),
            "{tools}"
        );
        let schemas = file(&files, "pets/schemas.ts");
        assert!(
            schemas.contains(r#"import type { JSONObject } from "@modelcontextprotocol/server";"#),
            "{schemas}"
        );
        assert!(schemas.contains("export const Pet: JSONObject = {"), "{schemas}");
        assert!(schemas.contains(r##""$ref": "#/$defs/Pet""##), "{schemas}");
        assert!(!schemas.contains(r#""id""#), "read-only fields are left out: {schemas}");
    }

    #[test]
    fn responses() {
        let files = generate(PETS);
        let tools = file(&files, "pets/tools.ts");
        assert!(tools.contains("responses: {"), "{tools}");
        assert!(
            tools.contains(r#""4XX": null"#),
            "a response without a JSON body: {tools}"
        );
        assert!(tools.contains(r##""$ref": "#/$defs/Pet""##), "{tools}");
        assert!(tools.contains(r#""Pet": Pet,"#), "{tools}");
        let outputs = file(&files, "pets/outputs.ts");
        assert!(outputs.contains("export const Pet: JSONObject = {"), "{outputs}");
        assert!(
            outputs.contains(r#""id""#),
            "responses keep read-only fields: {outputs}"
        );
        assert!(
            !outputs.contains("description"),
            "responses have no descriptions: {outputs}"
        );
        let schemas = file(&files, "pets/schemas.ts");
        assert!(
            !schemas.contains(r#""id""#),
            "arguments still leave read-only fields out: {schemas}"
        );
    }

    #[test]
    fn output_schema() {
        let tools = file(&generate(PETS), "pets/tools.ts");
        let list = &tools[tools.find(r#"name: "pets_list","#).unwrap()..];
        let list = &list[..list.find("[OPERATION]: {").unwrap()];
        assert!(
            list.contains("outputSchema: {\n      \"items\": {\n        \"$ref\": \"#/$defs/Pet\"\n      },\n      \"type\": \"array\",\n      $defs: {\n        \"Pet\": Pet,\n      },\n    },"),
            "the 200 body, with its models: {list}"
        );
        let create = &tools[tools.find(r#"name: "pets_create","#).unwrap()..];
        let create = &create[..create.find("[OPERATION]: {").unwrap()];
        assert!(
            !create.contains("outputSchema"),
            "a successful response without a JSON body: {create}"
        );

        let tools = file(
            &generate(
                r##"{
                  "openapi": "3.1.0",
                  "info": {"title": "t", "version": "1"},
                  "paths": {
                    "/a": {
                      "post": {
                        "x-forge-group-name": "a",
                        "x-forge-method-name": "make",
                        "responses": {
                          "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": {"type": "string"}}}
                          },
                          "201": {
                            "description": "made",
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/A"}}}
                          },
                          "202": {
                            "description": "same",
                            "content": {"application/json": {"schema": {"type": "string"}}}
                          },
                          "4XX": {
                            "description": "failed",
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/E"}}}
                          }
                        }
                      }
                    }
                  },
                  "components": {
                    "schemas": {
                      "A": {"type": "object"},
                      "E": {"type": "object"}
                    }
                  }
                }"##,
            ),
            "a/tools.ts",
        );
        let output = &tools[tools.find("outputSchema: {").unwrap()..tools.find("annotations: ").unwrap()];
        assert!(output.contains(r#""anyOf": ["#), "the distinct 2xx bodies: {output}");
        assert_eq!(output.matches(r#""type": "string""#).count(), 1, "{output}");
        assert!(output.contains(r#""A": A,"#), "{output}");
        assert!(!output.contains(r#""E":"#), "error models are left out: {output}");
    }

    #[test]
    fn skips() {
        let files = generate(PETS);
        let tools = file(&files, "pets/tools.ts");
        assert!(
            !tools.contains("pets_replace"),
            "deprecated methods have no tool: {tools}"
        );
        assert_eq!(tools.matches("\n    name: ").count(), 3, "{tools}");
        let photos = file(&files, "pets/photos/tools.ts");
        assert!(
            photos.contains(r#"name: "pets_photos_upload","#),
            "a body in any media type gets a tool: {photos}"
        );
        let index = file(&files, "index.ts");
        assert!(index.contains("...pets_photosTools,"), "{index}");
    }

    /// A body in several media types is in the one the `content-type` header
    /// argument names, JSON by default, with the spec's schema for each; a
    /// string body of any other media type is sent as it is.
    #[test]
    fn bodies_in_any_media_type() {
        let files = generate(
            r##"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/values/{key}": {
                  "put": {
                    "x-forge-group-name": "kv",
                    "x-forge-method-name": "put",
                    "parameters": [
                      {"name": "key", "in": "path", "required": true, "schema": {"type": "string"}}
                    ],
                    "requestBody": {
                      "required": true,
                      "content": {
                        "multipart/form-data": {"schema": {
                          "type": "object",
                          "required": ["value"],
                          "properties": {
                            "value": {"type": "string", "format": "binary"},
                            "metadata": {"type": "object"}
                          }
                        }},
                        "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
                      }
                    },
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/query": {
                  "post": {
                    "x-forge-group-name": "kv",
                    "x-forge-method-name": "query",
                    "requestBody": {
                      "required": true,
                      "content": {
                        "text/plain": {"schema": {"type": "string"}},
                        "application/json": {"schema": {"type": "object", "properties": {"sql": {"type": "string"}}}}
                      }
                    },
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/sql": {
                  "post": {
                    "x-forge-group-name": "kv",
                    "x-forge-method-name": "sql",
                    "requestBody": {
                      "required": true,
                      "content": {"text/plain": {"schema": {"type": "string"}}}
                    },
                    "responses": {"200": {"description": "ok"}}
                  }
                }
              }
            }"##,
        );
        let tools = file(&files, "kv/tools.ts");
        let compact: String = tools.split_whitespace().collect();
        assert!(
            compact.contains(r#""enum":["application/octet-stream","multipart/form-data"]"#),
            "the media types the body takes: {tools}"
        );
        assert!(tools.contains(r#""description": "As multipart/form-data.""#), "{tools}");
        assert!(
            tools.contains(r#""description": "As application/octet-stream.""#),
            "{tools}"
        );
        assert!(tools.contains(r#""metadata": {"#), "the spec's form fields: {tools}");
        assert!(
            compact.contains(r#""filename":{"type":"string"}"#),
            "a file can be named: {tools}"
        );
        assert!(
            compact.contains(r#""enum":["application/json","text/plain"]"#),
            "the media types, in the spec's order: {tools}"
        );
        assert!(
            tools.contains(r#"headers: ["content-type"],"#),
            "sent as a header: {tools}"
        );
        assert!(
            tools.contains(r#"body: { mediaTypes: ["application/json", "text/plain"] },"#),
            "{tools}"
        );
        assert!(
            tools.contains(r#"body: { mediaTypes: ["text/plain"] },"#),
            "one media type: {tools}"
        );
        assert_eq!(
            tools.matches(r#""content-type": {"#).count(),
            2,
            "only with a choice: {tools}"
        );
    }

    #[test]
    fn names() {
        let files = generate(
            r#"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/a": {
                  "get": {
                    "x-forge-group-name": "a.b",
                    "x-forge-method-name": "c",
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/b": {
                  "get": {
                    "x-forge-group-name": "a",
                    "x-forge-method-name": "b_c",
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/c": {
                  "get": {
                    "x-forge-group-name": "web_assets.discovery",
                    "x-forge-method-name": "bulk_edit",
                    "responses": {"200": {"description": "ok"}}
                  }
                }
              }
            }"#,
        );
        assert!(file(&files, "a/b/tools.ts").contains(r#"name: "a_b_c","#));
        assert!(file(&files, "a/tools.ts").contains(r#"name: "a_bC","#));
        assert!(file(&files, "webAssets/discovery/tools.ts").contains(r#"name: "webAssets_discovery_bulkEdit","#));
    }

    /// Two names of methods in a group can have the same camelCase
    /// spelling, since a digit belongs to the word before it.
    #[test]
    fn same_spelling() {
        let files = generate(
            r#"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/a": {
                  "get": {
                    "x-forge-group-name": "a",
                    "x-forge-method-name": "x1b",
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/b": {
                  "get": {
                    "x-forge-group-name": "a",
                    "x-forge-method-name": "x_1b",
                    "responses": {"200": {"description": "ok"}}
                  }
                }
              }
            }"#,
        );
        let tools = file(&files, "a/tools.ts");
        assert_eq!(tools.matches("\n    name: ").count(), 1, "one tool for both: {tools}");
        assert!(tools.contains(r#"name: "a_x1b","#), "{tools}");
    }

    /// A model is a constant in the group it's placed in, which tools of
    /// other groups import, and its key depends only on its schema name.
    #[test]
    fn models_across_groups() {
        let files = generate(
            r##"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/a": {
                  "get": {
                    "x-forge-group-name": "a.x",
                    "x-forge-method-name": "get",
                    "responses": {"200": {
                      "description": "ok",
                      "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Shared$1"}}}
                    }}
                  }
                },
                "/b": {
                  "post": {
                    "x-forge-group-name": "a.y",
                    "x-forge-method-name": "make",
                    "requestBody": {
                      "required": true,
                      "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Shared$1"}}}
                    },
                    "responses": {"200": {"description": "ok"}}
                  }
                },
                "/c": {
                  "get": {
                    "x-forge-group-name": "b",
                    "x-forge-method-name": "get",
                    "responses": {"200": {
                      "description": "ok",
                      "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Top"}}}
                    }}
                  }
                }
              },
              "components": {
                "schemas": {
                  "Shared$1": {"type": "object", "properties": {"top": {"$ref": "#/components/schemas/Top"}}},
                  "Top": {"type": "object", "properties": {"n": {"type": "integer"}}}
                }
              }
            }"##,
        );
        let paths: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        assert!(
            paths.contains(&"a/schemas.ts") && paths.contains(&"a/outputs.ts"),
            "{paths:?}"
        );
        assert!(
            paths.contains(&"outputs.ts") && paths.contains(&"schemas.ts"),
            "{paths:?}"
        );
        assert!(!paths.contains(&"a/x/schemas.ts"), "only models a tool uses: {paths:?}");
        let x = file(&files, "a/x/tools.ts");
        assert!(x.contains(r#""Shared.241": Shared$241,"#), "{x}");
        assert!(x.contains(r#""Top": Top,"#), "{x}");
        assert!(x.contains(r#"from "../outputs.js""#), "{x}");
        assert!(x.contains(r#"from "../../outputs.js""#), "{x}");
        let shared = file(&files, "a/outputs.ts");
        assert!(shared.contains(r##""$ref": "#/$defs/Top""##), "{shared}");
    }

    /// Two models whose names have the same words, such as the schemas
    /// `logs-list` and `logs_list`, still get a constant each: constants are
    /// named after the `$defs` key, which is unique.
    #[test]
    fn models_with_the_same_name() {
        let files = generate(
            r##"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/a": {
                  "post": {
                    "x-forge-group-name": "a",
                    "x-forge-method-name": "make",
                    "requestBody": {
                      "required": true,
                      "content": {"application/json": {"schema": {
                        "type": "object",
                        "properties": {
                          "x": {"$ref": "#/components/schemas/logs-list"},
                          "y": {"$ref": "#/components/schemas/logs_list"},
                          "z": {"$ref": "#/components/schemas/2fa"}
                        }
                      }}}
                    },
                    "responses": {"200": {"description": "ok"}}
                  }
                }
              },
              "components": {
                "schemas": {
                  "logs-list": {"type": "object"},
                  "logs_list": {"type": "object", "required": ["a"]},
                  "2fa": {"type": "array"}
                }
              }
            }"##,
        );
        let schemas = file(&files, "a/schemas.ts");
        assert!(schemas.contains("export const logs$$list: JSONObject = {"), "{schemas}");
        assert!(schemas.contains("export const logs_list: JSONObject = {"), "{schemas}");
        assert!(schemas.contains("export const $_2fa: JSONObject = {"), "{schemas}");
        let tools = file(&files, "a/tools.ts");
        assert!(tools.contains(r#""logs-list": logs$$list,"#), "{tools}");
        assert!(tools.contains(r#""logs_list": logs_list,"#), "{tools}");
    }

    /// A model that is only a scalar or an enum is written where it is
    /// used, not as a `$ref`; descriptions are trimmed; arguments can't have
    /// properties the tool doesn't take; and the description ends with the
    /// method and path.
    #[test]
    fn compact_input_schemas() {
        let files = generate(
            r##"{
              "openapi": "3.1.0",
              "info": {"title": "t", "version": "1"},
              "paths": {
                "/zones/{zone_id}": {
                  "get": {
                    "x-forge-group-name": "zones",
                    "x-forge-method-name": "get",
                    "description": "Gets a zone.\n",
                    "parameters": [
                      {
                        "name": "zone_id",
                        "in": "path",
                        "required": true,
                        "description": "The zone.\n",
                        "schema": {"$ref": "#/components/schemas/identifier"}
                      },
                      {"name": "kind", "in": "query", "schema": {"$ref": "#/components/schemas/kind"}}
                    ],
                    "responses": {"200": {"description": "ok"}}
                  }
                }
              },
              "components": {
                "schemas": {
                  "identifier": {"type": "string", "description": "Identifier."},
                  "kind": {"type": "string", "enum": ["full", "partial"]}
                }
              }
            }"##,
        );
        let tools = file(&files, "zones/tools.ts");
        assert!(!tools.contains("$defs"), "scalar models are inline: {tools}");
        assert!(
            !files.iter().any(|(path, _)| path.ends_with("schemas.ts")),
            "no constants for them"
        );
        assert!(
            tools.contains(r#""description": "The zone.","#),
            "trimmed, the field's own: {tools}"
        );
        assert!(tools.contains(r#""enum": ["#), "{tools}");
        assert_eq!(
            tools.matches(r#""additionalProperties": false"#).count(),
            2,
            "path and query: {tools}"
        );
        assert!(
            tools.contains("additionalProperties: false,"),
            "and the arguments: {tools}"
        );
        assert!(
            tools.contains(r#"description: "Gets a zone.\n\nGET /zones/{zone_id}","#),
            "{tools}"
        );
    }

    /// Every source of the runtime library is embedded.
    #[test]
    fn runtime_is_complete() {
        let dir: std::path::PathBuf = [env!("CARGO_MANIFEST_DIR"), "src/bin/forge/mcp/lib/src"]
            .iter()
            .collect();
        let mut paths: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        paths.sort();
        let embedded: Vec<&str> = super::RUNTIME.iter().map(|&(path, _)| path).collect();
        assert_eq!(paths, embedded);
    }

    #[test]
    fn path_template() {
        assert_eq!(
            super::path_template("/zones/{zone_id}/dns_records/{id}"),
            r#"/zones/${"zone_id"}/dns_records/${"id"}"#
        );
        assert_eq!(super::path_template("/zones"), "/zones");
        assert_eq!(super::path_template("/a`b\\c$/{d}"), r#"/a\`b\\c$/${"d"}"#);
        assert_eq!(super::path_template("/x${d}"), r#"/x$${"d"}"#, "a $ before a parameter");
    }
}
