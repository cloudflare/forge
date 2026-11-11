//! The operation of a method, which the runtime sends
//! (specs/12-runtime-library.md).

use forge::ts::{File, frag, join, p};
use forge::{Json, Location, Method};

use super::Transport;
use super::client::{Param, Request, operation_ident, provider_fact, response};
use super::codec::{codec, members_codec};
use super::runtime;
use super::types::{js_string, key};

/// Declares the operation of `m`: its HTTP method and route, where its
/// parameters and body go, and the codecs of its body and responses. For a
/// provider, it starts with the `operationId` and the kind of the operation.
pub(super) fn operation(f: &mut File, m: Method<'_>, request: &Request<'_>, transport: Transport) {
    p!(
        f,
        "const ",
        operation_ident(f, m),
        ": ",
        runtime("Operation").ty(),
        " = {"
    );
    f.indent(|f| {
        if transport == Transport::Provider {
            let fact = |key| provider_fact(m, key).and_then(Json::as_str).unwrap_or_default();
            p!(f, "id: ", js_string(fact("operationId")), ",");
            p!(f, "kind: ", js_string(fact("kind")), ",");
        }
        p!(f, "method: ", js_string(m.http_method().as_str()), ",");
        p!(f, "route: ", js_string(&route(m, &request.params)), ",");
        let mut query = Vec::new();
        let mut joined = Vec::new();
        for param in &request.params {
            if let Location::Query { exploded } = param.location {
                query.push(format!("{}: {}", key(&param.name), js_string(param.field.wire_name())));
                if !exploded {
                    joined.push(js_string(&param.name));
                }
            }
        }
        if !query.is_empty() {
            p!(f, "query: { ", join(", ", query), " },");
        }
        if !joined.is_empty() {
            p!(f, "joined: [", join(", ", joined), "],");
        }
        if let Some(body) = &request.body {
            if request.flat {
                p!(f, r#"body: "flat","#);
            } else {
                p!(f, r#"body: "nested","#);
            }
            if body.media_type != "application/json" {
                p!(f, "contentType: ", js_string(body.media_type), ",");
            }
            let codec = codec(body.ty, true);
            if !codec.is_empty() {
                p!(f, "request: ", codec, ",");
            }
        }
        let (types, _) = response(m);
        if !types.is_empty() {
            let codec = members_codec(types, "union", true);
            p!(
                f,
                "response: ",
                if codec.is_empty() { frag!("null") } else { codec },
                ","
            );
        }
        error_codecs(f, m);
        if transport == Transport::Provider {
            failure(f, m);
        }
    });
    p!(f, "};");
}

/// Prints what says that a 2XX response of `m` is a failure, when a
/// provider is told so: the property of the body that has a value, which
/// is a string, a number, a boolean or null.
fn failure(f: &mut File, m: Method<'_>) {
    let Some(failure) = provider_fact(m, "failure") else {
        return;
    };
    let Some(property) = failure.get("property").and_then(Json::as_str) else {
        return;
    };
    let equals = failure.get("equals");
    let equals = if let Some(text) = equals.and_then(Json::as_str) {
        js_string(text)
    } else if let Some(flag) = equals.and_then(Json::as_bool) {
        flag.to_string()
    } else if let Some(number) = equals.and_then(Json::as_f64) {
        number.to_string()
    } else {
        "null".to_owned()
    };
    p!(
        f,
        "failure: { property: ",
        js_string(property),
        ", equals: ",
        equals,
        " },"
    );
}

/// Prints the declared error responses of an operation, by status: the
/// codec of a JSON body, true for a JSON body with nothing to convert, and
/// false for a body that is not JSON. Error responses that are all not JSON
/// are read like undeclared ones, so they are left out.
fn error_codecs(f: &mut File, m: Method<'_>) {
    let mut json = false;
    let errors = join(
        ", ",
        m.errors().map(|r| {
            let status = if r.status() == "default" {
                "default".to_owned()
            } else {
                js_string(r.status())
            };
            let Some(content) = r.json() else {
                return frag!(status, ": false");
            };
            json = true;
            let codec = codec(content.ty(), true);
            frag!(status, ": ", if codec.is_empty() { frag!("true") } else { codec })
        }),
    );
    if json {
        p!(f, "errors: { ", errors, " },");
    }
}

/// Returns the path of a method with each path parameter as the name of its
/// field in braces.
fn route(m: Method<'_>, params: &[Param<'_>]) -> String {
    let mut path = m.path().to_owned();
    for param in params {
        if param.location == Location::Path {
            let wire = format!("{{{}}}", param.field.wire_name());
            path = path.replace(&wire, &format!("{{{}}}", param.name));
        }
    }
    path
}
