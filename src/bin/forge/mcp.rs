//! The MCP server generator. It generates TypeScript for the official MCP
//! TypeScript SDK, `@modelcontextprotocol/server`.
//!
//! Every group with tools gets a `tools.ts` in its directory: the tools of
//! its methods, each with the JSON Schema of its arguments, its hints, and
//! a `request` function that builds its API request. The root gets an
//! `index.ts` with every tool, a `README.md` that lists the methods without
//! a tool and why, and the runtime library in `_/`, which serves the tools
//! on an `McpServer` and sends their requests. `index.ts` re-exports only
//! the half of the runtime that doesn't import the MCP SDK, `_/tool.ts`, so
//! a server can load the tools as a module of their own.
//!
//! A tool is named after its groups and method, in snake_case and joined by
//! `_`, such as `dns_records_create`. Its path, query and header parameters
//! are arguments named after the parameter in snake_case, and a JSON body is
//! the argument `body`, as the API takes it.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use forge::ts::{self, Ident, Module, PREAMBLE, p};
use forge::{Availability, Err, Field, Forge, Group, HttpMethod, Location, Method, Model, Plugin, Type};
use serde_json::{Map, Value, json};

mod schema;

use schema::{Refs, Schemas};

/// Generates an MCP server.
pub struct Generator;

impl Plugin for Generator {
    type File = File;

    /// Returns every file. Tool names must be unique across groups, so the
    /// files of the groups are generated here too, rather than one group at
    /// a time.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let mut schemas = Schemas::default();
        let mut names = HashSet::new();
        let mut skipped = Vec::new();
        let mut groups = Vec::new();
        for group in forge.groups() {
            let mut tools = Vec::new();
            for m in group.methods() {
                if m.is_deprecated() {
                    continue;
                }
                match Tool::new(m, &mut schemas) {
                    Ok(tool) if names.insert(tool.name.clone()) => tools.push(tool),
                    Ok(tool) => skipped.push((m, format!("another method has the tool name {}", tool.name))),
                    Err(reason) => skipped.push((m, reason)),
                }
            }
            if !tools.is_empty() {
                tools.sort_by(|a, b| a.name.cmp(&b.name));
                groups.push((group, tools));
            }
        }

        let (schema_files, idents) = schema_files(&schemas);
        let mut files: Vec<File> = groups
            .iter()
            .map(|(group, tools)| File::Ts(tools_file(*group, tools, &idents)))
            .collect();
        files.extend(schema_files.into_iter().map(File::Ts));
        files.push(File::Ts(index(forge, &groups)));
        files.push(File::Text {
            path: "README.md".to_owned(),
            content: readme(&groups, &skipped),
        });
        files.extend(RUNTIME.iter().map(|&(path, source)| File::Text {
            path: RUNTIME_DIR.sub(path).as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        }));
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
/// tool type and request helpers, which don't import the MCP SDK.
const RUNTIME_TOOL: Module = Module::new("_/tool.ts");

/// The sources of the runtime library, by path in lib/src.
const RUNTIME: [(&str, &str); 3] = [
    ("index.ts", include_str!("mcp/lib/src/index.ts")),
    ("server.ts", include_str!("mcp/lib/src/server.ts")),
    ("tool.ts", include_str!("mcp/lib/src/tool.ts")),
];

/// MCP tool names are at most 128 characters.
const MAX_NAME_LENGTH: usize = 128;

/// The tool of a method.
struct Tool<'f> {
    method: Method<'f>,
    name: String,
    /// The properties of the input schema, and those that are required.
    properties: Value,
    required: Vec<String>,
    /// The models in the input schema's `$defs`, by key.
    defs: BTreeMap<String, Model<'f>>,
    /// The path template, split into text and the keys of the arguments
    /// that fill its parameters.
    path: Vec<Segment>,
    /// Each query parameter's wire name, argument key, and whether it is
    /// exploded.
    query: Vec<(String, String, bool)>,
    /// Each header parameter's wire name and argument key.
    headers: Vec<(String, String)>,
    /// The argument key and media type of the JSON body.
    body: Option<(String, String)>,
}

/// A part of a path template.
enum Segment {
    Text(String),
    /// A parameter, filled by the argument with this key.
    Param(String),
}

impl<'f> Tool<'f> {
    /// Returns the tool of `m`, or why it has none.
    fn new(m: Method<'f>, schemas: &mut Schemas<'f>) -> Result<Tool<'f>, String> {
        let name = tool_name(m);
        if name.len() > MAX_NAME_LENGTH {
            return Err(format!("the tool name is over {MAX_NAME_LENGTH} characters"));
        }
        let mut refs = Refs::new();
        let mut properties = Map::new();
        let mut required = Vec::new();
        let mut keys = Keys::default();
        let mut path_keys = Vec::new();
        let mut query = Vec::new();
        let mut headers = Vec::new();

