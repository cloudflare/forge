//! The client.ts of a group: its client (specs/07-client-surface.md), and
//! the requests (specs/05-requests.md), responses (specs/06-responses.md)
//! and operations of its methods.

use std::collections::{BTreeSet, HashMap, HashSet};

use forge::ts::{File, Fragment, Ident, Module, frag, p};
use forge::{Field, Group, Json, Location, Method, Model, Type};

use super::models::print_fields;
use super::operation::operation;
use super::types::{
    Prec, all_optional, alternatives, doc, field_name, has_fields, identifier, js_string, kept, key, object_like, typ,
};
use super::{PROVIDER_EXTENSION, Transport, request_options, runtime};

/// Returns the client.ts of `group`: its ClientOptions and Client,
/// createClient and bind, the request and response types of each method,
/// then the operation of each method. The library has already rejected
/// methods and subgroups with no name and duplicate methods, and equal
/// group names are one group.
pub(super) fn client(group: Group<'_>, transport: Transport, roles: &[Role]) -> File {
    let groups: Vec<Group<'_>> = group.children().collect();
    let group_names: HashMap<String, Group<'_>> = groups.iter().map(|&sub| (group_name(sub), sub)).collect();

    // A method that is not JSON is left out (specs/13-non-json-operations.md).
    let methods: Vec<(Method<'_>, Request<'_>)> = group
        .methods()
        .filter(|&m| !skipped(m))
        .map(|m| (m, Request::new(m)))
        .collect();

    let mut f = File::new(Module::group(group).sub("client.ts"));
    client_options(&mut f, transport, group);
    for role in roles {
        let methods: Vec<(Method<'_>, Request<'_>)> = methods
            .iter()
            .filter(|&&(m, _)| (role.has)(m))
            .map(|&(m, _)| (m, Request::new(m)))
            .collect();
        p!(f);
        client_interface(&mut f, &methods, &groups, &group_names, transport, role);
        p!(f);
        if transport == Transport::Provider {
            f.doc(&format!(
                "Returns the {} of this group and of its groups, which sends its requests through the provider of the options.\n\n@param options The provider, and what the client adds to every request.\n@returns The client.\n@throws TypeError when the options have no provider.",
                role.client
            ));
        }
        p!(
            f,
            "export function ",
            f.ident(role.create),
            "(options: ",
            f.ident("ClientOptions"),
            "): ",
            f.ident(role.client),
            " {"
        );
        f.indent(|f| {
            p!(
                f,
                "return ",
                f.ident(role.bind),
                "(new ",
                runtime("Transport"),
                "(options));"
            );
        });
        p!(f, "}");
        p!(f);
        bind(&mut f, &methods, &groups, &group_names, transport, role);
    }
    for (m, request) in &methods {
        p!(f);
        request_type(&mut f, *m, request);
        p!(f);
        response_type(&mut f, *m);
    }
    for (m, request) in &methods {
        p!(f);
        operation(&mut f, *m, request, transport);
    }
    f
}

