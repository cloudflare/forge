//! Linking an OpenAPI document into a [`Forge`].
//!
//! [`openapi`] reads the document into arenas of its objects, which keep
//! only what a `Forge` is built from and hold no other logic. This module
//! links them: it reads the operations under `paths` in order, follows
//! `$ref`s, builds the types of each method's parameters, body and
//! responses, and makes the schemas they use models as they are reached.

mod openapi;
mod read;

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::{fmt, mem, slice};

use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::arena::Id;
use crate::arena::{List, Span, Str, Strings};
use crate::json::Json;
use crate::method::{BodyData, ContentData, ResponseData, is_json};
use crate::types::{
    ArrayData, DiscriminatorData, EnumData, FieldData, NameId, ObjectData, TypeData, TypeId, UnionData,
};
use crate::{
    Availability, EnumValue, Forge, GroupData, GroupId, HttpMethod, Location, MethodData, MethodId, ModelData, ModelId,
    Name, Number, Scalar,
};
use openapi::{
    Commands, ContentEncoding, Definition, Discriminator, Doc, Format, Info, Item, Literal, Operation, Parameter,
    ParameterLocation, ParameterStyle, PathItem, Referable, RequestBody, Response, Schema, SchemaObject, SchemaType,
    Server,
};

/// Reads a `Forge` from an OpenAPI document of version 3.0, 3.1 or 3.2,
/// in any format serde can read, such as JSON with
/// `serde_json::from_slice`. Any other version, or a Swagger 2.0 document,
/// is an error.
///
/// The methods come from the operations under `paths`, including those in
/// `additionalOperations` and in path items reached by `$ref`, and from
/// their aliases, as [`Method`](crate::Method) says. Webhooks, callbacks,
/// response headers, cookie parameters, security, and extensions these
/// docs do not mention are ignored, except that those of an operation or
/// alias are kept for [`Method::extensions`](crate::Method::extensions).
///
/// The schema of content in every media type is read, JSON or not, so an
/// error in it is reported whatever the media type. A part of the document
/// that cannot be ignored but is not covered yet, such as a parameter with
/// `content`, is an error.
/// Each type and method says what it covers.
///
/// The first server's `url` using a variable that its `variables` does not
/// define, or having a `{` that is not closed, is an error.
///
/// Every error in the document is reported, one per line.
impl<'de> Deserialize<'de> for Forge {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Forge, D::Error> {
        let doc = Doc::read(deserializer)?;
        match build(doc) {
            Ok(forge) => Ok(forge),
            Err(errors) => Err(de::Error::custom(errors.join("\n"))),
        }
    }
}

/// Returns the `Forge` of `doc`, or every error in it.
fn build(mut doc: Doc) -> Result<Forge, Vec<String>> {
    let version = mem::take(&mut doc.openapi);
    if version.is_empty() {
        return Err(vec![
            "the document has no openapi version: only OpenAPI 3.0, 3.1 and 3.2 are read".into(),
        ]);
    }
    let v30 = version.starts_with("3.0.");
    if !v30 && !version.starts_with("3.1.") && !version.starts_with("3.2.") {
        return Err(vec![format!(
            "openapi version {version:?} is not read: only OpenAPI 3.0, 3.1 and 3.2 are"
        )]);
    }
    let info = mem::take(&mut doc.info);
    let servers = mem::take(&mut doc.servers);
    let mut commands = mem::take(&mut doc.commands);
    // Taken whole, rather than each method's copied, so that a method keeps
    // the span of its operation's extensions.
    let extensions = mem::take(&mut doc.extensions);
    // Taken whole too: a field keeps the `Id` of its schema's default.
    let defaults = mem::take(&mut doc.defaults);
    let index = Index::new(&doc);
    let mut builder = Builder::new(&doc, &index, v30);
    let url = match base_url(&servers) {
        Ok(url) => url,
        Err(err) => {
            builder.errors.push(err);
            String::new()
        }
    };
    builder.add_paths(doc.paths);
    let Builder {
        mut groups,
        mut top,
        methods,
        models,
        types,
        errors,
        strings,
        name_ids,
        fields,
        members,
        values,
        ..
    } = builder;
    if !errors.is_empty() {
        return Err(errors);
    }
    sort(&mut groups, &mut top, &methods);
    describe(&mut groups, &top, &mut commands);
    let mut names = vec![Name::default(); name_ids.len()];
    for (name, id) in name_ids {
        names[id.index()] = name;
    }
    let mut forge = Forge {
        description: description(&info),
        version: info.version,
        base_url: url,
        groups,
        top,
        methods,
        models,
        top_models: Vec::new(),
        types,
        strings,
        names,
        fields,
        members,
        values,
        extensions,
        defaults,
    };
    forge.top_models = place_models(&mut forge);
    Ok(forge)
}

/// Returns the title, summary and description of `info` that are not
/// empty, joined as paragraphs.
fn description(info: &Info) -> String {
    let len = info.title.len() + info.summary.len() + info.description.len();
    if len == 0 {
        return String::new();
    }
    let mut description = String::with_capacity(len + 4);
    for part in [&info.title, &info.summary, &info.description] {
        if part.is_empty() {
            continue;
        }
        if !description.is_empty() {
            description.push_str("\n\n");
        }
        description.push_str(part);
    }
    description
}

/// Returns the URL of `server` with each `{variable}` replaced by its
/// default, or an error if a variable is not defined or a `{` is not
/// closed.
fn base_url(server: &Server) -> Result<String, String> {
    let mut url = String::with_capacity(server.url.len());
    let mut rest = server.url.as_str();
    while let Some(open) = rest.find('{') {
        let Some(len) = rest[open..].find('}') else {
            return Err(format!("server url {:?}: a '{{' is not closed", server.url));
        };
        let close = open + len;
        let name = &rest[open + 1..close];
        let Some(variable) = server.variables.get(name) else {
            return Err(format!("server url {:?}: variable {name:?} is not defined", server.url));
        };
        url.push_str(&rest[..open]);
        url.push_str(&variable.default);
        rest = &rest[close + 1..];
    }
    url.push_str(rest);
    Ok(url)
}

/// Sorts the top-level groups `top`, and the subgroups and methods of each
/// group, by name. Only the lists of IDs are sorted, so every ID stays the
/// same.
fn sort(groups: &mut [GroupData], top: &mut [GroupId], methods: &[MethodData]) {
    top.sort_by(|a, b| groups[a.index()].name.cmp(&groups[b.index()].name));
    for i in 0..groups.len() {
        // Moved out while sorted, since the names are in the same slice.
        let mut children = mem::take(&mut groups[i].groups);
        children.sort_by(|a, b| groups[a.index()].name.cmp(&groups[b.index()].name));
        groups[i].groups = children;
        groups[i]
            .methods
            .sort_by(|a, b| methods[a.index()].name.cmp(&methods[b.index()].name));
    }
}

/// Sets the description of the groups `ids` and every group inside them
/// from their entries in `commands`.
fn describe(groups: &mut [GroupData], ids: &[GroupId], commands: &mut Commands) {
    for &id in ids {
        let data = &mut groups[id.index()];
        let Some(command) = commands.0.get_mut(&data.name) else {
            continue;
        };
        data.description = mem::take(&mut command.description);
        // Moved out while the subgroups are described, since they live in
        // the same slice.
        let children = mem::take(&mut data.groups);
        describe(groups, &children, &mut command.groups);
        groups[id.index()].groups = children;
    }
}

/// Places each model in the deepest group shared by every method that uses
/// it, directly or through other models, and returns the models placed at
/// the top level.
fn place_models(forge: &mut Forge) -> Vec<ModelId> {
    let Forge {
        groups,
        methods,
        models,
        types,
        fields,
        members,
        ..
    } = forge;
    let types = Types { types, fields, members };
    let mut walk = Vec::new();
    // The models each model uses directly.
    let mut uses: Vec<Vec<ModelId>> = Vec::with_capacity(models.len());
    for model in models.iter() {
        let mut used = Vec::new();
        models_in(&types, model.ty, &mut used, &mut walk);
        uses.push(used);
    }
    // The groups shared by every use of each model so far, from the top
    // level down; none for a model not yet reached.
    let mut shared: Vec<Option<Vec<GroupId>>> = vec![None; models.len()];
    // The last method that reached each model, so a method walks each
    // model once.
    let mut reached_by: Vec<usize> = vec![usize::MAX; models.len()];
    let mut stack = Vec::new();
    for (i, method) in methods.iter().enumerate() {
        method_models(&types, method, &mut stack, &mut walk);
        let path = &groups[method.group.index()].path;
        while let Some(id) = stack.pop() {
            let m = id.index();
            if reached_by[m] == i {
                continue;
            }
            reached_by[m] = i;
            if let Some(shared) = &mut shared[m] {
                let mut len = 0;
                while len < shared.len() && len < path.len() && shared[len] == path[len] {
                    len += 1;
                }
                shared.truncate(len);
            } else {
                shared[m] = Some(path.clone());
            }
            stack.extend_from_slice(&uses[m]);
        }
    }
    let mut top = Vec::new();
    for (m, shared) in shared.into_iter().enumerate() {
        let id = ModelId(m as u32);
        let group = match shared {
            Some(shared) => shared.last().copied(),
            None => None,
        };
        models[m].group = group;
        match group {
            Some(group) => groups[group.index()].models.push(id),
            None => top.push(id),
        }
    }
    top
}

/// The types of a `Forge`, and the arenas of their lists.
struct Types<'a> {
    types: &'a [TypeData],
    fields: &'a List<FieldData>,
    members: &'a List<TypeId>,
}