        for field in parameters(m.request()) {
            let Some(location) = m.location(field) else {
                continue;
            };
            let key = match location {
                Location::Path => keys.add(field, "path")?,
                Location::Query { .. } => keys.add(field, "query")?,
            };
            properties.insert(key.clone(), schemas.field(field, &mut refs));
            if field.is_required() || location == Location::Path {
                required.push(key.clone());
            }
            match location {
                Location::Path => path_keys.push((field.wire_name().to_owned(), key)),
                Location::Query { exploded } => query.push((field.wire_name().to_owned(), key, exploded)),
            }
        }
        for field in m
            .headers()
            .into_iter()
            .flat_map(|h| h.fields())
            .filter(|f| !f.is_read_only())
        {
            let key = keys.add(field, "header")?;
            properties.insert(key.clone(), schemas.field(field, &mut refs));
            if field.is_required() {
                required.push(key.clone());
            }
            headers.push((field.wire_name().to_owned(), key));
        }

        let mut body = None;
        if let Some(b) = m.body() {
            if let Some(content) = b.json() {
                let key = if keys.taken.contains("body") {
                    "request_body"
                } else {
                    "body"
                };
                if !keys.taken.insert(key.to_owned()) {
                    return Err(format!("two arguments are both named {key}"));
                }
                let mut schema = schemas.ty(content.ty(), &mut refs);
                if let Value::Object(map) = &mut schema
                    && !b.description().is_empty()
                {
                    map.insert("description".to_owned(), json!(b.description()));
                }
                properties.insert(key.to_owned(), schema);
                if b.is_required() {
                    required.push(key.to_owned());
                }
                body = Some((key.to_owned(), content.media_type().to_owned()));
            } else if b.is_required() {
                let types: Vec<&str> = b.contents().map(|c| c.media_type()).collect();
                return Err(format!("the request body is not JSON ({})", types.join(", ")));
            }
        }

