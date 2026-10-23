//! The Cap'n Web server generator, following rfcs/capnweb.md.
//!
//! The server is a thin layer over the TypeScript SDK that the `ts` target
//! generates: every group gets an `Api`, an RpcTarget that holds the SDK
//! client of the group and forwards each call to it. The server imports the
//! SDK from `#sdk`, which the package maps to the SDK with subpath imports
//! in its package.json:
//!
//! ```json
//! "imports": { "#sdk": "@cloudflare/sdk", "#sdk/*": "@cloudflare/sdk/*" }
//! ```
//!
//! The server has the same modules as the SDK, at the same paths: each
//! group's directory has a server.ts, which declares its `Api`, and an
//! index.ts, which exports only that `Api`. Any `Api` can be the main
//! object of a session, wrapping a client of its SDK module:
//!
//! ```ts
//! newWorkersRpcResponse(request, new Api(createClient(options)));
//! ```

use std::collections::HashSet;

use forge::ts::{File, Fragment, Ident, Module, PREAMBLE, frag, p};
use forge::{Err, Forge, Group, Method, Plugin};

use crate::ts::client::{Request, group_name, method_doc, method_name, request_name, response_name, skipped};
use crate::ts::types::{doc, identifier, key};
use crate::ts::{self, Node};

/// Generates a Cap'n Web server.
pub struct Generator;

impl Plugin for Generator {
    type File = ts::File;

    /// Returns the server.ts and index.ts of the root, and the options.ts
    /// every server imports.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = ts::File>, Err> {
        let root = Node::Root(forge);
        let (_, source) = OPTIONS_SOURCE.split_once('\n').unwrap_or_default();
        let options = ts::File::Runtime {
            path: OPTIONS.as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        };
        Ok([ts::File::Ts(server(root)?), ts::File::Ts(index(root)), options].into_iter())
    }

    fn generate_group(&self, group: Group<'_>) -> Result<impl Iterator<Item = ts::File>, Err> {
        let group = Node::Group(group);
        Ok([ts::File::Ts(server(group)?), ts::File::Ts(index(group))].into_iter())
    }
}

/// The Cap'n Web package.
const CAPNWEB: Module = Module::new("capnweb");

/// The module of the root that every server imports its options from.
const OPTIONS: Module = Module::new("options.ts");

/// The source of options.ts, which is the same for every API: the options
/// every method of a server takes, which are those of the SDK that Cap'n
/// Web can carry, and how they become the options of the SDK. No module
/// exports it.
///
/// Its first line, a `@ts-expect-error` for `#sdk`, which resolves only in
/// the package that holds the server, isn't generated.
const OPTIONS_SOURCE: &str = include_str!("capnweb/options.ts");

/// The SDK's root.
const SDK: Module = Module::new("#sdk");

/// The name every module declares and exports its server under, as every
/// module of the SDK does its Client.
const API: &str = "Api";

/// Returns the class every server extends.
fn rpc_target() -> Ident {
    CAPNWEB.ident("RpcTarget")
}

/// Returns the options every method of a server takes.
fn options_type() -> Ident {
    OPTIONS.ident("Options").ty()
}

/// Returns the function that turns the options into those of the SDK.
fn request_options() -> Ident {
    OPTIONS.ident("requestOptions")
}

/// Returns the module of the SDK that exports the Client of `node` and the
/// request and response types of its methods: `#sdk` for the root, and
/// `#sdk/` followed by the directory of the group otherwise, such as
/// `#sdk/projects/members`.
fn sdk(node: Node<'_>) -> Module {
    match node {
        Node::Root(_) => SDK,
        Node::Group(_) => Module::from(format!("{SDK}/{}", node.dir())),
    }
}

/// Returns the `Api` of group `g`, imported under the name of the group,
/// such as `DnsApi`.
fn api_ident(g: Group<'_>) -> Ident {
    let alias = format!("{}{API}", identifier(g.name().pascal()));
    Module::group(g).sub("server.ts").ident(API).alias(alias)
}

/// The names that Cap'n Web does not deliver to a target: the properties of
/// Object.prototype, which it never follows, and the members of its stubs,
/// which a client reads on the stub rather than calling.
const RESERVED: [&str; 18] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "then",
    "catch",
    "finally",
    "map",
    "dup",
    "onRpcBroken",
];