/// One of the clients of a group: which of the group's methods it has, and
/// the names of what is declared for it. Every group has the same clients,
/// so that a client has the subgroups of its group as the same client.
#[derive(Clone, Copy)]
pub(crate) struct Role {
    /// The name of its interface, such as `Client`.
    pub(crate) client: &'static str,
    /// The name of the function that binds it to a transport, such as
    /// `bind`.
    pub(crate) bind: &'static str,
    /// The name of the function that creates it, such as `createClient`.
    pub(crate) create: &'static str,
    /// Reports whether it has a method.
    pub(crate) has: fn(Method<'_>) -> bool,
    /// The file of a group that exports the function that creates it, such
    /// as `read.ts`, when it is not the group's index.ts. With a file of
    /// its own, what may create the client can be told by what it imports.
    pub(crate) entry: Option<&'static str>,
}

impl Role {
    /// The one client of the SDK, which has every method.
    pub(crate) const CLIENT: Role = Role {
        client: "Client",
        bind: "bind",
        create: "createClient",
        has: every_method,
        entry: None,
    };
}

fn every_method(_: Method<'_>) -> bool {
    true
}

/// Declares the ClientOptions of a group: the options every client takes,
/// and baseUrl, which is required.
fn client_options(f: &mut File, transport: Transport, group: Group<'_>) {
    if transport == Transport::Provider {
        // The path parameters a connection is bound to are options of the
        // client, and no request has them.
        let mut bound = BTreeSet::new();
        bound_of(group, &mut bound);
        if !bound.is_empty() {
            p!(
                f,
                "export interface ",
                f.ident("ClientOptions"),
                " extends ",
                runtime("BaseClientOptions").ty(),
                " {"
            );
            f.indent(|f| {
                f.doc("The path parameters a connection is bound to. No request has them.");
                let fields: Vec<String> = bound.iter().map(|name| format!("{}: string", key(name))).collect();
                p!(f, "bound: { ", fields.join("; "), " };");
            });
            p!(f, "}");
            return;
        }
        p!(
            f,
            "export type ",
            f.ident("ClientOptions"),
            " = ",
            runtime("BaseClientOptions").ty(),
            ";"
        );
        return;
    }
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
    transport: Transport,
    role: &Role,
) {
    let shared: HashMap<String, Method<'_>> = methods
        .iter()
        .map(|&(m, _)| (method_name(m), m))
        .filter(|(name, _)| group_names.contains_key(name))
        .collect();
    p!(
        f,
        "export function ",
        f.ident(role.bind),
        "(transport: ",
        runtime("Transport"),
        "): ",
        f.ident(role.client),
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
                        f.ident(role.client),
                        "[",
                        method,
                        "] | undefined;"
                    );
                }
                None => p!(f, "let ", name, "Client: ", client_ident(sub, role), " | undefined;"),
            }
        }
        p!(f, "return {");
        f.indent(|f| {
            for &(m, _) in methods {
                let name = method_name(m);
                if !shared.contains_key(&name) {
                    p!(f, key(&name), ": (request, options) => ", send(f, m, transport), ",");
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
                                result(f, m, transport),
                                " => ",
                                send(f, m, transport),
                                ","
                            );
                            p!(f, bind_ident(sub, role), "(transport),");
                        });
                        p!(f, "));");
                    }
                    None => p!(
                        f,
                        "return (",
                        name,
                        "Client ??= ",
                        bind_ident(sub, role),
                        "(transport));"
                    ),
                });
                p!(f, "},");
            }
        });
        p!(f, "};");
    });
    p!(f, "}");
}

/// Returns the call that sends the operation of `m`.
fn send(f: &File, m: Method<'_>, transport: Transport) -> Fragment {
    let send = if conditional(m, transport) {
        "sendConditional"
    } else {
        "send"
    };
    frag!("transport.", send, "(", operation_ident(f, m), ", request, options)")
}

/// Adds the path parameters that the methods of `group` and of its groups
/// have and a connection is bound to.
fn bound_of(group: Group<'_>, bound: &mut BTreeSet<String>) {
    for m in group.methods().filter(|&m| !skipped(m)) {
        bound.extend(Request::new(m).params.into_iter().filter(|p| p.bound).map(|p| p.name));
    }
    for sub in group.children() {
        bound_of(sub, bound);
    }
}

/// Returns the documentation of a method of a client of a provider:
/// `text`, then what it takes, returns and throws.
fn provider_tags(mut text: String, m: Method<'_>, request: &Request<'_>) -> String {
    let fact = |key: &str| provider_fact(m, key);
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(if request.optional() {
        "@param request What the operation takes. It can be left out.\n"
    } else {
        "@param request What the operation takes.\n"
    });
    text.push_str("@param options The options of this call: a signal, headers, and query parameters.\n");
    text.push_str(if fact("conditional").and_then(Json::as_bool) == Some(true) {
        "@returns The body of the response, with its status and headers, or a NotModified for a 304.\n"
    } else if fact("kind").and_then(Json::as_str) == Some("write") {
        "@returns The body of the response, with its status and headers. The body is undefined when a 2XX has none.\n"
    } else {
        "@returns The body of the response, with its status and headers.\n"
    });
    text.push_str(
        "@throws The error of the client's options, or an ApiError, for a response that is a failure, and a DecodeError for a 2XX whose body cannot be read.",
    );
    text
}

/// Returns the value of `key` in what a provider is told of `m`.
pub(crate) fn provider_fact<'a>(m: Method<'a>, key: &str) -> Option<&'a Json> {
    m.extension(PROVIDER_EXTENSION).and_then(|extension| extension.get(key))
}

/// Reports whether a 304 response to `m` is returned, and not thrown.
fn conditional(m: Method<'_>, transport: Transport) -> bool {
    transport == Transport::Provider && provider_fact(m, "conditional").and_then(Json::as_bool) == Some(true)
}

/// Returns the bind of group `g`, imported under the name of the group.
fn bind_ident(g: Group<'_>, role: &Role) -> Ident {
    let alias = format!("{}{}", role.bind, identifier(g.name().pascal()));
    Module::group(g).sub("client.ts").ident(role.bind).alias(alias)
}