        Ok(Tool {
            method: m,
            name,
            properties: Value::Object(properties),
            required,
            defs: schemas.defs(&refs),
            path: segments(m.path(), &path_keys)?,
            query,
            headers,
            body,
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

/// The keys of a tool's arguments.
#[derive(Default)]
struct Keys {
    taken: HashSet<String>,
}

impl Keys {
    /// Returns the key of `field`, a parameter in `location`: its name in
    /// snake_case, or its wire name if that has no words. If another
    /// argument has it, the location goes in front, as in `query_name`.
    fn add(&mut self, field: Field<'_>, location: &str) -> Result<String, String> {
        let snake = field.name().snake();
        let mut key = if snake.is_empty() {
            field.wire_name().to_owned()
        } else {
            snake
        };
        if self.taken.contains(&key) {
            key = format!("{location}_{key}");
        }
        if !self.taken.insert(key.clone()) {
            return Err(format!("two arguments are both named {key}"));
        }
        Ok(key)
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

/// Returns `template` split into text and the keys of the arguments that
/// fill its parameters, given each path parameter's wire name and key.
fn segments(template: &str, keys: &[(String, String)]) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
            break;
        };
        let wire = &rest[start + 1..start + len];
        let Some((_, key)) = keys.iter().find(|(name, _)| name == wire) else {
            return Err(format!("the path parameter {wire} has no argument"));
        };
        if start > 0 {
            segments.push(Segment::Text(rest[..start].to_owned()));
        }
        segments.push(Segment::Param(key.clone()));
        rest = &rest[start + len + 1..];
    }
    if !rest.is_empty() {
        segments.push(Segment::Text(rest.to_owned()));
    }
    Ok(segments)
}

/// Returns the name of the tool of `m`: the names of its groups and its
/// own, in snake_case, joined by `_`, such as `accounts_members_list`.
fn tool_name(m: Method<'_>) -> String {
    let mut words: Vec<String> = m.group().path().map(|name| name.snake()).collect();
    words.push(m.name().snake());
    words.join("_")
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

/// Returns a `schemas.ts` for each directory with models: a constant with
/// the schema of each model placed there, which every tool that uses the
/// model shares. Also returns each model's constant.
fn schema_files<'f>(schemas: &Schemas<'f>) -> (Vec<ts::File>, HashMap<Model<'f>, Ident>) {
    let mut modules: BTreeMap<String, Vec<(&str, Model<'f>, &Value)>> = BTreeMap::new();
    for (model, key, schema) in schemas.built() {
        let module = model.group().map_or(Module::ROOT, Module::group).sub("schemas.ts");
        modules
            .entry(module.as_str().to_owned())
            .or_default()
            .push((key, model, schema));
    }
    let schema_type = RUNTIME_TOOL.ident("JsonSchema").ty();
    let mut idents = HashMap::new();
    let mut files = Vec::new();
    for (path, mut models) in modules {
        models.sort_by_key(|&(key, ..)| key);
        let mut f = ts::File::new(Module::from(path));
        let mut taken = HashSet::new();
        for (key, model, schema) in models {
            let mut name = ts_identifier(key);
            if RESERVED.contains(&name.as_str()) {
                name.push('_');
            }
            while !taken.insert(name.clone()) {
                name.push('$');
            }
            let ident = f.ident(name.clone());
            f.doc(&format!("The schema of `{}`.", model.schema_name()));
            let json = serde_json::to_string_pretty(schema).unwrap_or_else(|_| "{}".to_owned());
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
            idents.insert(model, ident);
        }
        files.push(f);
    }
    (files, idents)
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
fn tools_file(group: Group<'_>, tools: &[Tool<'_>], schemas: &HashMap<Model<'_>, Ident>) -> ts::File {
    let mut f = ts::File::new(Module::group(group).sub("tools.ts"));
    let tool = RUNTIME_TOOL.ident("Tool").ty();
    let path_param = RUNTIME_TOOL.ident("pathParam");
    let dotted: Vec<String> = group.path().map(|name| name.snake()).collect();
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
                                p!(f, string(key), ": ", schemas[model].clone(), ",");
                            }
                        });
                        p!(f, "},");
                    }
                });
                p!(f, "},");
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
                            Segment::Param(key) => {
                                parts.push(Box::new("${".to_owned()));
                                parts.push(Box::new(path_param.clone()));
                                parts.push(Box::new(format!("(args, {})}}", string(key))));
                            }
                        }
                    }
                    parts.push(Box::new("`,".to_owned()));
                    let parts: Vec<&dyn ts::Print> = parts.iter().map(AsRef::as_ref).collect();
                    f.line(&parts);
                    if !t.query.is_empty() {
                        p!(f, "query: [");
                        f.indent(|f| {
                            for (wire, key, explode) in &t.query {
                                p!(
                                    f,
                                    "[",
                                    string(wire),
                                    ", args[",
                                    string(key),
                                    "], ",
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
                            for (wire, key) in &t.headers {
                                p!(f, "[", string(wire), ", args[", string(key), "]],");
                            }
                        });
                        p!(f, "],");
                    }
                    if let Some((key, media_type)) = &t.body {
                        p!(
                            f,
                            "body: { value: args[",
                            string(key),
                            "], mediaType: ",
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

/// Returns the `index.ts` of the root: the API, and every tool.
fn index(forge: &Forge, groups: &[(Group<'_>, Vec<Tool<'_>>)]) -> ts::File {
    let mut f = ts::File::new(Module::ROOT.sub("index.ts"));
    let tool = RUNTIME_TOOL.ident("Tool").ty();
    // Only the half of the runtime without dependencies, so that importing the
    // tools doesn't import the MCP SDK. The other half, which serves them, is
    // in `./_/server.js`.
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
        for (group, _) in groups {
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

/// Returns the README.md of the server: how many tools it has, and each
/// method without one and why.
fn readme(groups: &[(Group<'_>, Vec<Tool<'_>>)], skipped: &[(Method<'_>, String)]) -> String {
    let count: usize = groups.iter().map(|(_, tools)| tools.len()).sum();
    let mut out = String::from("<!-- Code generated by forge. DO NOT EDIT. -->\n\n# MCP tools\n\n");
    let _ = writeln!(
        out,
        "{count} tools in {} groups. `index.ts` exports them as `tools`, with the runtime in `_/tool.ts` that builds their requests; `_/server.ts` serves them on an `McpServer`.",
        groups.len()
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
    use forge::{File as _, Forge, Plugin};

    use super::Generator;

    /// Returns the files the generator makes from `spec`, by path.
    fn generate(spec: &str) -> Vec<(String, String)> {
        let forge: Forge = serde_json::from_str(spec).unwrap();
        let mut files: Vec<(String, String)> = Generator
            .generate(&forge)
            .unwrap()
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
                    "responses": {"200": {"description": "ok"}}},
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
                "_/index.ts",
                "_/server.ts",
                "_/tool.ts",
                "index.ts",
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
        assert!(tools.contains(r#"["tag", args["tag"], false],"#), "{tools}");
        assert!(tools.contains(r#"["X-Trace", args["x_trace"]],"#), "{tools}");
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
    fn duplicate_names() {
        let files = generate(
            r#"{"openapi": "3.1.0", "info": {"title": "t", "version": "1"},
                "paths": {
                    "/a": {"get": {"x-fern-sdk-group-name": "a.b", "x-fern-sdk-method-name": "c",
                        "responses": {"200": {"description": "ok"}}}},
                    "/b": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "b_c",
                        "responses": {"200": {"description": "ok"}}}}
                }}"#,
        );
        let readme = file(&files, "README.md");
        assert!(readme.contains("another method has the tool name a_b_c"), "{readme}");
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