/// Returns the server.ts of `node`, which declares its `Api`: its methods
/// that the SDK keeps, then its subgroups.
fn server(node: Node<'_>) -> Result<File, Err> {
    let methods: Vec<Method<'_>> = node.methods().into_iter().filter(|&m| !skipped(m)).collect();
    let groups = node.children();
    check(node, &methods, &groups)?;

    let mut f = File::new(node.dir().sub("server.ts"));
    let client = sdk(node).ident("Client").ty();
    let what = match node {
        Node::Root(_) => "the API".to_owned(),
        Node::Group(_) => format!("the {} group of the API", node.path()),
    };
    f.doc(&format!(
        "Serves {what} over Cap'n Web with a Client of the SDK. \
         Each method takes the request of the SDK's method, and the headers and query parameters to send with it. \
         Each subgroup is served by the Api of the subgroup."
    ));
    p!(f, "export class ", f.ident(API), " extends ", rpc_target(), " {");
    f.indent(|f| {
        p!(f, "readonly #client: ", client, ";");
        p!(f);
        p!(f, "constructor(client: ", client, ") {");
        f.indent(|f| {
            p!(f, "super();");
            p!(f, "this.#client = client;");
        });
        p!(f, "}");
        for &m in &methods {
            p!(f);
            method(f, node, m);
        }
        for &sub in &groups {
            p!(f);
            subgroup(f, sub);
        }
    });
    p!(f, "}");
    Ok(f)
}

/// Reports the members of the server of `node` that it can't serve, naming
/// the group and the member: a name that Cap'n Web reserves, and a method
/// and a subgroup with the same name.
fn check(node: Node<'_>, methods: &[Method<'_>], groups: &[Group<'_>]) -> Result<(), Err> {
    let path = node.path();
    let prefix = if path.is_empty() {
        String::new()
    } else {
        format!("group {path:?}: ")
    };
    let reserved = |what: &str, name: &str| {
        RESERVED
            .contains(&name)
            .then(|| format!("{prefix}{what} {name:?} cannot be served over Cap'n Web, which reserves the name"))
    };
    let mut errs = Vec::new();
    let method_names: HashSet<String> = methods.iter().map(|&m| method_name(m)).collect();
    for &m in methods {
        errs.extend(reserved("method", &method_name(m)));
    }
    for &g in groups {
        let name = group_name(g);
        errs.extend(reserved("group", &name));
        if method_names.contains(&name) {
            errs.push(format!(
                "{prefix}a method and a group are both named {name:?}, which the Cap'n Web server cannot serve"
            ));
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs.join("\n").into())
    }
}

/// Declares a method of a server that calls the method of the Client.
fn method(f: &mut File, node: Node<'_>, m: Method<'_>) {
    let name = method_name(m);
    f.doc(&doc(&method_doc(m), m.is_deprecated()));
    p!(
        f,
        key(&name),
        "(",
        params(node, m),
        "): Promise<",
        response_ident(node, m),
        "> {"
    );
    f.indent(|f| {
        p!(
            f,
            "return this.#client",
            access(&name),
            "(request, ",
            request_options(),
            "(options));"
        );
    });
    p!(f, "}");
}

/// Declares the getter of a server that returns the `Api` of a subgroup,
/// wrapping the SDK client of the subgroup.
fn subgroup(f: &mut File, sub: Group<'_>) {
    let name = group_name(sub);
    let api = api_ident(sub);
    p!(f, "get ", key(&name), "(): ", api, " {");
    f.indent(|f| {
        p!(f, "return new ", api, "(this.#client", access(&name), ");");
    });
    p!(f, "}");
}

/// Returns the parameters of a method of a server: the request of the SDK's
/// method, optional when it is optional there, and the options.
fn params(node: Node<'_>, m: Method<'_>) -> Fragment {
    frag!(
        "request",
        if Request::new(m).optional() { "?: " } else { ": " },
        sdk(node).ident(request_name(m)).ty(),
        ", options?: ",
        options_type()
    )
}

fn response_ident(node: Node<'_>, m: Method<'_>) -> Ident {
    sdk(node).ident(response_name(m)).ty()
}

