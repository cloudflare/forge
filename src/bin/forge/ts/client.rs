//! The client.ts of a group: its client (specs/07-client-surface.md), and
//! the requests (specs/05-requests.md), responses (specs/06-responses.md)
//! and operations of its methods.

use std::collections::{HashMap, HashSet};

use forge::ts::{File, Fragment, Ident, Module, frag, p};
use forge::{Field, Group, Location, Method, Model, Type};

use super::models::print_fields;
use super::operation::operation;
use super::types::{
    Prec, all_optional, alternatives, doc, has_fields, identifier, js_string, key, object_like, typ, valid_name,
};
use super::{Node, request_options, runtime};

/// Returns the client.ts of `node`: its ClientOptions and Client,
/// createClient and bind, the request and response types of each method,
/// then the operation of each method. The library has already rejected
/// methods and groups with no name and duplicate methods, and equal group
/// names are one group.
pub(super) fn client(node: Node<'_>) -> File {
    let groups = node.children();
    let group_names: HashMap<String, Group<'_>> = groups.iter().map(|&sub| (group_name(sub), sub)).collect();

    // A method that is not JSON is left out (specs/13-non-json-operations.md).
    let methods: Vec<(Method<'_>, Request<'_>)> = node
        .methods()
        .into_iter()
        .filter(|&m| !skipped(m))
        .map(|m| (m, Request::new(m)))
        .collect();

    let mut f = File::new(node.dir().sub("client.ts"));
    client_options(&mut f);
    p!(f);
    client_interface(&mut f, &methods, &groups, &group_names);
    p!(f);
    p!(
        f,
        "export function ",
        f.ident("createClient"),
        "(options: ",
        f.ident("ClientOptions"),
        "): ",
        f.ident("Client"),
        " {"
    );
    f.indent(|f| {
        p!(
            f,
            "return ",
            f.ident("bind"),
            "(new ",
            runtime("Transport"),
            "(options));"
        );
    });
    p!(f, "}");
    p!(f);
    bind(&mut f, &methods, &groups, &group_names);
    for (m, request) in &methods {
        p!(f);
        request_type(&mut f, *m, request);
        p!(f);
        response_type(&mut f, *m);
    }
    for (m, request) in &methods {
        p!(f);
        operation(&mut f, *m, request);
    }
    f
}

/// Declares the ClientOptions of a group: the options every client takes,
/// and baseUrl, which is required.
fn client_options(f: &mut File) {
    p!(
        f,
        "export interface ",
        f.ident("ClientOptions"),
        " extends ",
        runtime("BaseClientOptions").ty(),
        " {"
    );
    f.indent(|f| {
        f.doc("The URL the paths of the API are relative to.");
        p!(f, "baseUrl: string;");
    });
    p!(f, "}");
}

