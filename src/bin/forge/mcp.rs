//! The MCP generator. It generates the tools of an MCP server in
//! TypeScript, as data a server lists and calls, typed for the official MCP
//! TypeScript SDK, `@modelcontextprotocol/server`. It generates no server:
//! each server lists and calls the tools in its own way.
//!
//! Every group with tools gets a `tools.ts` in its directory: the tools of
//! its methods, each with the JSON Schema of its arguments, its hints, the
//! JSON Schemas of its response bodies, its output schema, and a `request`
//! function that builds its API request. Response schemas are for the
//! server, to check responses against; `tools/list` doesn't send them. The
//! output schema is the schema of a successful response's JSON body, which
//! `listTools` sends only when asked. A group's `schemas.ts` and
//! `outputs.ts` hold the schemas of the models placed in it. The root gets
//! an `index.ts` with every tool and the runtime, a `README.md` that lists
//! the methods without a tool and why, the top-level models' schemas, and
//! the runtime itself in `_/tool.ts`: the tool type, listing tools, and
//! building a call's request as plain data. The runtime imports nothing, so
//! a server can load the tools anywhere.
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
use std::fmt::Write as _;

use forge::ts::{self, Ident, Module, PREAMBLE, p};
use forge::{Availability, Err, Field, Forge, Group, HttpMethod, Location, Method, Model, Name, Plugin, Type};
use serde_json::{Map, Value, json};

mod schema;

use schema::{Direction, Refs, Schemas, reach};