/// Returns the property access of `name`: `.name`, or `["name"]` when it
/// is not an identifier.
fn access(name: &str) -> String {
    let key = key(name);
    if key == name {
        format!(".{name}")
    } else {
        format!("[{key}]")
    }
}

/// Returns the index.ts of `node`, the module of its server, which exports
/// only its `Api`.
fn index(node: Node<'_>) -> File {
    let mut f = File::new(node.dir().sub("index.ts"));
    p!(f, "export { ", API, r#" } from "./server.js";"#);
    f
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use forge::ts::PREAMBLE;
    use forge::{Forge, Plugin};

    use super::Generator;

    /// Returns the forge of an OpenAPI document with `paths`.
    fn build(paths: &str) -> Forge {
        let doc = format!(r#"{{"openapi": "3.0.3", "info": {{"title": "t", "version": "1"}}, "paths": {paths}}}"#);
        serde_json::from_str(&doc).unwrap()
    }

    /// Returns the content of every file of the server, by path, without
    /// the preamble.
    fn generate(forge: &Forge) -> BTreeMap<String, String> {
        forge::run(forge, &Generator)
            .unwrap()
            .into_iter()
            .map(|file| {
                let content = forge::File::content(&file).unwrap();
                let content = String::from_utf8(content.into_owned()).unwrap();
                let content = content.strip_prefix(PREAMBLE).unwrap().to_owned();
                (forge::File::path(&file).to_owned(), content)
            })
            .collect()
    }

    fn lines(lines: &[&str]) -> String {
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }

    /// A JSON response with an object body.
    const OK: &str = r#""responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"type": "object", "properties": {"id": {"type": "string"}}}}}}}"#;

    /// A path parameter `id`.
    const ID: &str = r#""parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}]"#;

    #[test]
    fn generate_server() {
        let forge = build(&format!(
            r#"{{
              "/projects/{{id}}": {{"get": {{"x-fern-sdk-group-name": "projects", "x-fern-sdk-method-name": "get", "summary": "Gets a project.", {ID}, {OK}}}}},
              "/projects": {{"get": {{"x-fern-sdk-group-name": "projects", "x-fern-sdk-method-name": "list",
                "parameters": [{{"name": "cursor", "in": "query", "schema": {{"type": "string"}}}}], {OK}}}}},
              "/projects/{{id}}/archive": {{"post": {{"x-fern-sdk-group-name": "projects", "x-fern-sdk-method-name": "archive", {ID}, {OK}}}}},
              "/projects/{{id}}/members": {{"get": {{"x-fern-sdk-group-name": "projects.members", "x-fern-sdk-method-name": "list", {ID}, {OK}}}}},
              "/projects/upload": {{"post": {{"x-fern-sdk-group-name": "projects", "x-fern-sdk-method-name": "upload",
                "requestBody": {{"content": {{"application/octet-stream": {{"schema": {{"type": "string", "format": "binary"}}}}}}}}, {OK}}}}}
            }}"#
        ));
        let files = generate(&forge);
        assert_eq!(
            files.keys().collect::<Vec<_>>(),
            [
                "index.ts",
                "options.ts",
                "projects/index.ts",
                "projects/members/index.ts",
                "projects/members/server.ts",
                "projects/server.ts",
                "server.ts"
            ]
        );

        // The root Api serves the top-level groups.
        assert_eq!(
            files["server.ts"],
            lines(&[
                r##"import type { Client } from "#sdk";"##,
                r#"import { RpcTarget } from "capnweb";"#,
                "",
                r#"import { Api as ProjectsApi } from "./projects/server.js";"#,
                "",
                "/**",
                " * Serves the API over Cap'n Web with a Client of the SDK. Each method takes the",
                " * request of the SDK's method, and the headers and query parameters to send",
                " * with it. Each subgroup is served by the Api of the subgroup.",
                " */",
                "export class Api extends RpcTarget {",
                "  readonly #client: Client;",
                "",
                "  constructor(client: Client) {",
                "    super();",
                "    this.#client = client;",
                "  }",
                "",
                "  get projects(): ProjectsApi {",
                "    return new ProjectsApi(this.#client.projects);",
                "  }",
                "}",
            ])
        );

        // A method that is not JSON is left out, as the SDK leaves it out.
        // The methods come first, then the subgroups.
        assert_eq!(
            files["projects/server.ts"],
            lines(&[
                "import type {",
                "  ArchiveRequest,",
                "  ArchiveResponse,",
                "  Client,",
                "  GetRequest,",
                "  GetResponse,",
                "  ListRequest,",
                "  ListResponse,",
                r##"} from "#sdk/projects";"##,
                r#"import { RpcTarget } from "capnweb";"#,
                "",
                r#"import { type Options, requestOptions } from "../options.js";"#,
                r#"import { Api as MembersApi } from "./members/server.js";"#,
                "",
                "/**",
                " * Serves the projects group of the API over Cap'n Web with a Client of the SDK.",
                " * Each method takes the request of the SDK's method, and the headers and query",
                " * parameters to send with it. Each subgroup is served by the Api of the",
                " * subgroup.",
                " */",
                "export class Api extends RpcTarget {",
                "  readonly #client: Client;",
                "",
                "  constructor(client: Client) {",
                "    super();",
                "    this.#client = client;",
                "  }",
                "",
                "  archive(request: ArchiveRequest, options?: Options): Promise<ArchiveResponse> {",
                "    return this.#client.archive(request, requestOptions(options));",
                "  }",
                "",
                "  /**",
                "   * Gets a project.",
                "   */",
                "  get(request: GetRequest, options?: Options): Promise<GetResponse> {",
                "    return this.#client.get(request, requestOptions(options));",
                "  }",
                "",
                "  list(request?: ListRequest, options?: Options): Promise<ListResponse> {",
                "    return this.#client.list(request, requestOptions(options));",
                "  }",
                "",
                "  get members(): MembersApi {",
                "    return new MembersApi(this.#client.members);",
                "  }",
                "}",
            ])
        );
        assert!(
            files["projects/members/server.ts"].contains(r##"} from "#sdk/projects/members";"##),
            "{}",
            files["projects/members/server.ts"]
        );

        // Every module exports only its Api.
        for index in ["index.ts", "projects/index.ts", "projects/members/index.ts"] {
            assert_eq!(
                files[index],
                lines(&[r#"export { Api } from "./server.js";"#]),
                "{index}"
            );
        }
        assert!(
            files["options.ts"].starts_with("import type { RequestOptions } from '#sdk';\n"),
            "{}",
            files["options.ts"]
        );
    }

    #[test]
    fn reserved() {
        // Cap'n Web never delivers a call to then or toString.
        let forge = build(&format!(
            r#"{{
              "/a": {{"get": {{"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "then", {OK}}}}},
              "/b": {{"get": {{"x-fern-sdk-group-name": "to-string", "x-fern-sdk-method-name": "get", {OK}}}}}
            }}"#
        ));
        let root = Generator.generate(&forge).err().unwrap().to_string();
        assert!(
            root.contains(r#"group "toString" cannot be served over Cap'n Web"#),
            "{root}"
        );
        let a = forge.groups().find(|g| g.name().camel() == "a").unwrap();
        let group = Generator.generate_group(a).err().unwrap().to_string();
        assert!(
            group.contains(r#"group "a": method "then" cannot be served over Cap'n Web"#),
            "{group}"
        );
    }

    #[test]
    fn method_and_group_with_the_same_name() {
        // The SDK serves both as one property, which Cap'n Web can't type.
        let forge = build(&format!(
            r#"{{
              "/projects/{{id}}/archive": {{"post": {{"x-fern-sdk-group-name": "projects", "x-fern-sdk-method-name": "archive", {ID}, {OK}}}}},
              "/projects/{{id}}/archive/restore": {{"post": {{"x-fern-sdk-group-name": "projects.archive", "x-fern-sdk-method-name": "restore", {ID}, {OK}}}}}
            }}"#
        ));
        let projects = forge.groups().find(|g| g.name().camel() == "projects").unwrap();
        let err = Generator.generate_group(projects).err().unwrap().to_string();
        assert!(
            err.contains(r#"group "projects": a method and a group are both named "archive""#),
            "{err}"
        );
    }
}