/// Adds to `out` the models that `method` uses directly. `stack` is space
/// for [`models_in`].
fn method_models(types: &Types<'_>, method: &MethodData, out: &mut Vec<ModelId>, stack: &mut Vec<TypeId>) {
    if let Some(request) = method.request {
        models_in(types, request, out, stack);
    }
    if let Some(headers) = method.headers {
        models_in(types, headers, out, stack);
    }
    if let Some(body) = &method.body {
        for content in &body.contents {
            models_in(types, content.ty, out, stack);
        }
    }
    for response in &method.responses {
        for content in &response.contents {
            models_in(types, content.ty, out, stack);
        }
    }
    for response in &method.errors {
        for content in &response.contents {
            models_in(types, content.ty, out, stack);
        }
    }
}

/// Adds to `out` the models that `ty` uses, without looking inside them.
/// `stack` is space for the types still to look at, which is left empty.
fn models_in(types: &Types<'_>, ty: TypeId, out: &mut Vec<ModelId>, stack: &mut Vec<TypeId>) {
    stack.push(ty);
    while let Some(ty) = stack.pop() {
        match &types.types[ty.index()] {
            TypeData::Scalar(_) | TypeData::Enum(_) => {}
            TypeData::Array(array) => stack.push(array.elem),
            TypeData::Object(object) => {
                for field in types.fields.get(object.fields) {
                    stack.push(field.ty);
                }
                if let Some(extra) = object.extra {
                    stack.push(extra);
                }
            }
            TypeData::Union(union) => {
                stack.extend_from_slice(types.members.get(union.members));
                if let Some(discriminator) = &union.discriminator {
                    for case in &discriminator.cases {
                        stack.push(case.1);
                    }
                    if let Some(default) = discriminator.default {
                        out.push(default);
                    }
                }
            }
            TypeData::Intersection(members) => stack.extend_from_slice(types.members.get(*members)),
            TypeData::Model(id) => out.push(*id),
        }
    }
}

/// The objects in `components` of a document, by name.
struct Index<'d> {
    schemas: HashMap<&'d str, Schema>,
    parameters: HashMap<&'d str, Id<Parameter>>,
    request_bodies: HashMap<&'d str, Id<RequestBody>>,
    responses: HashMap<&'d str, Id<Response>>,
    path_items: HashMap<&'d str, Id<PathItem>>,
}

impl<'d> Index<'d> {
    fn new(doc: &'d Doc) -> Index<'d> {
        let components = doc.components;
        Index {
            schemas: by_name(doc, components.schemas),
            parameters: by_name(doc, components.parameters),
            request_bodies: by_name(doc, components.request_bodies),
            responses: by_name(doc, components.responses),
            path_items: by_name(doc, components.path_items),
        }
    }
}

/// Returns the values of `entries` by key. Of two entries with the same
/// key, the last one is kept.
fn by_name<T: Copy>(doc: &Doc, entries: Span<(Str, T)>) -> HashMap<&str, T>
where
    (Str, T): Item,
{
    let entries = doc.list(entries);
    let mut map = HashMap::with_capacity(entries.len());
    for &(name, value) in entries {
        map.insert(doc.str(name), value);
    }
    map
}

/// What a `Forge` is built from while the document is read.
struct Builder<'d> {
    doc: &'d Doc,
    index: &'d Index<'d>,
    /// Whether the document is OpenAPI 3.0, where the keywords next to a
    /// `$ref` are ignored.
    v30: bool,

    groups: Vec<GroupData>,
    top: Vec<GroupId>,
    /// Each group by its parent, or none for a top-level group, and name.
    group_index: HashMap<(Option<GroupId>, Name), GroupId>,
    methods: Vec<MethodData>,
    /// Each method by group and name.
    method_index: HashMap<(GroupId, Name), MethodId>,
    types: Vec<TypeData>,
    /// The type of each scalar, which every use shares.
    scalars: Vec<(Scalar, TypeId)>,
    models: Vec<ModelData>,
    /// The type of each model, indexed by `ModelId`, which every use
    /// shares.
    model_types: Vec<TypeId>,
    /// Each model by schema name.
    model_index: HashMap<String, ModelId>,
    /// The `$ref`s being written in place, innermost last, to catch one
    /// that leads back to itself.
    inline_refs: Vec<String>,

    /// What is being read, to start each error with.
    context: Context<'d>,
    errors: Vec<String>,

    // The arenas of the `Forge`.
    strings: Strings,
    /// Every name of a field, once each, and its ID.
    name_ids: HashMap<Name, NameId>,
    /// The ID of the name each string is written as.
    names_by_text: HashMap<&'d str, NameId>,
    /// The ID of the empty name, once there is one.
    empty_name: Option<NameId>,
    fields: List<FieldData>,
    members: List<TypeId>,
    values: List<EnumData>,
    /// Lists to build the fields of objects in, kept to be used again.
    spare_fields: Vec<Vec<FieldData>>,
}

/// What a [`Builder`] is reading, which is written only for an error.
#[derive(Clone, Copy)]
enum Context<'d> {
    None,
    /// The path item at a path.
    Path(&'d str),
    /// The operation of a method and path, such as `GET /a`.
    Operation(&'d str, &'d str),
    /// The alias at an index in `x-forge-aliases` of the operation of a
    /// method and path.
    Alias(&'d str, &'d str, usize),
    /// The schema of a model.
    Schema(ModelId),
}

