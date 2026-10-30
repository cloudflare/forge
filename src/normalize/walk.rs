//! What a document means, which is where a key is to be rewritten.
//!
//! The walk follows the document as `forge` reads it: down from `paths` and
//! `components` to the operations, the parameters and the schemas, which are
//! the objects that have keys to rewrite, and no further. Everything else is
//! passed over. What is below an object is found by what kind of object it is
//! and what the key is, in [`child`], which is the one place that says where
//! `forge` reads.

use serde_json::{Map, Value};

use super::vendor::{self, Form, Key};
use super::{Options, Report};

/// Returns the names of an array joined by dots, if each is a name that a
/// dotted string reads back as it is.
fn dotted(names: &[Value]) -> Option<String> {
    let mut path = String::new();
    for (i, name) in names.iter().enumerate() {
        let name = name.as_str().filter(|name| !name.is_empty() && !name.contains('.'))?;
        if i > 0 {
            path.push('.');
        }
        path.push_str(name);
    }
    Some(path)
}

/// A kind of object that is read.
#[derive(Clone, Copy)]
enum Kind {
    Document,
    Components,
    PathItem,
    Operation,
    /// An alias of an operation, which has the keys of one.
    Alias,
    Parameter,
    /// A request body or a response, which has nothing but a `content` to read.
    Body,
    /// A media type, which has nothing but a `schema` to read.
    Media,
    Schema,
}

/// How what is read is held by the key that has it.
#[derive(Clone, Copy)]
enum Shape {
    /// The value is one object.
    One(Kind),
    /// The value is an object, and each of its members is.
    Values(Kind),
    /// The value is an object, and each member that is not an extension is.
    Entries(Kind),
    /// The value is an array, and each of its elements is.
    Elements(Kind),
}

/// Returns what the member `key` of an object of the kind `kind` holds, if
/// `forge` reads it.
fn child(kind: Kind, key: &str, value: &Value) -> Option<Shape> {
    use Kind::*;
    use Shape::*;
    Some(match (kind, key) {
        (Document, "paths") => Entries(PathItem),
        (Document, "components") => One(Components),
        (Components, "schemas") => Values(Schema),
        (Components, "parameters") => Values(Parameter),
        (Components, "requestBodies" | "responses") => Values(Body),
        (Components, "pathItems") => Values(PathItem),
        (PathItem, "parameters") => Elements(Parameter),
        (
            PathItem,
            "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace" | "query" | "connect",
        ) => One(Operation),
        (PathItem, "additionalOperations") => Values(Operation),
        (Operation, "parameters") => Elements(Parameter),
        (Operation, "requestBody") => One(Body),
        (Operation, "responses") => Entries(Body),
        (Operation, "x-forge-aliases") => Elements(Alias),
        (Parameter, "schema") => One(Schema),
        (Parameter, "content") => Values(Media),
        (Body, "content") => Values(Media),
        (Media, "schema") => One(Schema),
        (Schema, "properties" | "$defs") => Values(Schema),
        (Schema, "additionalProperties" | "unevaluatedProperties") => One(Schema),
        (Schema, "items") if value.is_object() => One(Schema),
        (Schema, "items" | "allOf" | "anyOf" | "oneOf") => Elements(Schema),
        _ => return None,
    })
}

/// What is done to a member of an object.
enum Action {
    /// The key is written as the native key, with its value, or with this one.
    Rename(&'static str, Option<Value>),
    /// The member is removed, since a native key says what it says.
    Remove,
    /// The native key is written before it, with its value, or with this one,
    /// and it stays.
    Insert(&'static str, Option<Value>),
}

/// Walks a document, which is changed, and returns what was done.
pub(super) fn walk(document: &mut Value, options: &Options) -> Report {
    let mut walk = Walk {
        options,
        report: Report::default(),
    };
    walk.visit(Kind::Document, document);
    walk.report
}

struct Walk<'o> {
    options: &'o Options,
    report: Report,
}

impl Walk<'_> {
    /// Reads an object of the kind `kind`: its keys that are to be rewritten
    /// are, and then what is in it that is read.
    fn visit(&mut self, kind: Kind, value: &mut Value) {
        let Some(members) = value.as_object_mut() else {
            return;
        };
        match kind {
            Kind::Operation | Kind::Alias => self.rewrite(members, vendor::definition),
            Kind::Parameter => self.rewrite(members, vendor::parameter),
            Kind::Schema => self.rewrite(members, vendor::schema),
            Kind::Document | Kind::Components | Kind::PathItem | Kind::Body | Kind::Media => {}
        }
        for (key, member) in members.iter_mut() {
            let Some(shape) = child(kind, key, member) else {
                continue;
            };
            match shape {
                Shape::One(kind) => self.visit(kind, member),
                Shape::Values(kind) => {
                    if let Some(members) = member.as_object_mut() {
                        for member in members.values_mut() {
                            self.visit(kind, member);
                        }
                    }
                }
                Shape::Entries(kind) => {
                    if let Some(members) = member.as_object_mut() {
                        for (key, member) in members {
                            if !key.starts_with("x-") {
                                self.visit(kind, member);
                            }
                        }
                    }
                }
                Shape::Elements(kind) => {
                    if let Some(elements) = member.as_array_mut() {
                        for element in elements.iter_mut() {
                            self.visit(kind, element);
                        }
                    }
                }
            }
        }
    }

    /// Decides what to do to the keys of the object that a native key replaces,
    /// as `read` says which they are for the kind of object it is, and does it.
    fn rewrite(&mut self, members: &mut Map<String, Value>, read: fn(&str, super::Sources) -> Option<Key>) {
        let mut actions: Vec<(String, Action)> = Vec::new();
        for (key, value) in members.iter() {
            if !key.starts_with("x-") {
                continue;
            }
            let Some(hit) = read(key, self.options.sources) else {
                continue;
            };
            // A list of targets is something no native key says: it is left
            // as it is written, and not for a rewrite to say some other way
            // or to drop.
            if hit.form == Form::BoolOrTargets && value.is_array() {
                continue;
            }
            // The native key that is beside is the one that decides.
            let writes = !members.contains_key(hit.native);
            let written = match value {
                Value::Array(names) if writes && hit.form == Form::Group => dotted(names).map(Value::String),
                _ => None,
            };
            if written.is_some() {
                self.report.joined += 1;
            }
            let action = match (self.options.leave_old_extensions, writes) {
                (false, true) => Action::Rename(hit.native, written),
                (false, false) => Action::Remove,
                (true, true) => Action::Insert(hit.native, written),
                (true, false) => continue,
            };
            *self.report.migrated.entry(key.clone()).or_insert(0) += 1;
            actions.push((key.clone(), action));
        }
        if actions.is_empty() {
            return;
        }

        // The members are written again in the order they were in. If two keys
        // of other tools said the same native field, the last would win here,
        // where a rewrite of bytes would have written the native key twice, for
        // `forge` to reject. No table has two keys for a field today.
        for (key, value) in std::mem::take(members) {
            match actions.iter().position(|(name, _)| *name == key) {
                None => {
                    members.insert(key, value);
                }
                Some(at) => match actions.swap_remove(at).1 {
                    Action::Rename(native, written) => {
                        members.insert(native.to_owned(), written.unwrap_or(value));
                    }
                    Action::Remove => {}
                    Action::Insert(native, written) => {
                        members.insert(native.to_owned(), written.unwrap_or_else(|| value.clone()));
                        members.insert(key, value);
                    }
                },
            }
        }
    }
}