/// Declares bind, which returns the Client of a group on a transport: each
/// method sends its operation, and each subgroup is a getter that binds the
/// subgroup's Client the first time it is read. A method and a subgroup
/// with the same name share a getter, of the method with the members of the
/// subgroup's Client.
fn bind(
    f: &mut File,
    methods: &[(Method<'_>, Request<'_>)],
    groups: &[Group<'_>],
    group_names: &HashMap<String, Group<'_>>,
) {
    let shared: HashMap<String, Method<'_>> = methods
        .iter()
        .map(|&(m, _)| (method_name(m), m))
        .filter(|(name, _)| group_names.contains_key(name))
        .collect();
    p!(
        f,
        "export function ",
        f.ident("bind"),
        "(transport: ",
        runtime("Transport"),
        "): ",
        f.ident("Client"),
        " {"
    );
    f.indent(|f| {
        for &sub in groups {
            let name = group_name(sub);
            match shared.get(&name) {
                Some(&m) => {
                    let method = js_string(&method_name(m));
                    p!(
                        f,
                        "let ",
                        name,
                        "Client: ",
                        f.ident("Client"),
                        "[",
                        method,
                        "] | undefined;"
                    );
                }
                None => p!(f, "let ", name, "Client: ", client_ident(sub), " | undefined;"),
            }
        }
        p!(f, "return {");
        f.indent(|f| {
            for &(m, _) in methods {
                let name = method_name(m);
                if !shared.contains_key(&name) {
                    p!(f, key(&name), ": (request, options) => ", send(f, m), ",");
                }
            }
            for &sub in groups {
                let name = group_name(sub);
                p!(f, "get ", key(&name), "() {");
                f.indent(|f| match shared.get(&name) {
                    Some(&m) => {
                        p!(f, "return (", name, "Client ??= Object.assign(");
                        f.indent(|f| {
                            p!(
                                f,
                                "(request: ",
                                request_ident(f, m),
                                ", options?: ",
                                request_options(),
                                "): ",
                                result(f, m),
                                " => ",
                                send(f, m),
                                ","
                            );
                            p!(f, bind_ident(sub), "(transport),");
                        });
                        p!(f, "));");
                    }
                    None => p!(f, "return (", name, "Client ??= ", bind_ident(sub), "(transport));"),
                });
                p!(f, "},");
            }
        });
        p!(f, "};");
    });
    p!(f, "}");
}

/// Returns the call that sends the operation of `m`.
fn send(f: &File, m: Method<'_>) -> Fragment {
    frag!("transport.send(", operation_ident(f, m), ", request, options)")
}

/// Returns the bind of group `g`, imported under the name of the group.
fn bind_ident(g: Group<'_>) -> Ident {
    let alias = format!("bind{}", identifier(g.name().pascal()));
    Module::group(g).sub("client.ts").ident("bind").alias(alias)
}

/// Returns the Client of group `g`, imported under the name of the group.
fn client_ident(g: Group<'_>) -> Ident {
    let alias = format!("{}Client", identifier(g.name().pascal()));
    Module::group(g).sub("client.ts").ident("Client").ty().alias(alias)
}

/// Declares the Client of a group: its methods, then its subgroups, which
/// `group_names` has by name. A method and a subgroup with the same name
/// share the property, which is a function with the members of the
/// subgroup's Client.
fn client_interface(
    f: &mut File,
    methods: &[(Method<'_>, Request<'_>)],
    groups: &[Group<'_>],
    group_names: &HashMap<String, Group<'_>>,
) {
    if methods.is_empty() && groups.is_empty() {
        p!(f, "export interface ", f.ident("Client"), " {}");
        return;
    }
    p!(f, "export interface ", f.ident("Client"), " {");
    let mut shared = HashSet::new();
    f.indent(|f| {
        for (m, request) in methods {
            let m = *m;
            f.doc(&doc(&method_doc(m), m.is_deprecated()));
            let name = method_name(m);
            let params = method_params(f, m, request);
            match group_names.get(&name) {
                None => p!(f, key(&name), "(", params, "): ", result(f, m), ";"),
                Some(&sub) => {
                    p!(
                        f,
                        "readonly ",
                        key(&name),
                        ": ((",
                        params,
                        ") => ",
                        result(f, m),
                        ") & ",
                        client_ident(sub),
                        ";"
                    );
                    shared.insert(name);
                }
            }
        }
        for &sub in groups {
            let name = group_name(sub);
            if !shared.contains(&name) {
                p!(f, "readonly ", key(&name), ": ", client_ident(sub), ";");
            }
        }
    });
    p!(f, "}");
}

/// Returns the parameters of `m`: its request, which is optional when an
/// empty object is a request, and the options of the call.
fn method_params(f: &File, m: Method<'_>, request: &Request<'_>) -> Fragment {
    frag!(
        "request",
        if request.optional() { "?: " } else { ": " },
        request_ident(f, m),
        ", options?: ",
        request_options()
    )
}

/// Returns what `m` returns: a promise of its response.
fn result(f: &File, m: Method<'_>) -> Fragment {
    frag!("Promise<", response_ident(f, m), ">")
}

/// Declares the request type of `m`: its parameters, then its body. A flat
/// body sits next to the parameters, in an interface when it is an object
/// type, and intersected with them otherwise. Any other body is the field
/// `body`.
fn request_type(f: &mut File, m: Method<'_>, request: &Request<'_>) {
    let name = request_ident(f, m);
    let params = &request.params;
    if let Some(body) = &request.body
        && request.flat
        && !has_fields(body.ty)
    {
        if params.is_empty() {
            p!(f, "export type ", name, " = ", typ(body.ty, Prec::Top), ";");
            return;
        }
        p!(f, "export type ", name, " = {");
        print_params(f, params);
        p!(f, "} & ", typ(body.ty, Prec::Intersection), ";");
        return;
    }
    if params.is_empty() && request.body.is_none() {
        p!(f, "export interface ", name, " {}");
        return;
    }
    p!(f, "export interface ", name, " {");
    print_params(f, params);
    if let Some(body) = &request.body {
        match body.ty {
            Type::Object(object) if request.flat => print_fields(f, object),
            ty => f.indent(|f| {
                f.doc(body.description);
                p!(
                    f,
                    "body",
                    if body.required { ": " } else { "?: " },
                    typ(ty, Prec::Top),
                    ";"
                );
            }),
        }
    }
    p!(f, "}");
}

/// Declares the response type of `m`: void when no success response has a
/// body, an interface when the only one is an object type, and otherwise a
/// union of the bodies, with undefined when a success response can have
/// none.
fn response_type(f: &mut File, m: Method<'_>) {
    let name = response_ident(f, m);
    let (types, optional) = response(m);
    match types[..] {
        [] => p!(f, "export type ", name, " = void;"),
        [Type::Object(object)] if !optional && has_fields(types[0]) => {
            p!(f, "export interface ", name, " {");
            print_fields(f, object);
            p!(f, "}");
        }
        _ if optional => p!(f, "export type ", name, " = ", alternatives(types), " | undefined;"),
        [ty] => p!(f, "export type ", name, " = ", typ(ty, Prec::Top), ";"),
        _ => p!(f, "export type ", name, " = ", alternatives(types), ";"),
    }
}

/// Returns the types of the JSON bodies of the success responses of `m`,
/// each model once, and whether a success response can have no body.
pub(super) fn response(m: Method<'_>) -> (Vec<Type<'_>>, bool) {
    let mut types = Vec::new();
    let mut optional = false;
    let mut seen: HashSet<Model<'_>> = HashSet::new();
    for response in m.responses() {
        match response.json().map(|content| content.ty()) {
            None => optional = true,
            Some(Type::Model(model)) if !seen.insert(model) => {}
            Some(ty) => types.push(ty),
        }
    }
    (types, optional)
}

/// The request of a method: its parameters that have a field, and its JSON
/// body.
pub(crate) struct Request<'f> {
    /// The parameters, path parameters first.
    pub(super) params: Vec<Param<'f>>,
    pub(super) body: Option<Body<'f>>,
    /// Whether the body's fields sit next to the parameters, rather than in
    /// the field `body`.
    pub(super) flat: bool,
}

/// A parameter of a method, and the name of its field in the request.
pub(super) struct Param<'f> {
    pub(super) field: Field<'f>,
    pub(super) name: String,
    pub(super) location: Location,
}