impl<'d> Builder<'d> {
    fn new(doc: &'d Doc, index: &'d Index<'d>, v30: bool) -> Builder<'d> {
        Builder {
            doc,
            index,
            v30,
            groups: Vec::new(),
            top: Vec::new(),
            group_index: HashMap::new(),
            methods: Vec::new(),
            method_index: HashMap::new(),
            types: Vec::new(),
            scalars: Vec::new(),
            models: Vec::new(),
            model_types: Vec::new(),
            model_index: HashMap::new(),
            inline_refs: Vec::new(),
            context: Context::None,
            errors: Vec::new(),
            strings: Strings::default(),
            name_ids: HashMap::new(),
            names_by_text: HashMap::new(),
            empty_name: None,
            fields: List::default(),
            members: List::default(),
            values: List::default(),
            spare_fields: Vec::new(),
        }
    }

    /// Adds a method for each operation in `paths`.
    fn add_paths(&mut self, paths: Span<(Str, Id<PathItem>)>) {
        let doc = self.doc;
        let index = self.index;
        for &(path, item) in doc.list(paths) {
            let path = doc.str(path);
            self.context = Context::Path(path);
            let Some(item) = self.follow(item, &index.path_items, "pathItems") else {
                continue;
            };
            let fixed = [
                (item.get, HttpMethod::Get, "GET"),
                (item.put, HttpMethod::Put, "PUT"),
                (item.post, HttpMethod::Post, "POST"),
                (item.delete, HttpMethod::Delete, "DELETE"),
                (item.options, HttpMethod::Options, "OPTIONS"),
                (item.head, HttpMethod::Head, "HEAD"),
                (item.patch, HttpMethod::Patch, "PATCH"),
                (item.trace, HttpMethod::Trace, "TRACE"),
                (item.query, HttpMethod::Query, "QUERY"),
                (item.connect, HttpMethod::Connect, "CONNECT"),
            ];
            let mut present: Vec<HttpMethod> = Vec::with_capacity(fixed.len());
            for (operation, http_method, method) in fixed {
                if let Some(operation) = operation {
                    present.push(http_method.clone());
                    self.add_operation(path, item, doc.get(operation), http_method, method);
                }
            }
            // HTTP methods are case sensitive:
            // https://www.rfc-editor.org/rfc/rfc9110#name-overview
            for &(method, operation) in doc.list(item.additional_operations) {
                let method = doc.str(method);
                let http_method = match fixed_method(method) {
                    Some(http_method) => http_method,
                    None => HttpMethod::Other(method.to_string()),
                };
                // The fixed field of the same method wins.
                if present.contains(&http_method) {
                    continue;
                }
                self.add_operation(path, item, doc.get(operation), http_method, method);
            }
        }
    }

    /// Adds the methods of `operation`, of the path item `item` at `path`:
    /// one for each of its aliases if it has `x-forge-aliases`, and else
    /// one for the operation itself, if it is one. `method` is
    /// `http_method` as a request sends it.
    fn add_operation(
        &mut self,
        path: &'d str,
        item: &'d PathItem,
        operation: &'d Operation,
        http_method: HttpMethod,
        method: &'d str,
    ) {
        let doc = self.doc;
        let Some(aliases) = operation.aliases else {
            self.context = Context::Operation(method, path);
            self.add_method(path, item, operation, &operation.definition, http_method);
            return;
        };
        // The operation's own definition makes no method, so its
        // `x-fern-ignore` does not stop its aliases.
        for (i, alias) in doc.list(aliases).iter().enumerate() {
            self.context = Context::Alias(method, path, i);
            self.add_method(path, item, operation, alias, http_method.clone());
        }
    }

    /// Adds the method `definition` makes of `operation`, of the path item
    /// `item` at `path`, if it makes one. `definition` is the operation's
    /// own or one of its aliases, which the context names.
    fn add_method(
        &mut self,
        path: &'d str,
        item: &'d PathItem,
        operation: &'d Operation,
        definition: &'d Definition,
        http_method: HttpMethod,
    ) {
        let doc = self.doc;
        if definition.ignore {
            return;
        }
        if definition.method_name.is_empty() {
            return;
        }
        let group_names = doc.list(definition.group_names);
        if group_names.is_empty() {
            return;
        }
        let group_names: Vec<Name> = group_names.iter().map(|&name| Name::new(doc.str(name))).collect();
        for name in &group_names {
            if name.is_empty() {
                self.error("x-fern-sdk-group-name has a group name with no letters or digits");
                return;
            }
        }
        let name = Name::new(doc.str(definition.method_name));
        if name.is_empty() {
            self.error("x-fern-sdk-method-name has no letters or digits");
            return;
        }
        let mut availability = None;
        if let Some(value) = definition.availability {
            let value = doc.str(value);
            availability = parse_availability(value);
            if availability.is_none() {
                self.error(format_args!(
                    "x-fern-availability {value:?} is not alpha, beta, preview, generally-available or deprecated"
                ));
            }
        }
        let mut group = None;
        for group_name in group_names {
            group = Some(self.child(group, group_name));
        }
        let Some(group) = group else {
            return;
        };
        let id = MethodId(u32::try_from(self.methods.len()).expect("fewer than 2^32 methods"));
        match self.method_index.entry((group, name.clone())) {
            Entry::Occupied(entry) => {
                let other = &self.methods[entry.get().index()];
                let message = format!(
                    "method {:?} is also {} {} in the same group",
                    name.words().join(" "),
                    other.http_method.as_str(),
                    self.strings.get(other.path)
                );
                self.error(message);
                return;
            }
            // The method is added below, with this ID.
            Entry::Vacant(entry) => {
                entry.insert(id);
            }
        }

        // The rest is the operation's, which every alias shares, so an
        // error in it names the operation, and is reported once.
        if let Context::Alias(method, path, _) = self.context {
            self.context = Context::Operation(method, path);
        }
        let declared = self.declared(item, operation);
        let (mut fields, locations) = self.params(path, &declared);
        let headers = self.headers(&declared);
        let mut body = None;
        if let Some(request_body) = operation.request_body {
            let index = self.index;
            if let Some(request_body) = self.follow(request_body, &index.request_bodies, "requestBodies") {
                body = Some(self.body(request_body));
            }
        }
        let mut params = None;
        let mut request = None;
        if let Some(body) = &body {
            let body_ty = match body.json {
                Some(i) => body.contents[i as usize].ty,
                None => self.scalar(Scalar::Unknown),
            };
            if fields.is_empty() {
                request = Some(body_ty);
                self.spare_fields.push(fields);
            } else if self.has_fields(body_ty, 0) && !self.shares_a_name(body_ty, &fields, 0) {
                let object = self.params_object(fields);
                params = Some(object);
                request = Some(self.intersection(&[object, body_ty]));
            } else {
                fields.push(FieldData {
                    wire_name: self.strings.push("body"),
                    name: self.name("body"),
                    required: body.required,
                    ty: body_ty,
                    description: body.description,
                    deprecated: false,
                    read_only: false,
                    sensitive: false,
                    default: None,
                });
                params = Some(self.params_object(fields));
                request = params;
            }
        } else if !fields.is_empty() {
            params = Some(self.params_object(fields));
            request = params;
        } else {
            self.spare_fields.push(fields);
        }
        let (responses, errors) = self.responses(operation);

        self.groups[group.index()].methods.push(id);
        self.methods.push(MethodData {
            name,
            group,
            http_method,
            path: self.strings.push(path),
            summary: self.strings.push(doc.str(operation.summary)),
            description: self.strings.push(doc.str(operation.description)),
            deprecated: operation.deprecated,
            availability,
            hidden: definition.hidden,
            confirmation: definition.confirmation.map(|s| self.strings.push(doc.str(s))),
            request,
            params,
            locations,
            headers,
            body,
            responses,
            errors,
            extensions: definition.extensions,
        });
    }

    /// Returns the group `name` inside `parent`, or at the top level if
    /// `parent` is none, adding it if it is missing.
    fn child(&mut self, parent: Option<GroupId>, name: Name) -> GroupId {
        let key = (parent, name);
        if let Some(&id) = self.group_index.get(&key) {
            return id;
        }
        let name = &key.1;
        let id = GroupId(u32::try_from(self.groups.len()).expect("fewer than 2^32 groups"));
        let mut path = match parent {
            Some(parent) => self.groups[parent.index()].path.clone(),
            None => Vec::new(),
        };
        path.push(id);
        self.groups.push(GroupData {
            name: name.clone(),
            description: String::new(),
            groups: Vec::new(),
            path,
            methods: Vec::new(),
            models: Vec::new(),
        });
        match parent {
            Some(parent) => self.groups[parent.index()].groups.push(id),
            None => self.top.push(id),
        }
        self.group_index.insert(key, id);
        id
    }

    /// Returns each parameter of `operation` and of its path item `item`,
    /// with its own description, as [`param`](Builder::param) gives them:
    /// the path item's in the order they are declared, then the
    /// operation's. An operation's parameter that is the same as one
    /// before it, as [`same_param`] says, takes its place instead.
    fn declared(&mut self, item: &'d PathItem, operation: &'d Operation) -> Vec<(&'d Parameter, Str)> {
        let doc = self.doc;
        let mut declared: Vec<(&'d Parameter, Str)> = Vec::new();
        for &param in doc.list(item.parameters) {
            if let Some(declaration) = self.param(param) {
                declared.push(declaration);
            }
        }
        for &param in doc.list(operation.parameters) {
            let Some(declaration) = self.param(param) else {
                continue;
            };
            match declared
                .iter_mut()
                .find(|other| same_param(doc, other.0, declaration.0))
            {
                Some(other) => *other = declaration,
                None => declared.push(declaration),
            }
        }
        declared
    }

    /// Returns a field for each path and query parameter in `declared`,
    /// the parameters of an operation at `path` as
    /// [`declared`](Builder::declared) gives them, and where each is sent.
    fn params(&mut self, path: &'d str, declared: &[(&'d Parameter, Str)]) -> (Vec<FieldData>, Vec<Location>) {
        let doc = self.doc;
        let mut fields = self.spare_fields.pop().unwrap_or_default();
        let mut locations = Vec::new();
        for placeholder in placeholders(path) {
            let mut declaration = None;
            for &(param, description) in declared {
                if param.location == Some(ParameterLocation::Path) && doc.str(param.name) == placeholder {
                    declaration = Some((param, description));
                    break;
                }
            }
            let field = match declaration {
                Some((param, description)) => {
                    if !self.check_param(param, ParameterStyle::Simple) {
                        continue;
                    }
                    // A caller must always send a path parameter, so it
                    // is never deprecated.
                    self.param_field(param, description, true, false)
                }
                None => FieldData {
                    wire_name: self.strings.push(placeholder),
                    name: self.name(placeholder),
                    required: true,
                    ty: self.scalar(Scalar::String),
                    description: Str::default(),
                    deprecated: false,
                    read_only: false,
                    sensitive: false,
                    default: None,
                },
            };
            fields.push(field);
            locations.push(Location::Path);
        }

        let mut has_query = false;
        let mut query_string = None;
        for &(param, description) in declared {
            match param.location {
                Some(ParameterLocation::Query) => {
                    has_query = true;
                    if !self.check_param(param, ParameterStyle::Form) {
                        continue;
                    }
                    let exploded = param.explode != Some(false);
                    let field = self.param_field(param, description, param.required, param.deprecated);
                    fields.push(field);
                    locations.push(Location::Query { exploded });
                }
                Some(ParameterLocation::Querystring) if query_string.is_some() => {
                    self.error("has more than one querystring parameter");
                }
                Some(ParameterLocation::Querystring) => query_string = Some(param),
                // Path parameters, which are read in the order of the path
                // template, header parameters, which are read by
                // `headers`, and cookie parameters, which are ignored.
                _ => {}
            }
        }
        if let Some(param) = query_string {
            if has_query {
                let message = format!(
                    "has querystring parameter {:?} and query parameters, \
                     but can have only one or the other",
                    doc.str(param.name)
                );
                self.error(message);
            } else if let Some(&(_, schema)) = doc.list(param.content).first()
                && let Some(Schema::Object(schema)) = self.deref(schema)
            {
                let mut more = self.fields(doc.get(schema));
                for mut field in more.drain(..) {
                    // A client sends every parameter.
                    field.read_only = false;
                    fields.push(field);
                    locations.push(Location::Query { exploded: true });
                }
                self.spare_fields.push(more);
            }
        }
        (fields, locations)
    }