/// Returns the Client of group `g`, imported under the name of the group.
fn client_ident(g: Group<'_>, role: &Role) -> Ident {
    let alias = format!("{}{}", identifier(g.name().pascal()), role.client);
    Module::group(g).sub("client.ts").ident(role.client).ty().alias(alias)
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
    transport: Transport,
    role: &Role,
) {
    if methods.is_empty() && groups.is_empty() {
        p!(f, "export interface ", f.ident(role.client), " {}");
        return;
    }
    p!(f, "export interface ", f.ident(role.client), " {");
    let mut shared = HashSet::new();
    f.indent(|f| {
        for (m, request) in methods {
            let m = *m;
            let mut text = method_doc(m);
            if transport == Transport::Provider {
                text = provider_tags(text, m, request);
            }
            f.doc(&doc(&text, m.is_deprecated()));
            let name = method_name(m);
            let params = method_params(f, m, request);
            match group_names.get(&name) {
                None => p!(f, key(&name), "(", params, "): ", result(f, m, transport), ";"),
                Some(&sub) => {
                    p!(
                        f,
                        "readonly ",
                        key(&name),
                        ": ((",
                        params,
                        ") => ",
                        result(f, m, transport),
                        ") & ",
                        client_ident(sub, role),
                        ";"
                    );
                    shared.insert(name);
                }
            }
        }
        for &sub in groups {
            let name = group_name(sub);
            if !shared.contains(&name) {
                p!(f, "readonly ", key(&name), ": ", client_ident(sub, role), ";");
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

/// Returns what `m` returns: a promise of its response, which a provider
/// returns with its status and headers, or with a 304 when the method is
/// conditional. The response of a write can be undefined, since a 2XX with
/// no body is not thrown: the change was made.
fn result(f: &File, m: Method<'_>, transport: Transport) -> Fragment {
    let response = response_ident(f, m);
    match transport {
        Transport::Fetch => frag!("Promise<", response, ">"),
        Transport::Provider if conditional(m, transport) => frag!(
            "Promise<",
            runtime("Result").ty(),
            "<",
            response,
            "> | ",
            runtime("NotModified").ty(),
            ">"
        ),
        Transport::Provider if provider_fact(m, "kind").and_then(Json::as_str) == Some("write") => {
            frag!("Promise<", runtime("Result").ty(), "<", response, " | undefined>>")
        }
        Transport::Provider => frag!("Promise<", runtime("Result").ty(), "<", response, ">>"),
    }
}

/// Declares the request type of `m`: its parameters, then its body. A flat
/// body sits next to the parameters, in an interface when it is an object
/// type, and intersected with them otherwise. Any other body is the field
/// `body`.
fn request_type(f: &mut File, m: Method<'_>, request: &Request<'_>) {
    let name = request_ident(f, m);
    // A parameter a connection is bound to is not a field.
    let params: Vec<&Param<'_>> = request.params.iter().filter(|param| !param.bound).collect();
    let params = params.as_slice();
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
pub(crate) fn response(m: Method<'_>) -> (Vec<Type<'_>>, bool) {
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
    pub(crate) flat: bool,
}

/// A parameter of a method, and the name of its field in the request.
pub(super) struct Param<'f> {
    pub(super) field: Field<'f>,
    pub(super) name: String,
    pub(super) location: Location,
    /// Whether a connection is bound to it, so that the client has it and
    /// the request does not.
    pub(super) bound: bool,
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
    /// query parameter that is not [`kept`] has no field, and one named
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
            if matches!(location, Location::Query { .. }) && !kept(field) {
                continue;
            }
            let mut name = field_name(field);
            if !flat && name == "body" {
                name.push('$');
            }
            while !taken.insert(name.clone()) {
                name.push('$');
            }
            let bound = location == Location::Path
                && provider_fact(m, "bound")
                    .and_then(Json::as_array)
                    .is_some_and(|bound| bound.iter().any(|name| name.as_str() == Some(field.wire_name())));
            params.push(Param {
                field,
                name,
                location,
                bound,
            });
        }
        Request { params, body, flat }
    }

    /// Reports whether the request can be left out: no parameter is
    /// required, and an empty object is a body.
    pub(crate) fn optional(&self) -> bool {
        let params = !self.params.iter().any(|p| p.field.is_required() && !p.bound);
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
fn print_params(f: &mut File, params: &[&Param<'_>]) {
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