/// The JSON request body of a method.
pub(super) struct Body<'f> {
    pub(super) ty: Type<'f>,
    pub(super) media_type: &'f str,
    pub(super) required: bool,
    pub(super) description: &'f str,
}

impl<'f> Request<'f> {
    /// Returns the request of `m`, as [`Method::request`] lays it out. A
    /// query parameter whose name is not valid has no field, and one named
    /// like another parameter gets a `$`. A parameter named `body` next to a
    /// body that is not flat gets a `$` too.
    pub(crate) fn new(m: Method<'f>) -> Request<'f> {
        let request = m.request();
        let object = match request {
            Some(Type::Object(object)) => Some(object),
            Some(Type::Intersection(intersection)) => match intersection.members().next() {
                Some(Type::Object(object)) => Some(object),
                _ => None,
            },
            _ => None,
        };
        let located: Vec<(Field<'f>, Location)> = object
            .into_iter()
            .flat_map(|object| object.fields())
            .filter_map(|field| Some((field, m.location(field)?)))
            .collect();

        let body = m.body().and_then(|body| {
            let content = body.json()?;
            Some(Body {
                ty: content.ty(),
                media_type: content.media_type(),
                required: body.is_required(),
                description: body.description(),
            })
        });
        let flat = match &body {
            None => false,
            Some(body) if located.is_empty() => object_like(body.ty, &mut HashSet::new()),
            Some(_) => matches!(request, Some(Type::Intersection(_))),
        };

        let mut taken = HashSet::new();
        let mut params = Vec::new();
        for (field, location) in located {
            if matches!(location, Location::Query { .. }) && !valid_name(field.wire_name()) {
                continue;
            }
            let mut name = field.name().camel();
            if !flat && name == "body" {
                name.push('$');
            }
            while !taken.insert(name.clone()) {
                name.push('$');
            }
            params.push(Param { field, name, location });
        }
        Request { params, body, flat }
    }

    /// Reports whether the request can be left out: no parameter is
    /// required, and an empty object is a body.
    pub(crate) fn optional(&self) -> bool {
        let params = !self.params.iter().any(|p| p.field.is_required());
        let body = match &self.body {
            None => true,
            Some(body) if self.flat => all_optional(body.ty),
            Some(body) => !body.required,
        };
        params && body
    }
}

/// Prints the parameters of a request, each on a line of its own after its
/// documentation.
fn print_params(f: &mut File, params: &[Param<'_>]) {
    f.indent(|f| {
        for param in params {
            let field = param.field;
            f.doc(&doc(field.description(), field.is_deprecated()));
            p!(
                f,
                key(&param.name),
                if field.is_required() { ": " } else { "?: " },
                typ(field.ty(), Prec::Top),
                ";"
            );
        }
    });
}

/// Returns the request and response types of `m`, which are named after it.
fn request_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(request_name(m))
}

fn response_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(response_name(m))
}

pub(crate) fn request_name(m: Method<'_>) -> String {
    format!("{}Request", identifier(m.name().pascal()))
}

pub(crate) fn response_name(m: Method<'_>) -> String {
    format!("{}Response", identifier(m.name().pascal()))
}

/// Returns the operation of `m`, which is named after it.
pub(super) fn operation_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(format!("{}Operation", identifier(m.name().pascal())))
}

/// Returns the property of a method and a group in the Client.
pub(crate) fn method_name(m: Method<'_>) -> String {
    identifier(m.name().camel())
}

pub(crate) fn group_name(g: Group<'_>) -> String {
    identifier(g.name().camel())
}

/// Returns the documentation of `m`: its summary, then its description.
pub(crate) fn method_doc(m: Method<'_>) -> String {
    let mut text = m.summary().trim().to_owned();
    let description = m.description().trim();
    if !description.is_empty() && description != text {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(description);
    }
    text
}

/// Reports whether `m` is left out of the SDK: its request body, or a
/// success response, has content, and none of it is JSON
/// (specs/13-non-json-operations.md).
pub(crate) fn skipped(m: Method<'_>) -> bool {
    if let Some(body) = m.body()
        && body.json().is_none()
        && body.contents().len() > 0
    {
        return true;
    }
    m.responses().any(|r| r.json().is_none() && r.contents().len() > 0)
}