    /// Returns the object of a field for each header parameter in
    /// `declared`, the parameters of an operation as
    /// [`declared`](Builder::declared) gives them, in the same order, or
    /// `None` if there are none. Every header parameter is kept, even one
    /// named `Accept`, `Content-Type` or `Authorization`, which OpenAPI
    /// says to ignore.
    fn headers(&mut self, declared: &[(&'d Parameter, Str)]) -> Option<TypeId> {
        let mut fields = self.spare_fields.pop().unwrap_or_default();
        for &(param, description) in declared {
            if param.location != Some(ParameterLocation::Header) || !self.check_param(param, ParameterStyle::Simple) {
                continue;
            }
            fields.push(self.param_field(param, description, param.required, param.deprecated));
        }
        if fields.is_empty() {
            self.spare_fields.push(fields);
            return None;
        }
        self.check_names(&fields, "header parameters");
        Some(self.object_of(fields, None))
    }

    /// Returns `param`, after following its `$ref`, and its own
    /// description, or `None` if it has no name or location.
    ///
    /// From OpenAPI 3.1, a Reference Object's `description` overrides the
    /// referenced parameter's, so the description is the first one next
    /// to a `$ref` along the way, or else the parameter's. In 3.0 the
    /// keywords next to a `$ref` are ignored.
    fn param(&mut self, param: Id<Parameter>) -> Option<(&'d Parameter, Str)> {
        let index = self.index;
        let v30 = self.v30;
        let mut description = Str::default();
        let param = self.follow_visiting(param, &index.parameters, "parameters", |reference| {
            if !v30 && description.is_empty() {
                description = reference.description;
            }
        })?;
        if param.name.is_empty() || param.location.is_none() {
            self.error("a parameter has no name or no in");
            return None;
        }
        if description.is_empty() {
            description = param.description;
        }
        Some((param, description))
    }

    /// Reports whether `param` is covered: it has a `schema` rather than
    /// `content`, and its style is the default, `style`. Adds an error if
    /// not.
    fn check_param(&mut self, param: &Parameter, style: ParameterStyle) -> bool {
        let doc = self.doc;
        let location = match param.location {
            Some(location) => location.as_str(),
            None => "",
        };
        if !param.content.is_empty() {
            self.error(format_args!(
                "{location} parameter {:?} has content, which is not covered: only schema is",
                doc.str(param.name)
            ));
            return false;
        }
        if let Some(other) = param.style
            && other != style
        {
            self.error(format_args!(
                "{location} parameter {:?} has style {:?}, which is not covered: only {} is",
                doc.str(param.name),
                other.as_str(),
                style.as_str()
            ));
            return false;
        }
        true
    }

    /// Returns the field of `param`, whose own description, as
    /// [`param`](Builder::param) gives it, is `description`. Without one,
    /// the field has the description of the parameter's schema. Whether
    /// the field is required and deprecated is `required` and
    /// `deprecated`, since that depends on where the parameter is sent.
    /// The field is sensitive when the parameter's schema is, and never
    /// read-only, since a client sends every parameter. Its default is
    /// the schema's, since a Parameter Object has none of its own.
    fn param_field(&mut self, param: &'d Parameter, description: Str, required: bool, deprecated: bool) -> FieldData {
        let doc = self.doc;
        let ty = self.ty(param.schema);
        let mut description = doc.str(description);
        if description.is_empty() {
            description = self.schema_description(param.schema);
        }
        let wire_name = doc.str(param.name);
        FieldData {
            wire_name: self.strings.push(wire_name),
            name: self.field_name(param.field_name, wire_name),
            required,
            ty,
            description: self.strings.push(description),
            deprecated,
            read_only: false,
            sensitive: self.schema_flags(param.schema).sensitive,
            default: self.schema_default(param.schema),
        }
    }

    /// Returns the name of the field of a property or parameter written as
    /// `wire_name`, whose name extension, such as `x-fern-property-name`,
    /// is `extension`. The extension gives the name if it has letters or
    /// digits.
    fn field_name(&mut self, extension: Str, wire_name: &'d str) -> NameId {
        if !extension.is_empty() {
            let name = self.name(self.doc.str(extension));
            if Some(name) != self.empty_name {
                return name;
            }
        }
        self.name(wire_name)
    }

    /// Returns the name written as `text`.
    fn name(&mut self, text: &'d str) -> NameId {
        if let Some(&id) = self.names_by_text.get(text) {
            return id;
        }
        let name = Name::new(text);
        let empty = name.is_empty();
        let next = NameId(u32::try_from(self.name_ids.len()).expect("fewer than 2^32 names"));
        let id = *self.name_ids.entry(name).or_insert(next);
        if empty {
            self.empty_name = Some(id);
        }
        self.names_by_text.insert(text, id);
        id
    }

    /// Returns the object of the parameters `fields`, which must have
    /// different names.
    fn params_object(&mut self, fields: Vec<FieldData>) -> TypeId {
        self.check_names(&fields, "parameters");
        self.object_of(fields, None)
    }

    /// Returns the object of `fields` and `extra`. `fields` is emptied, and
    /// kept to be used again.
    fn object_of(&mut self, mut fields: Vec<FieldData>, extra: Option<TypeId>) -> TypeId {
        let span = self.fields.extend(fields.drain(..));
        self.spare_fields.push(fields);
        self.push(TypeData::Object(ObjectData { fields: span, extra }))
    }

    /// Returns the intersection of `members`.
    fn intersection(&mut self, members: &[TypeId]) -> TypeId {
        let members = self.members.extend(members.iter().copied());
        self.push(TypeData::Intersection(members))
    }

    /// Returns the union of `members`, which must be different, with
    /// `discriminator`, which is `exclusive` if a value is at most one of
    /// them.
    fn push_union(&mut self, members: &[TypeId], discriminator: Option<DiscriminatorData>, exclusive: bool) -> TypeId {
        let members = self.members.extend(members.iter().copied());
        self.push(TypeData::Union(UnionData {
            members,
            exclusive,
            discriminator,
        }))
    }

    /// Reports whether `ty` is an object with fields, or a model, union or
    /// intersection of them, so that it can be intersected with the
    /// parameters.
    fn has_fields(&self, ty: TypeId, depth: u32) -> bool {
        if depth > 32 {
            return false;
        }
        match &self.types[ty.index()] {
            TypeData::Object(object) => !object.fields.is_empty(),
            TypeData::Model(id) => self.has_fields(self.models[id.index()].ty, depth + 1),
            TypeData::Union(UnionData { members, .. }) | TypeData::Intersection(members) => {
                for &member in self.members.get(*members) {
                    if !self.has_fields(member, depth + 1) {
                        return false;
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// Reports whether `ty` has a field with the name of one of `params`.
    fn shares_a_name(&self, ty: TypeId, params: &[FieldData], depth: u32) -> bool {
        if depth > 32 {
            return false;
        }
        match &self.types[ty.index()] {
            TypeData::Object(object) => {
                for field in self.fields.get(object.fields) {
                    for param in params {
                        if field.name == param.name {
                            return true;
                        }
                    }
                }
                false
            }
            TypeData::Model(id) => self.shares_a_name(self.models[id.index()].ty, params, depth + 1),
            TypeData::Union(UnionData { members, .. }) | TypeData::Intersection(members) => {
                for &member in self.members.get(*members) {
                    if self.shares_a_name(member, params, depth + 1) {
                        return true;
                    }
                }
                false
            }
            _ => false,
        }
    }

    /// Returns the data of the request body `body`.
    fn body(&mut self, body: &'d RequestBody) -> BodyData {
        let (contents, json) = self.contents(body.content);
        BodyData {
            required: body.required,
            description: self.strings.push(self.doc.str(body.description)),
            contents,
            json,
        }
    }

    /// Returns the success responses and the other responses of
    /// `operation`, each sorted by status.
    fn responses(&mut self, operation: &'d Operation) -> (Vec<ResponseData>, Vec<ResponseData>) {
        let doc = self.doc;
        let index = self.index;
        let mut responses = Vec::new();
        let mut errors = Vec::new();
        for &(status, response) in doc.list(operation.responses) {
            let Some(response) = self.follow(response, &index.responses, "responses") else {
                continue;
            };
            let status = doc.str(status);
            let (contents, json) = self.contents(response.content);
            let data = ResponseData {
                status: self.strings.push(status),
                description: self.strings.push(doc.str(response.description)),
                contents,
                json,
            };
            if status.starts_with('2') {
                responses.push(data);
            } else {
                errors.push(data);
            }
        }
        let strings = &self.strings;
        responses.sort_by(|a, b| strings.get(a.status).cmp(strings.get(b.status)));
        errors.sort_by(|a, b| strings.get(a.status).cmp(strings.get(b.status)));
        (responses, errors)
    }

    /// Returns the `content` of a body or response, sorted by media type,
    /// each typed by its schema whatever the media type, and the index of
    /// its JSON content: `application/json`, or else the first JSON media
    /// type.
    fn contents(&mut self, content: Span<(Str, Schema)>) -> (Vec<ContentData>, Option<u32>) {
        let doc = self.doc;
        let content = doc.list(content);
        let mut entries: Vec<(&'d str, Schema)> = Vec::with_capacity(content.len());
        for &(media_type, schema) in content {
            entries.push((doc.str(media_type), schema));
        }
        entries.sort_by(|a, b| a.0.cmp(b.0));
        let mut contents = Vec::with_capacity(entries.len());
        let mut json = None;
        let mut json_is_exact = false;
        for (media_type, schema) in entries {
            let i = contents.len() as u32;
            let ty = self.ty(schema);
            let description = self.schema_description(schema);
            if is_json(media_type) && !json_is_exact {
                let exact = media_type.split(';').next().unwrap_or_default().trim();
                json_is_exact = exact.eq_ignore_ascii_case("application/json");
                if json.is_none() || json_is_exact {
                    json = Some(i);
                }
            }
            contents.push(ContentData {
                media_type: self.strings.push(media_type),
                ty,
                description: self.strings.push(description),
            });
        }
        (contents, json)
    }

    /// Adds an error if two of `fields` have equal names. `what` is what
    /// the fields are, such as `parameters`.
    fn check_names(&mut self, fields: &[FieldData], what: &str) {
        // Each field is reported with the last one before it with an equal
        // name. Most objects have few fields, which are compared directly.
        if fields.len() <= 16 {
            for (i, field) in fields.iter().enumerate() {
                if let Some(other) = fields[..i].iter().rev().find(|other| other.name == field.name) {
                    self.equal_names(what, other.wire_name, field.wire_name);
                }
            }
            return;
        }
        let mut seen: HashMap<NameId, Str> = HashMap::with_capacity(fields.len());
        for field in fields {
            if let Some(other) = seen.insert(field.name, field.wire_name) {
                self.equal_names(what, other, field.wire_name);
            }
        }
    }

    /// Adds an error for two `what`, such as fields, with the wire names
    /// `a` and `b` and equal names.
    fn equal_names(&mut self, what: &str, a: Str, b: Str) {
        let message = format!(
            "{what} {:?} and {:?} have equal names",
            self.strings.get(a),
            self.strings.get(b)
        );
        self.error(message);
    }

    /// Returns the object `id`, or the object in `components.{kind}`, which
    /// is `components`, that its `$ref` points to, following `$ref`s until
    /// an object has none. Adds an error and returns `None` if one points
    /// to anything else.
    fn follow<T: Referable>(&mut self, id: Id<T>, components: &HashMap<&'d str, Id<T>>, kind: &str) -> Option<&'d T> {
        self.follow_visiting(id, components, kind, |_| {})
    }

    /// Returns what [`follow`](Builder::follow) does, calling `visit` with
    /// each object along the way that has a `$ref`, from `id` on, so that
    /// the keywords next to it can be read.
    fn follow_visiting<T: Referable>(
        &mut self,
        id: Id<T>,
        components: &HashMap<&'d str, Id<T>>,
        kind: &str,
        mut visit: impl FnMut(&'d T),
    ) -> Option<&'d T> {
        let doc = self.doc;
        let mut value = doc.get(id);
        for _ in 0..32 {
            let reference = value.reference();
            if reference.is_empty() {
                return Some(value);
            }
            visit(value);
            let reference = doc.str(reference);
            let mut segments = match pointer(reference) {
                Ok(segments) => segments,
                Err(err) => {
                    self.error(err);
                    return None;
                }
            };
            let (Some(first), Some(second), Some(name), None) =
                (segments.next(), segments.next(), segments.next(), segments.next())
            else {
                self.error(format_args!(
                    "$ref {reference:?} is not covered: only $refs to components.{kind} are"
                ));
                return None;
            };
            if first != "components" || second != kind {
                self.error(format_args!(
                    "$ref {reference:?} is not covered: only $refs to components.{kind} are"
                ));
                return None;
            }
            let Some(&target) = components.get(name.as_ref()) else {
                self.error(format_args!("$ref {reference:?} points to nothing"));
                return None;
            };
            value = doc.get(target);
        }
        self.error(format_args!("a $ref in components.{kind} leads back to itself"));
        None
    }

    /// Adds an error, starting with what is being read.
    fn error(&mut self, message: impl fmt::Display) {
        let message = match self.context {
            Context::None => message.to_string(),
            Context::Path(path) => format!("path {path}: {message}"),
            Context::Operation(method, path) => format!("{method} {path}: {message}"),
            Context::Alias(method, path, i) => format!("{method} {path}: x-forge-aliases[{i}]: {message}"),
            Context::Schema(id) => {
                let schema_name = self.strings.get(self.models[id.index()].schema_name);
                format!("schema {schema_name:?}: {message}")
            }
        };
        if !self.errors.contains(&message) {
            self.errors.push(message);
        }
    }
}

/// Returns the method of the fixed field of a Path Item Object that is
/// `method` as a request sends it, such as `GET`, or `None` if there is
/// none.
fn fixed_method(method: &str) -> Option<HttpMethod> {
    match method {
        "GET" => Some(HttpMethod::Get),
        "PUT" => Some(HttpMethod::Put),
        "POST" => Some(HttpMethod::Post),
        "DELETE" => Some(HttpMethod::Delete),
        "OPTIONS" => Some(HttpMethod::Options),
        "HEAD" => Some(HttpMethod::Head),
        "PATCH" => Some(HttpMethod::Patch),
        "TRACE" => Some(HttpMethod::Trace),
        "QUERY" => Some(HttpMethod::Query),
        "CONNECT" => Some(HttpMethod::Connect),
        _ => None,
    }
}

/// Returns the availability `value` is as `x-fern-availability` writes
/// it, such as `beta`, or `None` if it is none of them. Case matters.
fn parse_availability(value: &str) -> Option<Availability> {
    match value {
        "alpha" => Some(Availability::Alpha),
        "beta" => Some(Availability::Beta),
        "preview" => Some(Availability::Preview),
        "generally-available" => Some(Availability::GenerallyAvailable),
        "deprecated" => Some(Availability::Deprecated),
        _ => None,
    }
}

/// Reports whether `a` and `b` are the same parameter, so that one replaces
/// the other: they have the same location and name. Header names are
/// compared ignoring ASCII case, since HTTP field names are
/// case-insensitive: <https://www.rfc-editor.org/rfc/rfc9110#name-field-names>.
fn same_param(doc: &Doc, a: &Parameter, b: &Parameter) -> bool {
    if a.location != b.location {
        return false;
    }
    let (a_name, b_name) = (doc.str(a.name), doc.str(b.name));
    if a.location == Some(ParameterLocation::Header) {
        a_name.eq_ignore_ascii_case(b_name)
    } else {
        a_name == b_name
    }
}

/// Returns the names of the placeholders in the path template `path`, such
/// as `id` in `/a/{id}`, in order.
fn placeholders(path: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let Some(len) = rest[open..].find('}') else {
            break;
        };
        names.push(&rest[open + 1..open + len]);
        rest = &rest[open + len + 1..];
    }
    names
}

/// Building types from schemas.
impl<'d> Builder<'d> {
    /// Returns the type of `schema`.
    fn ty(&mut self, schema: Schema) -> TypeId {
        let Schema::Object(schema) = schema else {
            // `true` allows any value. `false` allows none, which no type
            // says, and is left out where it matters, as in a property.
            return self.scalar(Scalar::Unknown);
        };
        let doc = self.doc;
        let schema = doc.get(schema);
        if schema.reference.is_empty() {
            self.object_ty(schema, schema.nullable)
        } else {
            self.ref_with_siblings(schema, doc.str(schema.reference))
        }
    }

    /// Returns the type of a schema with a `$ref`. In OpenAPI 3.0 the
    /// keywords next to it are ignored. From 3.1, `nullable` and the
    /// keywords that give a shape are kept.
    fn ref_with_siblings(&mut self, schema: &'d SchemaObject, reference: &str) -> TypeId {
        let ty = self.ref_ty(reference);
        if self.v30 {
            return ty;
        }
        let ty = if is_shapeless(self.doc, schema) {
            ty
        } else {
            // The rest of the schema, as if it had no `$ref` and was not
            // nullable.
            let rest = self.object_ty(schema, false);
            self.intersection(&[ty, rest])
        };
        self.nullable(ty, schema.nullable)
    }

    /// Returns the type of `schema`, leaving out its `$ref`, made nullable
    /// by `nullable`.
    fn object_ty(&mut self, schema: &'d SchemaObject, mut nullable: bool) -> TypeId {
        let doc = self.doc;
        let null_type = doc.list(schema.types).contains(&SchemaType::Null);
        if null_type {
            nullable = true;
        }
        let values = doc.list(schema.values);
        if !values.is_empty() {
            return self.enum_ty(values, nullable);
        }
        if let Some(value) = &schema.constant {
            return self.enum_ty(slice::from_ref(value), nullable);
        }
        let ty = if is_composed(schema) {
            self.composed(schema, null_type)
        } else {
            self.typed(schema, null_type)
        };
        self.nullable(ty, nullable)
    }

    /// Returns the type `reference` points to: a model for a schema in
    /// `components.schemas` or in the `$defs` of one, or else the type of
    /// what it points to, written in place.
    fn ref_ty(&mut self, reference: &str) -> TypeId {
        let (target, schema_name) = match self.resolve(reference) {
            Ok(resolved) => resolved,
            Err(err) => {
                self.error(err);
                return self.scalar(Scalar::Unknown);
            }
        };
        if let Some(schema_name) = schema_name {
            return self.model(schema_name, target);
        }
        if self.inline_refs.iter().any(|r| r == reference) {
            self.error(format_args!("$ref {reference:?} leads back to itself"));
            return self.scalar(Scalar::Unknown);
        }
        self.inline_refs.push(reference.to_string());
        let ty = self.ty(target);
        self.inline_refs.pop();
        ty
    }

    /// Returns the type of the model with schema name `schema_name`,
    /// whose schema is `schema`, adding the model if it is new.
    fn model(&mut self, schema_name: Cow<'_, str>, schema: Schema) -> TypeId {
        if let Some(&id) = self.model_index.get(schema_name.as_ref()) {
            return self.model_types[id.index()];
        }
        let schema_name = schema_name.into_owned();
        let doc = self.doc;
        let id = ModelId(u32::try_from(self.models.len()).expect("fewer than 2^32 models"));
        let mut name = None;
        let mut description = "";
        let mut deprecated = false;
        if let Schema::Object(object) = schema {
            let object = doc.get(object);
            name = name_of(doc, object.model_name);
            description = doc.str(object.description);
            if description.is_empty() {
                description = doc.str(object.title);
            }
            deprecated = object.deprecated;
        }
        let name = match name {
            Some(name) => name,
            None => model_name(&schema_name),
        };
        // The type is set once the schema is read, which can use the model
        // itself.
        let unknown = self.scalar(Scalar::Unknown);
        self.models.push(ModelData {
            schema_name: self.strings.push(&schema_name),
            name,
            group: None,
            description: self.strings.push(description),
            deprecated,
            ty: unknown,
        });
        let model_ty = self.push(TypeData::Model(id));
        self.model_types.push(model_ty);
        let context = mem::replace(&mut self.context, Context::Schema(id));
        self.model_index.insert(schema_name, id);
        // A `$ref` written in place outside the model does not lead back
        // to itself through it, since the model is not written in place.
        let inline_refs = mem::take(&mut self.inline_refs);
        let ty = self.ty(schema);
        self.inline_refs = inline_refs;
        self.context = context;
        self.models[id.index()].ty = ty;
        model_ty
    }

    /// Returns the type of `schema`, writing a model it refers to in
    /// place, so that its fields can be changed.
    fn ty_in_place(&mut self, schema: Schema) -> TypeId {
        let Schema::Object(object) = schema else {
            return self.ty(schema);
        };
        let doc = self.doc;
        let reference = doc.str(doc.get(object).reference);
        if reference.is_empty() {
            return self.ty(schema);
        }
        let Ok((target, Some(_))) = self.resolve(reference) else {
            return self.ty(schema);
        };
        if self.inline_refs.iter().any(|r| r == reference) {
            return self.ty(schema);
        }
        self.inline_refs.push(reference.to_string());
        let ty = self.ty(target);
        self.inline_refs.pop();
        ty
    }

    /// Returns the type of an `enum` of `values`, made nullable by `null`
    /// or a null value.
    fn enum_ty(&mut self, values: &[Literal], mut null: bool) -> TypeId {
        let doc = self.doc;
        let mut out: Vec<EnumData> = Vec::with_capacity(values.len());
        for &value in values {
            let value = match value {
                Literal::Null => {
                    null = true;
                    continue;
                }
                Literal::String(s) => EnumValue::String(doc.str(s)),
                Literal::Number(n) => EnumValue::Number(n),
                Literal::Boolean(b) => EnumValue::Boolean(b),
                Literal::Composite => return self.scalar(Scalar::Unknown),
            };
            if out.iter().any(|v| v.get(&self.strings) == value) {
                continue;
            }
            out.push(match value {
                EnumValue::String(s) => EnumData::String(self.strings.push(s)),
                EnumValue::Number(n) => EnumData::Number(n),
                EnumValue::Boolean(b) => EnumData::Boolean(b),
            });
        }
        if out.is_empty() {
            return self.scalar(if null { Scalar::Null } else { Scalar::Unknown });
        }
        let values = self.values.extend(out);
        let ty = self.push(TypeData::Enum(values));
        self.nullable(ty, null)
    }

    /// Returns the type of a schema without `allOf`, `anyOf` or `oneOf`,
    /// from its `type`. `null_type` says whether `type` lists `null`.
    fn typed(&mut self, schema: &'d SchemaObject, null_type: bool) -> TypeId {
        if schema.prefix_items {
            return self.scalar(Scalar::Unknown);
        }
        let all = self.doc.list(schema.types);
        let mut types = all.iter().copied().filter(|&ty| ty != SchemaType::Null);
        match (types.next(), types.next()) {
            (None, _) if null_type => self.scalar(Scalar::Null),
            (None, _) if !schema.properties.is_empty() || schema.additional_properties.is_some() => self.object(schema),
            (None, _) if schema.items.is_some() => self.array(schema),
            (None, _) => self.scalar(Scalar::Unknown),
            (Some(ty), None) => self.single(schema, ty),
            (Some(_), Some(_)) => {
                let mut members = Vec::with_capacity(all.len());
                for &ty in all {
                    if ty != SchemaType::Null {
                        members.push(self.single(schema, ty));
                    }
                }
                self.union_of(&members, None, true)
            }
        }
    }

    /// Returns the type of `schema` as the one type `ty`.
    fn single(&mut self, schema: &'d SchemaObject, ty: SchemaType) -> TypeId {
        let scalar = match ty {
            SchemaType::String => match schema.format {
                Format::DateTime => Scalar::DateTime,
                Format::Date => Scalar::Date,
                Format::Uuid => Scalar::Uuid,
                Format::Byte => Scalar::Bytes,
                Format::Binary => Scalar::Binary,
                _ if schema.content_encoding == ContentEncoding::Base64 => Scalar::Bytes,
                _ => Scalar::String,
            },
            SchemaType::Integer | SchemaType::Number => Scalar::Number(match schema.format {
                Format::Int8 => Number::Int8,
                Format::Int16 => Number::Int16,
                Format::Int32 => Number::Int32,
                Format::Int64 => Number::Int64,
                Format::Uint8 => Number::Uint8,
                Format::Uint16 => Number::Uint16,
                Format::Uint32 => Number::Uint32,
                Format::Uint64 => Number::Uint64,
                Format::Float => Number::Float,
                Format::Double => Number::Double,
                _ if ty == SchemaType::Integer => Number::Int,
                _ => Number::Double,
            }),
            SchemaType::Boolean => Scalar::Boolean,
            SchemaType::Null => Scalar::Null,
            SchemaType::Array => return self.array(schema),
            SchemaType::Object => return self.object(schema),
        };
        self.scalar(scalar)
    }

    fn array(&mut self, schema: &'d SchemaObject) -> TypeId {
        let elem = match schema.items {
            Some(items) => self.ty(items),
            None => self.scalar(Scalar::Unknown),
        };
        self.push(TypeData::Array(ArrayData {
            elem,
            min_items: schema.min_items,
            max_items: schema.max_items,
        }))
    }

    fn object(&mut self, schema: &'d SchemaObject) -> TypeId {
        let fields = self.fields(schema);
        let extra = match schema.additional_properties {
            None if schema.properties.is_empty() => Some(self.scalar(Scalar::Unknown)),
            None | Some(Schema::Bool(false)) => None,
            Some(Schema::Bool(true)) => Some(self.scalar(Scalar::Unknown)),
            Some(extra) => Some(self.ty(extra)),
        };
        self.object_of(fields, extra)
    }

    /// Returns a field for each property of `schema`.
    fn fields(&mut self, schema: &'d SchemaObject) -> Vec<FieldData> {
        let doc = self.doc;
        let properties = doc.list(schema.properties);
        let mut fields = self.spare_fields.pop().unwrap_or_default();
        fields.reserve(properties.len());
        for &(wire_name, property) in properties {
            let wire_name = doc.str(wire_name);
            let mut extension = Str::default();
            let mut deprecated = false;
            match property {
                Schema::Bool(false) => continue,
                Schema::Bool(true) => {}
                Schema::Object(object) => {
                    let object = doc.get(object);
                    if object.skip {
                        continue;
                    }
                    extension = object.field_name;
                    deprecated = object.deprecated;
                }
            }
            let description = self.schema_description(property);
            let flags = self.schema_flags(property);
            let name = self.field_name(extension, wire_name);
            let ty = self.ty(property);
            fields.push(FieldData {
                wire_name: self.strings.push(wire_name),
                name,
                required: false,
                ty,
                description: self.strings.push(description),
                deprecated,
                read_only: flags.read_only,
                sensitive: flags.sensitive,
                default: self.schema_default(property),
            });
        }
        for &name in doc.list(schema.required) {
            let name = doc.str(name);
            for field in &mut fields {
                if self.strings.get(field.wire_name) == name {
                    field.required = true;
                }
            }
        }
        self.check_names(&fields, "fields");
        fields
    }

    /// Returns the type of a schema with `allOf`, `anyOf` or `oneOf`: the
    /// intersection of its own object, its `allOf` members, its
    /// `unevaluatedProperties`, and a union for each of `anyOf` and
    /// `oneOf`. With none of them, its `type` gives the type.
    fn composed(&mut self, schema: &'d SchemaObject, null_type: bool) -> TypeId {
        let doc = self.doc;
        let mut parts = Vec::new();
        if !schema.properties.is_empty() || schema.additional_properties.is_some() {
            parts.push(self.object(schema));
        }
        self.all_of(doc.list(schema.all_of), &mut parts);
        if let extra @ Schema::Object(_) = schema.unevaluated_properties {
            let extra = self.ty(extra);
            let object = ObjectData {
                fields: Span::default(),
                extra: Some(extra),
            };
            parts.push(self.push(TypeData::Object(object)));
        }
        for (members, exclusive) in [(schema.any_of, false), (schema.one_of, true)] {
            let members = doc.list(members);
            if !members.is_empty()
                && let Some(union) = self.union(schema, members, exclusive)
            {
                parts.push(union);
            }
        }
        match parts[..] {
            [] => self.typed(schema, null_type),
            [part] => part,
            _ => self.intersection(&parts),
        }
    }

    /// Adds the types of the `allOf` `members` to `parts`, the members of
    /// one that is an intersection, and makes the fields that a member
    /// with only `required` lists required.
    fn all_of(&mut self, members: &'d [Schema], parts: &mut Vec<TypeId>) {
        let doc = self.doc;
        let mut required: Vec<&str> = Vec::new();
        for &member in members {
            if let Schema::Object(object) = member
                && is_required_only(doc, member)
            {
                for &name in doc.list(doc.get(object).required) {
                    required.push(doc.str(name));
                }
            }
        }
        for &member in members {
            if is_required_only(doc, member) || is_shapeless_member(doc, member) {
                continue;
            }
            // A model's fields cannot be made required without changing
            // the model, so it is written in place.
            let ty = if required.is_empty() {
                self.ty(member)
            } else {
                self.ty_in_place(member)
            };
            if let TypeData::Intersection(inner) = self.types[ty.index()] {
                parts.extend_from_slice(self.members.get(inner));
            } else {
                parts.push(ty);
            }
        }
        if required.is_empty() {
            return;
        }
        for &part in parts.iter() {
            if let TypeData::Object(object) = self.types[part.index()] {
                for field in self.fields.get_mut(object.fields) {
                    if required.contains(&self.strings.get(field.wire_name)) {
                        field.required = true;
                    }
                }
            }
        }
    }

    /// Returns the union of the `anyOf` or `oneOf` `members` of `schema`,
    /// which is `exclusive` for `oneOf`, or `None` if every member only
    /// constrains the value.
    fn union(&mut self, schema: &'d SchemaObject, members: &'d [Schema], exclusive: bool) -> Option<TypeId> {
        let doc = self.doc;
        let mut kept: Vec<(Schema, TypeId)> = Vec::with_capacity(members.len());
        for &member in members {
            if !is_constraint_only(doc, member) {
                let ty = self.ty(member);
                kept.push((member, ty));
            }
        }
        if kept.is_empty() {
            return None;
        }
        let discriminator = schema
            .discriminator
            .map(|discriminator| self.discriminator(doc.get(discriminator), &kept));
        let mut types = Vec::with_capacity(kept.len());
        for &(_, ty) in &kept {
            types.push(ty);
        }
        Some(self.union_of(&types, discriminator, exclusive))
    }

    /// Returns the union of `members`, which is `exclusive` if a value is
    /// at most one of them. A member that is a union without a
    /// discriminator adds its own members, and the union is exclusive only
    /// if that one is too; enums merge into one, and members that are the
    /// same type are one member. A single member is the type itself. Null
    /// is a member of a union around a discriminated one, so that the
    /// discriminated union has only its cases.
    fn union_of(
        &mut self,
        members: &[TypeId],
        discriminator: Option<DiscriminatorData>,
        mut exclusive: bool,
    ) -> TypeId {
        let mut out = Vec::with_capacity(members.len());
        let mut values = Vec::new();
        let mut null = false;
        for &member in members {
            if let TypeData::Union(inner) = &self.types[member.index()]
                && inner.discriminator.is_none()
            {
                exclusive &= inner.exclusive;
                for &inner_member in self.members.get(inner.members) {
                    self.add_member(inner_member, &mut out, &mut values, &mut null);
                }
            } else {
                self.add_member(member, &mut out, &mut values, &mut null);
            }
        }
        let unknown = self.scalar(Scalar::Unknown);
        if out.contains(&unknown) {
            // Any value, null included.
            return unknown;
        }
        if !values.is_empty() {
            let values = self.values.extend(values);
            out.push(self.push(TypeData::Enum(values)));
        }
        let null_ty = self.scalar(Scalar::Null);
        match out[..] {
            [] if null => return null_ty,
            [] => return unknown,
            [one] if !null => return one,
            // Null is not a value of the other member.
            [one] => return self.push_union(&[one, null_ty], None, true),
            _ => {}
        }
        if discriminator.is_some() && null {
            let inner = self.push_union(&out, discriminator, exclusive);
            return self.push_union(&[inner, null_ty], None, true);
        }
        if null {
            out.push(null_ty);
        }
        self.push_union(&out, discriminator, exclusive)
    }

    /// Adds `member` to the union being built: to `out`, unless it is
    /// already there, to `values` if it is an enum, or to `null`.
    fn add_member(&self, member: TypeId, out: &mut Vec<TypeId>, values: &mut Vec<EnumData>, null: &mut bool) {
        match &self.types[member.index()] {
            TypeData::Scalar(Scalar::Null) => *null = true,
            TypeData::Enum(enum_values) => {
                for &value in self.values.get(*enum_values) {
                    let new = value.get(&self.strings);
                    if !values.iter().any(|v| v.get(&self.strings) == new) {
                        values.push(value);
                    }
                }
            }
            _ => {
                if !out.contains(&member) {
                    out.push(member);
                }
            }
        }
    }

    /// Returns the discriminator of a union of `members`, each with its
    /// schema.
    fn discriminator(&mut self, discriminator: &'d Discriminator, members: &[(Schema, TypeId)]) -> DiscriminatorData {
        let doc = self.doc;
        let wire_name = doc.str(discriminator.property_name);
        let mut name = Name::new(wire_name);
        for &(schema, _) in members {
            if let Some(Schema::Object(property)) = self.find_property(schema, wire_name, 0)
                && let Some(field_name) = name_of(doc, doc.get(property).field_name)
            {
                name = field_name;
                break;
            }
        }
        let mut cases: Vec<(Str, TypeId)> = Vec::new();
        for &(value, target) in doc.list(discriminator.mapping) {
            let ty = self.mapping_ty(doc.str(target));
            cases.push((self.strings.push(doc.str(value)), ty));
        }
        for &(schema, ty) in members {
            let mut mapped = false;
            for case in &cases {
                if case.1 == ty {
                    mapped = true;
                }
            }
            if mapped {
                continue;
            }
            let mut value = None;
            if let Some(property) = self.find_property(schema, wire_name, 0)
                && let Some(only) = only_value(doc, property)
            {
                value = Some(self.strings.push(only));
            }
            if value.is_none()
                && let TypeData::Model(id) = &self.types[ty.index()]
            {
                value = Some(self.models[id.index()].schema_name);
            }
            if let Some(value) = value {
                cases.push((value, ty));
            }
        }
        let mut default = None;
        if !discriminator.default_mapping.is_empty() {
            let ty = self.mapping_ty(doc.str(discriminator.default_mapping));
            if let TypeData::Model(id) = self.types[ty.index()] {
                default = Some(id);
            }
        }
        let wire_name = self.strings.push(wire_name);
        DiscriminatorData {
            wire_name,
            name,
            cases,
            default,
        }
    }

    /// Returns the type a discriminator's mapping names: a `$ref`, or the
    /// name of a schema in `components.schemas`.
    fn mapping_ty(&mut self, target: &str) -> TypeId {
        if target.contains('#') || target.contains('/') {
            self.ref_ty(target)
        } else {
            self.ref_ty(&format!("#/components/schemas/{target}"))
        }
    }

    /// Returns the schema of the property `name` of `schema`, looking in
    /// its `allOf` members too, or `None` if it has none.
    fn find_property(&self, schema: Schema, name: &str, depth: u32) -> Option<Schema> {
        if depth > 8 {
            return None;
        }
        let doc = self.doc;
        let Schema::Object(object) = self.deref(schema)? else {
            return None;
        };
        let object = doc.get(object);
        for &(wire_name, property) in doc.list(object.properties) {
            if doc.str(wire_name) == name {
                return self.deref(property);
            }
        }
        for &member in doc.list(object.all_of) {
            if let Some(property) = self.find_property(member, name, depth + 1) {
                return Some(property);
            }
        }
        None
    }

    /// Returns the description of `schema`, as a field gives it: its own
    /// `description`, or else that of the schema its `$ref` points to,
    /// following `$ref`s, and from OpenAPI 3.1, that of its first `allOf`
    /// member with one. Never the `title`, which names a schema rather
    /// than describing a use of it.
    ///
    /// In 3.0, a `$ref` stands for the schema it points to, every keyword
    /// next to it is ignored, and the JSON Schema of 3.0 gives an `allOf`
    /// member's `description` no meaning for the schema around it. From
    /// 3.1, a `description` is an annotation, which applies to a value
    /// from the schema and from every schema applied to it in place: the
    /// one a `$ref` points to, and each `allOf` member. So a description
    /// next to a `$ref` is the schema's own, and with none, the first
    /// description of the `$ref`'s schema and then of the `allOf` members,
    /// in order, each read the same way, is the schema's. The members of
    /// `anyOf` and `oneOf` apply only to the values that match them, so
    /// none of their descriptions is.
    ///
    /// Returns an empty string if there is none, if a `$ref` does not
    /// point to a schema, which reading the schema's type reports, or if
    /// `$ref`s lead back to themselves.
    fn schema_description(&self, schema: Schema) -> &'d str {
        // Each schema read, which bounds schemas that lead back to
        // themselves through `allOf` as well as `$ref`.
        let mut budget = 64;
        self.description_in(schema, &mut budget)
    }

    fn description_in(&self, schema: Schema, budget: &mut u32) -> &'d str {
        if *budget == 0 {
            return "";
        }
        *budget -= 1;
        let doc = self.doc;
        let Schema::Object(object) = schema else {
            return "";
        };
        let object = doc.get(object);
        let has_ref = !object.reference.is_empty();
        if !(object.description.is_empty() || has_ref && self.v30) {
            return doc.str(object.description);
        }
        if has_ref {
            if let Ok((target, _)) = self.resolve(doc.str(object.reference)) {
                let description = self.description_in(target, budget);
                if !description.is_empty() || self.v30 {
                    return description;
                }
            } else {
                return "";
            }
        }
        if self.v30 {
            return "";
        }
        for &member in doc.list(object.all_of) {
            let description = self.description_in(member, budget);
            if !description.is_empty() {
                return description;
            }
        }
        ""
    }

    /// Returns the default of `schema`, as a field gives it: its own
    /// `default`, or else that of the schema its `$ref` points to,
    /// following `$ref`s, in `Doc::defaults`.
    ///
    /// From OpenAPI 3.1, a `default` next to a `$ref` is the schema's own;
    /// in 3.0 it is ignored, as every keyword next to a `$ref` is. Returns
    /// `None` if there is none, if a `$ref` does not point to a schema,
    /// which reading the schema's type reports, or if `$ref`s lead back to
    /// themselves.
    fn schema_default(&self, mut schema: Schema) -> Option<Id<Json>> {
        let doc = self.doc;
        for _ in 0..32 {
            let Schema::Object(object) = schema else {
                return None;
            };
            let object = doc.get(object);
            let has_ref = !object.reference.is_empty();
            if object.default.is_some() && !(has_ref && self.v30) {
                return object.default;
            }
            if !has_ref {
                return None;
            }
            schema = self.resolve(doc.str(object.reference)).ok()?.0;
        }
        // `$ref`s that lead back to themselves, with no default on the
        // way.
        None
    }

    /// Returns whether `schema` is read-only and sensitive, as a field
    /// gives them: whether it or any schema along its chain of `$ref`s has
    /// `readOnly: true`, and `x-sensitive: true`.
    ///
    /// A `readOnly` next to a `$ref` counts from OpenAPI 3.1, and is
    /// ignored in 3.0, as every keyword next to a `$ref` is. An
    /// `x-sensitive` next to a `$ref` counts in every version, since tools
    /// commonly honour extensions there. The chain stops at a `$ref` that
    /// does not point to a schema, which reading the schema's type
    /// reports, and after 32 `$ref`s, which lead back to themselves.
    fn schema_flags(&self, mut schema: Schema) -> SchemaFlags {
        let doc = self.doc;
        let mut flags = SchemaFlags::default();
        for _ in 0..32 {
            let Schema::Object(object) = schema else {
                break;
            };
            let object = doc.get(object);
            let has_ref = !object.reference.is_empty();
            flags.read_only |= object.read_only && !(has_ref && self.v30);
            flags.sensitive |= object.sensitive;
            if !has_ref || (flags.read_only && flags.sensitive) {
                break;
            }
            let Ok((target, _)) = self.resolve(doc.str(object.reference)) else {
                break;
            };
            schema = target;
        }
        flags
    }

    /// Returns `schema`, or the schema its `$ref` points to, following
    /// `$ref`s, or `None` if one does not point to a schema.
    fn deref(&self, mut schema: Schema) -> Option<Schema> {
        let doc = self.doc;
        for _ in 0..32 {
            let Schema::Object(object) = schema else {
                return Some(schema);
            };
            let reference = doc.get(object).reference;
            if reference.is_empty() {
                return Some(schema);
            }
            schema = self.resolve(doc.str(reference)).ok()?.0;
        }
        None
    }

    /// Returns the schema `reference` points to, and its schema name if it
    /// is a model: a schema in `components.schemas`, or in the `$defs` of
    /// one. Only `$ref`s into `components.schemas` are covered.
    fn resolve<'r>(&self, reference: &'r str) -> Result<(Schema, Option<Cow<'r, str>>), String> {
        let doc = self.doc;
        let mut segments = pointer(reference)?;
        let not_covered = || format!("$ref {reference:?} is not covered: only $refs into components.schemas are");
        let (Some(components), Some(schemas), Some(name)) = (segments.next(), segments.next(), segments.next()) else {
            return Err(not_covered());
        };
        if components != "components" || schemas != "schemas" {
            return Err(not_covered());
        }
        let points_to_nothing = || format!("$ref {reference:?} points to nothing");
        let Some(&(mut schema)) = self.index.schemas.get(name.as_ref()) else {
            return Err(points_to_nothing());
        };
        // The schema name, while every segment so far is in `$defs`.
        let mut schema_name = Some(name);
        let mut rest = segments.peekable();
        while let Some(key) = rest.next() {
            let Schema::Object(object) = schema else {
                return Err(points_to_nothing());
            };
            let object = doc.get(object);
            let next = rest.peek().map(|next| next.as_ref());
            // The child, and whether it is named by the next segment.
            let (child, named) = match (key.as_ref(), next) {
                ("properties", Some(next)) => (entry(doc, object.properties, next), true),
                ("$defs", Some(next)) => (entry(doc, object.defs, next), true),
                ("allOf", Some(next)) => (item(doc.list(object.all_of), next), true),
                ("anyOf", Some(next)) => (item(doc.list(object.any_of), next), true),
                ("oneOf", Some(next)) => (item(doc.list(object.one_of), next), true),
                ("items", _) => (object.items, false),
                ("additionalProperties", _) => (object.additional_properties, false),
                ("unevaluatedProperties", _) => (Some(object.unevaluated_properties), false),
                _ => (None, false),
            };
            let Some(child) = child else {
                return Err(points_to_nothing());
            };
            let next = if named { rest.next() } else { None };
            if let Some(path) = &mut schema_name {
                if key == "$defs"
                    && let Some(next) = &next
                {
                    let path = path.to_mut();
                    path.push_str("/$defs/");
                    path.push_str(next);
                } else {
                    schema_name = None;
                }
            }
            schema = child;
        }
        Ok((schema, schema_name))
    }

    /// Returns `ty`, or the union of it and null if `nullable`.
    fn nullable(&mut self, ty: TypeId, nullable: bool) -> TypeId {
        let data = &self.types[ty.index()];
        if !nullable || matches!(data, TypeData::Scalar(Scalar::Unknown | Scalar::Null)) {
            return ty;
        }
        let null = self.scalar(Scalar::Null);
        self.union_of(&[ty, null], None, true)
    }

    /// Returns the type of `scalar`, which every use shares.
    fn scalar(&mut self, scalar: Scalar) -> TypeId {
        for &(s, id) in &self.scalars {
            if s == scalar {
                return id;
            }
        }
        let id = self.push(TypeData::Scalar(scalar));
        self.scalars.push((scalar, id));
        id
    }

    fn push(&mut self, data: TypeData) -> TypeId {
        let id = TypeId(u32::try_from(self.types.len()).expect("fewer than 2^32 types"));
        self.types.push(data);
        id
    }
}

/// What [`Builder::schema_flags`] reads of a schema and its `$ref`s.
#[derive(Clone, Copy, Default)]
struct SchemaFlags {
    read_only: bool,
    sensitive: bool,
}

/// Returns the schema of `key` in `entries`, such as `properties`.
fn entry(doc: &Doc, entries: Span<(Str, Schema)>, key: &str) -> Option<Schema> {
    for &(k, schema) in doc.list(entries) {
        if doc.str(k) == key {
            return Some(schema);
        }
    }
    None
}

/// Returns the schema at `index` in `list`, such as `allOf`.
fn item(list: &[Schema], index: &str) -> Option<Schema> {
    list.get(index.parse::<usize>().ok()?).copied()
}

/// Returns the name an extension such as `x-fern-type-name` gives, or
/// `None` if there is none, or it has no letters or digits.
fn name_of(doc: &Doc, extension: Str) -> Option<Name> {
    if extension.is_empty() {
        return None;
    }
    let name = Name::new(doc.str(extension));
    if name.is_empty() { None } else { Some(name) }
}

/// Returns the segments of `reference`, a JSON pointer into this document
/// such as `#/components/schemas/Pet`, decoded, or an error.
fn pointer(reference: &str) -> Result<impl Iterator<Item = Cow<'_, str>>, String> {
    let Some(fragment) = reference.strip_prefix('#') else {
        return Err(format!(
            "$ref {reference:?} is to another document, which is not covered"
        ));
    };
    let Some(pointer) = fragment.strip_prefix('/') else {
        return Err(format!("$ref {reference:?} is not a JSON pointer"));
    };
    Ok(pointer.split('/').map(decode))
}

/// Decodes a segment of a JSON pointer in a URI fragment: `%XX` escapes,
/// then `~1` for `/` and `~0` for `~`.
fn decode(segment: &str) -> Cow<'_, str> {
    if !segment.contains(['%', '~']) {
        return Cow::Borrowed(segment);
    }
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 3 <= bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(out).unwrap_or_else(|_| segment.to_string());
    Cow::Owned(decoded.replace("~1", "/").replace("~0", "~"))
}

/// Returns the name of a model without `x-fern-type-name`: its schema
/// name without `$defs`.
fn model_name(schema_name: &str) -> Name {
    let mut words = String::with_capacity(schema_name.len());
    for segment in schema_name.split('/') {
        if segment == "$defs" {
            continue;
        }
        if !words.is_empty() {
            words.push(' ');
        }
        words.push_str(segment);
    }
    Name::new(&words)
}

/// Returns the one value an `enum` or `const` allows a property, if it is
/// a string.
fn only_value(doc: &Doc, property: Schema) -> Option<&str> {
    let Schema::Object(object) = property else {
        return None;
    };
    let object = doc.get(object);
    if let Some(Literal::String(value)) = object.constant {
        return Some(doc.str(value));
    }
    match doc.list(object.values) {
        [Literal::String(value)] => Some(doc.str(*value)),
        _ => None,
    }
}

/// Reports whether `schema`, leaving out its `$ref`, gives a shape rather
/// than only constraining or describing a value.
fn has_shape(schema: &SchemaObject) -> bool {
    !schema.properties.is_empty()
        || schema.additional_properties.is_some()
        || schema.items.is_some()
        || schema.prefix_items
        || !schema.values.is_empty()
        || schema.constant.is_some()
        || is_composed(schema)
}

/// Reports whether `schema` has members in `allOf`, `anyOf` or `oneOf`.
fn is_composed(schema: &SchemaObject) -> bool {
    !schema.all_of.is_empty() || !schema.any_of.is_empty() || !schema.one_of.is_empty()
}

/// Reports whether `schema`, leaving out its `$ref`, gives no shape: no
/// shape keyword, and no type or only `object`.
fn is_shapeless(doc: &Doc, schema: &SchemaObject) -> bool {
    !has_shape(schema) && matches!(doc.list(schema.types), [] | [SchemaType::Object])
}

/// Reports whether an `allOf` member gives no shape, such as `{}`,
/// `true`, `{type: object}` or one with only a `description`.
fn is_shapeless_member(doc: &Doc, member: Schema) -> bool {
    match member {
        Schema::Bool(_) => true,
        Schema::Object(object) => {
            let object = doc.get(object);
            object.reference.is_empty() && is_shapeless(doc, object)
        }
    }
}

/// Reports whether an `allOf` member only lists `required` properties.
fn is_required_only(doc: &Doc, member: Schema) -> bool {
    match member {
        Schema::Bool(_) => false,
        Schema::Object(object) => !doc.get(object).required.is_empty() && is_shapeless_member(doc, member),
    }
}

/// Reports whether a union member only constrains the value, with
/// `required` or `not`, rather than giving it a shape.
fn is_constraint_only(doc: &Doc, member: Schema) -> bool {
    let Schema::Object(object) = member else {
        return false;
    };
    let object = doc.get(object);
    object.reference.is_empty() && !has_shape(object) && (!object.required.is_empty() || object.not)
}