/// Generates an MCP server.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the root: `index.ts` with every tool,
    /// `README.md`, the runtime, and the schemas of the top-level models.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let mut groups = Vec::new();
        let mut count = 0;
        let mut skipped = Vec::new();
        for group in forge.groups() {
            let before = count;
            for (m, verdict) in verdicts(group) {
                match verdict {
                    Ok(_) => count += 1,
                    Err(reason) => skipped.push((m, reason)),
                }
            }
            if count > before {
                groups.push(group);
            }
        }

        let mut files = model_files(Module::ROOT, forge.models(), forge.groups());
        files.push(File::Ts(index(forge, &groups)));
        files.push(File::Text {
            path: "README.md".to_owned(),
            content: readme(count, groups.len(), &skipped),
        });
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
        for (m, verdict) in verdicts(group) {
            if let Ok(name) = verdict {
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

/// The sources of the runtime library, by path in lib/src.
const RUNTIME: [(&str, &str); 1] = [("tool.ts", include_str!("mcp/lib/src/tool.ts"))];

/// MCP tool names are at most 128 characters.
const MAX_NAME_LENGTH: usize = 128;

/// Returns each method of `group` that isn't deprecated, with the name of
/// its tool, or why it has none. Deprecated methods are left out silently.
///
/// Forge keeps the names of a group's methods unique, but two can still
/// have the same camelCase spelling, since a digit belongs to the word
/// before it: `x1b` and `x_1b`. The first method by name keeps the tool
/// name. Groups whose paths have the same spelling share a directory, which
/// [`forge::write`] refuses.
fn verdicts(group: Group<'_>) -> Vec<(Method<'_>, Result<String, String>)> {
    let mut names = HashSet::new();
    group
        .methods()
        .filter(|m| !m.is_deprecated())
        .map(|m| {
            let verdict = check(m).and_then(|name| {
                if names.insert(name.clone()) {
                    Ok(name)
                } else {
                    Err(format!("another method has the tool name {name}"))
                }
            });
            (m, verdict)
        })
        .collect()
}

/// Returns the name of the tool of `m`, or why it can't have one, without
/// building its schemas.
fn check(m: Method<'_>) -> Result<String, String> {
    let name = tool_name(m);
    if name.len() > MAX_NAME_LENGTH {
        return Err(format!("the tool name is over {MAX_NAME_LENGTH} characters"));
    }
    if let Some(b) = m.body()
        && b.json().is_none()
        && b.is_required()
    {
        let types: Vec<&str> = b.contents().map(|c| c.media_type()).collect();
        return Err(format!("the request body is not JSON ({})", types.join(", ")));
    }
    segments(m.path(), &path_names(m))?;
    Ok(name)
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
    if let Some(b) = m.body()
        && let Some(content) = b.json()
    {
        types.push(content.ty());
    }
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
    /// The path template, split into text and the parameters that fill it.
    path: Vec<Segment>,
    /// Each query parameter's wire name, and whether it is exploded.
    query: Vec<(String, bool)>,
    /// Each header parameter's wire name.
    headers: Vec<String>,
    /// The media type of the JSON body.
    body: Option<String>,
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

/// A part of a path template.
enum Segment {
    Text(String),
    /// A path parameter, by wire name.
    Param(String),
}

/// The parameters of a tool in one place, `path`, `query` or `headers`: the
/// argument that holds them, an object keyed by their wire names.
#[derive(Default)]
struct Params {
    properties: Map<String, Value>,
    required: Vec<String>,
}

impl Params {
    /// Adds `field`, a parameter that is required if `required`.
    fn add<'f>(&mut self, field: Field<'f>, required: bool, refs: &mut Refs<'f>) {
        let key = field.wire_name().to_owned();
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
                Some(Location::Path) => path_params.add(field, true, &mut refs),
                Some(Location::Query { exploded }) => {
                    query_params.add(field, field.is_required(), &mut refs);
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
            header_params.add(field, field.is_required(), &mut refs);
            headers.push(field.wire_name().to_owned());
        }

        let mut properties = Map::new();
        let mut required = Vec::new();
        path_params.insert_into("path", &mut properties, &mut required);
        query_params.insert_into("query", &mut properties, &mut required);
        header_params.insert_into("headers", &mut properties, &mut required);

        let mut body = None;
        if let Some(b) = m.body()
            && let Some(content) = b.json()
        {
            let mut schema = Schemas::INPUT.ty(content.ty(), &mut refs);
            if let Value::Object(map) = &mut schema
                && !b.description().is_empty()
            {
                map.insert("description".to_owned(), json!(b.description()));
            }
            properties.insert("body".to_owned(), schema);
            if b.is_required() {
                required.push("body".to_owned());
            }
            body = Some(content.media_type().to_owned());
        }

        let path = segments(m.path(), &path_names(m))?;
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
            path,
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

/// Returns `template` split into text and the path parameters that fill
/// it, given their wire names.
fn segments(template: &str, names: &[&str]) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
            break;
        };
        let wire = &rest[start + 1..start + len];
        if !names.contains(&wire) {
            return Err(format!("the path parameter {wire} has no argument"));
        }
        if start > 0 {
            segments.push(Segment::Text(rest[..start].to_owned()));
        }
        segments.push(Segment::Param(wire.to_owned()));
        rest = &rest[start + len + 1..];
    }
    if !rest.is_empty() {
        segments.push(Segment::Text(rest.to_owned()));
    }
    Ok(segments)
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
    let mut paragraphs = vec![if !description.is_empty() {
        description.to_owned()
    } else if !summary.is_empty() {
        summary.to_owned()
    } else {
        format!("{} {}", m.http_method().as_str(), m.path())
    }];
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
        for (m, verdict) in verdicts(group) {
            if verdict.is_err() {
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
    let schema_type = RUNTIME_TOOL.ident("JsonSchema").ty();
    let doc = match kind {
        SchemaFile::Input => "",
        SchemaFile::Output => " in responses",
    };
    for &model in models {
        let ident = f.ident(model_ident(model, kind).name);
        f.doc(&format!("The schema of `{}`{doc}.", model.schema_name()));
        let json = serde_json::to_string_pretty(&kind.schemas().model(model)).unwrap_or_else(|_| "{}".to_owned());
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
    let path_param = RUNTIME_TOOL.ident("pathParam");
    let param = RUNTIME_TOOL.ident("param");
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
                if let Some(Value::Object(output)) = &t.output {
                    p!(f, "outputSchema: {");
                    f.indent(|f| {
                        for (key, value) in output {
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
                p!(f, "method: ", string(m.http_method().as_str()), ",");
                p!(f, "path: ", string(m.path()), ",");
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
                let args = if t.query.is_empty()
                    && t.headers.is_empty()
                    && t.body.is_none()
                    && !t.path.iter().any(|s| matches!(s, Segment::Param(_)))
                {
                    "_args"
                } else {
                    "args"
                };
                p!(f, "request: (", args, ") => ({");
                f.indent(|f| {
                    let mut parts: Vec<Box<dyn ts::Print>> = vec![Box::new("path: `".to_owned())];
                    for segment in &t.path {
                        match segment {
                            Segment::Text(text) => parts.push(Box::new(template_text(text))),
                            Segment::Param(wire) => {
                                parts.push(Box::new("${".to_owned()));
                                parts.push(Box::new(path_param.clone()));
                                parts.push(Box::new(format!("(args, {})}}", string(wire))));
                            }
                        }
                    }
                    parts.push(Box::new("`,".to_owned()));
                    let parts: Vec<&dyn ts::Print> = parts.iter().map(AsRef::as_ref).collect();
                    f.line(&parts);
                    if !t.query.is_empty() {
                        p!(f, "query: [");
                        f.indent(|f| {
                            for (wire, explode) in &t.query {
                                p!(
                                    f,
                                    "[",
                                    string(wire),
                                    ", ",
                                    param.clone(),
                                    "(args, \"query\", ",
                                    string(wire),
                                    "), ",
                                    explode.to_string(),
                                    "],"
                                );
                            }
                        });
                        p!(f, "],");
                    }
                    if !t.headers.is_empty() {
                        p!(f, "headers: [");
                        f.indent(|f| {
                            for wire in &t.headers {
                                p!(
                                    f,
                                    "[",
                                    string(wire),
                                    ", ",
                                    param.clone(),
                                    "(args, \"headers\", ",
                                    string(wire),
                                    ")],"
                                );
                            }
                        });
                        p!(f, "],");
                    }
                    if let Some(media_type) = &t.body {
                        p!(
                            f,
                            "body: { value: args[\"body\"], mediaType: ",
                            string(media_type),
                            " },"
                        );
                    }
                });
                p!(f, "}),");
            });
            p!(f, "},");
        }
    });
    p!(f, "];");
    f
}

/// Returns the `index.ts` of the root: the API, and every tool of `groups`,
/// the groups with tools.
fn index(forge: &Forge, groups: &[Group<'_>]) -> ts::File {
    let mut f = ts::File::new(Module::ROOT.sub("index.ts"));
    let tool = RUNTIME_TOOL.ident("Tool").ty();
    p!(f, "export * from './_/tool.js';");
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

/// Returns the README.md of the server: how many tools it has, in how many
/// groups, and each method without one and why.
fn readme(count: usize, groups: usize, skipped: &[(Method<'_>, String)]) -> String {
    let mut out = String::from("<!-- Code generated by forge. DO NOT EDIT. -->\n\n# MCP tools\n\n");
    let _ = writeln!(
        out,
        "{count} tools in {groups} groups. `index.ts` exports them as `tools`, with the runtime in `_/tool.ts` that lists them and builds their requests."
    );
    if !skipped.is_empty() {
        let _ = writeln!(
            out,
            "\n## Methods without a tool\n\n| Method | Path | Why |\n| --- | --- | --- |"
        );
        for (m, reason) in skipped {
            let _ = writeln!(
                out,
                "| `{}` | `{}` | {} |",
                m.http_method().as_str(),
                m.path(),
                reason.replace('|', "\\|")
            );
        }
    }
    out
}

/// Prints the property `key` with the value `value`, as JSON over as many
/// lines as it needs.
fn json_property(f: &mut ts::File, key: &str, value: &Value) {
    let json = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_owned());
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

/// Returns `s` as a TypeScript string literal.
fn string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
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

    const PETS: &str = r##"{"openapi": "3.1.0", "info": {"title": "Pets", "version": "2"},
        "servers": [{"url": "https://api.example.com/v1"}],
        "paths": {
            "/stores/{store_id}/pets": {
                "get": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "list",
                    "summary": "List pets", "x-api-token-group": ["Pets Read"],
                    "parameters": [
                        {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
                        {"name": "tag", "in": "query", "explode": false,
                         "schema": {"type": "array", "items": {"type": "string"}}},
                        {"name": "X-Trace", "in": "header", "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": {"description": "ok", "content": {"application/json": {
                            "schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}}}},
                        "4XX": {"description": "failed"}}},
                "post": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "create",
                    "x-forge-require-confirmation": "This adopts a pet.",
                    "parameters": [{"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}}],
                    "requestBody": {"required": true, "content": {"application/json": {
                        "schema": {"$ref": "#/components/schemas/Pet"}}}},
                    "responses": {"200": {"description": "ok"}}}
            },
            "/stores/{store_id}/pets/{pet_id}": {
                "delete": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "delete",
                    "parameters": [
                        {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
                        {"name": "pet_id", "in": "path", "required": true, "schema": {"type": "integer"}}
                    ],
                    "responses": {"200": {"description": "ok"}}},
                "put": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "replace", "deprecated": true,
                    "parameters": [
                        {"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}},
                        {"name": "pet_id", "in": "path", "required": true, "schema": {"type": "integer"}}
                    ],
                    "responses": {"200": {"description": "ok"}}}
            },
            "/stores/{store_id}/photos": {
                "post": {"x-fern-sdk-group-name": "pets.photos", "x-fern-sdk-method-name": "upload",
                    "parameters": [{"name": "store_id", "in": "path", "required": true, "schema": {"type": "string"}}],
                    "requestBody": {"required": true, "content": {"image/png": {"schema": {"type": "string"}}}},
                    "responses": {"200": {"description": "ok"}}}
            }
        },
        "components": {"schemas": {"Pet": {"type": "object", "required": ["name"],
            "properties": {"id": {"type": "string", "readOnly": true}, "name": {"type": "string"},
                           "friends": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}}}}}}"##;

    #[test]
    fn files() {
        let paths: Vec<String> = generate(PETS).into_iter().map(|(path, _)| path).collect();
        assert_eq!(
            paths,
            [
                "README.md",
                "_/tool.ts",
                "index.ts",
                "pets/outputs.ts",
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
        assert!(index.contains("export * from './_/tool.js';"), "{index}");
    }

    #[test]
    fn parameters() {
        let tools = file(&generate(PETS), "pets/tools.ts");
        assert!(tools.contains(r#"name: "pets_list","#), "{tools}");
        assert!(tools.contains(r#"title: "List pets","#), "{tools}");
        assert!(
            tools.contains(r#"path: `/stores/${pathParam(args, "store_id")}/pets`,"#),
            "{tools}"
        );
        assert!(
            tools.contains(r#"["tag", param(args, "query", "tag"), false],"#),
            "{tools}"
        );
        assert!(
            tools.contains(r#"["X-Trace", param(args, "headers", "X-Trace")],"#),
            "{tools}"
        );
        let list = &tools[tools.find(r#"name: "pets_list","#).unwrap()..];
        let input = &list[list.find("inputSchema: {").unwrap()..list.find("outputSchema").unwrap()];
        for place in [r#""path": {"#, r#""query": {"#, r#""headers": {"#] {
            assert!(input.contains(place), "parameters by where they go: {input}");
        }
        assert!(input.contains(r#""store_id": {"#), "keyed by wire name: {input}");
        assert!(input.contains(r#""X-Trace": {"#), "keyed by wire name: {input}");
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
            tools.contains(r#"body: { value: args["body"], mediaType: "application/json" },"#),
            "{tools}"
        );
        assert!(tools.contains(r#""Pet": Pet,"#), "{tools}");
        assert!(
            tools.contains("Confirm with the user before calling this tool. This adopts a pet."),
            "{tools}"
        );
        let schemas = file(&files, "pets/schemas.ts");
        assert!(schemas.contains("export const Pet: JsonSchema = {"), "{schemas}");
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
        assert!(outputs.contains("export const Pet: JsonSchema = {"), "{outputs}");
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
        let list = &list[..list.find("request: ").unwrap()];
        assert!(
            list.contains("outputSchema: {\n      \"items\": {\n        \"$ref\": \"#/$defs/Pet\"\n      },\n      \"type\": \"array\",\n      $defs: {\n        \"Pet\": Pet,\n      },\n    },"),
            "the 200 body, with its models: {list}"
        );
        let create = &tools[tools.find(r#"name: "pets_create","#).unwrap()..];
        let create = &create[..create.find("request: ").unwrap()];
        assert!(
            !create.contains("outputSchema"),
            "a successful response without a JSON body: {create}"
        );

        let tools = file(
            &generate(
                r##"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "make",
                    "responses": {
                        "200": {"description": "ok", "content": {"application/json": {"schema": {"type": "string"}}}},
                        "201": {"description": "made", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/A"}}}},
                        "202": {"description": "same", "content": {"application/json": {"schema": {"type": "string"}}}},
                        "4XX": {"description": "failed", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/E"}}}}}}}},
                "components": {"schemas": {"A": {"type": "object"}, "E": {"type": "object"}}}}"##,
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
        assert!(!files.iter().any(|(path, _)| path == "pets/photos/tools.ts"));
        let readme = file(&files, "README.md");
        assert!(readme.contains("3 tools in 1 groups."), "{readme}");
        assert!(
            readme.contains("| `POST` | `/stores/{store_id}/photos` | the request body is not JSON (image/png) |"),
            "{readme}"
        );
    }

    #[test]
    fn names() {
        let files = generate(
            r#"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {
                    "/a": {"get": {"x-fern-sdk-group-name": "a.b", "x-fern-sdk-method-name": "c",
                        "responses": {"200": {"description": "ok"}}}},
                    "/b": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "b_c",
                        "responses": {"200": {"description": "ok"}}}},
                    "/c": {"get": {"x-fern-sdk-group-name": "web_assets.discovery", "x-fern-sdk-method-name": "bulk_edit",
                        "responses": {"200": {"description": "ok"}}}}
                }}"#,
        );
        assert!(file(&files, "a/b/tools.ts").contains(r#"name: "a_b_c","#));
        assert!(file(&files, "a/tools.ts").contains(r#"name: "a_bC","#));
        assert!(file(&files, "webAssets/discovery/tools.ts").contains(r#"name: "webAssets_discovery_bulkEdit","#));
        assert!(!file(&files, "README.md").contains("Methods without a tool"));
    }

    /// Two names of methods in a group can have the same camelCase
    /// spelling, since a digit belongs to the word before it.
    #[test]
    fn same_spelling() {
        let files = generate(
            r#"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {
                    "/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "x1b",
                        "responses": {"200": {"description": "ok"}}}},
                    "/b": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "x_1b",
                        "responses": {"200": {"description": "ok"}}}}
                }}"#,
        );
        let tools = file(&files, "a/tools.ts");
        assert_eq!(tools.matches(r#"name: "a_x1b","#).count(), 1, "{tools}");
        let readme = file(&files, "README.md");
        assert!(readme.contains("1 tools in 1 groups."), "{readme}");
        assert!(readme.contains("another method has the tool name a_x1b"), "{readme}");
    }

    /// A model is a constant in the group it's placed in, which tools of
    /// other groups import, and its key depends only on its schema name.
    #[test]
    fn models_across_groups() {
        let files = generate(
            r##"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {
                    "/a": {"get": {"x-fern-sdk-group-name": "a.x", "x-fern-sdk-method-name": "get",
                        "responses": {"200": {"description": "ok", "content": {"application/json": {
                            "schema": {"$ref": "#/components/schemas/Shared$1"}}}}}}},
                    "/b": {"post": {"x-fern-sdk-group-name": "a.y", "x-fern-sdk-method-name": "make",
                        "requestBody": {"required": true, "content": {"application/json": {
                            "schema": {"$ref": "#/components/schemas/Shared$1"}}}},
                        "responses": {"200": {"description": "ok"}}}},
                    "/c": {"get": {"x-fern-sdk-group-name": "b", "x-fern-sdk-method-name": "get",
                        "responses": {"200": {"description": "ok", "content": {"application/json": {
                            "schema": {"$ref": "#/components/schemas/Top"}}}}}}}
                },
                "components": {"schemas": {
                    "Shared$1": {"type": "object", "properties": {"top": {"$ref": "#/components/schemas/Top"}}},
                    "Top": {"type": "string"}}}}"##,
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
            r##"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {"/a": {"post": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "make",
                    "requestBody": {"required": true, "content": {"application/json": {"schema": {
                        "type": "object", "properties": {
                            "x": {"$ref": "#/components/schemas/logs-list"},
                            "y": {"$ref": "#/components/schemas/logs_list"},
                            "z": {"$ref": "#/components/schemas/2fa"}}}}}},
                    "responses": {"200": {"description": "ok"}}}}},
                "components": {"schemas": {"logs-list": {"type": "string"}, "logs_list": {"type": "integer"},
                    "2fa": {"type": "boolean"}}}}"##,
        );
        let schemas = file(&files, "a/schemas.ts");
        assert!(schemas.contains("export const logs$$list: JsonSchema = {"), "{schemas}");
        assert!(schemas.contains("export const logs_list: JsonSchema = {"), "{schemas}");
        assert!(schemas.contains("export const $_2fa: JsonSchema = {"), "{schemas}");
        let tools = file(&files, "a/tools.ts");
        assert!(tools.contains(r#""logs-list": logs$$list,"#), "{tools}");
        assert!(tools.contains(r#""logs_list": logs_list,"#), "{tools}");
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
    fn template_text() {
        assert_eq!(super::template_text("/a`b${c}\\"), "/a\\`b\\${c}\\\\");
    }
}
