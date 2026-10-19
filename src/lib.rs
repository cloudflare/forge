//! Forge builds a language-neutral SDK tree from an OpenAPI document.

use std::{iter, ptr};

mod arena;
mod json;
mod link;
mod method;
mod name;
mod plugin;
mod types;
pub use json::Json;
pub use method::{Body, Content, Location, Response};
pub use name::Name;
#[cfg(feature = "wasm")]
pub use plugin::wasm;
pub use plugin::{Err, File, Plugin, run, ts, write};
pub use types::{Array, Discriminator, Enum, EnumValue, Field, Intersection, Number, Object, Scalar, Type, Union};

use arena::{List, Span, Str, Strings};
use method::{BodyData, ResponseData};
use types::{EnumData, FieldData, TypeData, TypeId};

/// A high-level representation of an OpenAPI document, for generating an
/// SDK tree.
#[derive(Default)]
pub struct Forge {
    /// The version of the document.
    ///
    /// Corresponds to `info.version` in the
    /// [Info Object](https://spec.openapis.org/oas/latest.html#fixed-fields-0).
    pub version: String,
    /// A description of the API.
    ///
    /// Corresponds to `info.title`, `info.summary` and `info.description` in
    /// the [Info Object](https://spec.openapis.org/oas/latest.html#fixed-fields-0),
    /// joined as paragraphs with a blank line between them.
    pub description: String,
    /// The base URL for the API.
    ///
    /// Corresponds to the `url` of the first entry in `servers` in the
    /// [OpenAPI Object](https://spec.openapis.org/oas/latest.html#fixed-fields),
    /// with its server variables substituted.
    pub base_url: String, // Eventually we will support servers at descendants as well.

    /// Every group, indexed by `GroupId`.
    groups: Vec<GroupData>,
    /// The top-level groups.
    top: Vec<GroupId>,
    /// Every method, indexed by `MethodId`.
    methods: Vec<MethodData>,
    /// Every model, indexed by `ModelId`.
    models: Vec<ModelData>,
    /// The models at the top level, in no group.
    top_models: Vec<ModelId>,
    /// Every type, indexed by `TypeId`.
    types: Vec<TypeData>,

    // The arenas the data above keeps its strings and lists in.
    strings: Strings,
    /// Every name of a field, once each, indexed by `NameId`.
    names: Vec<Name>,
    /// The fields of objects.
    fields: List<FieldData>,
    /// The members of unions and intersections.
    members: List<TypeId>,
    /// The values of enums.
    values: List<EnumData>,
    /// The extensions of every operation in the document, including those
    /// that are not methods, by name.
    extensions: List<(String, Json)>,
    /// The `default` of every schema in the document that has one, used
    /// by a field or not, indexed by the `Id` a field keeps.
    defaults: Vec<Json>,
}

impl Forge {
    /// Returns every group, depth first: each group comes before its
    /// subgroups, and all of them before its next sibling. Siblings are
    /// sorted by name.
    pub fn groups(&self) -> impl Iterator<Item = Group<'_>> {
        self.depth_first(&self.top)
    }

    /// Returns the models at the top level, which are in no group, in an
    /// unspecified order. These are the models used by methods in more than
    /// one top-level group.
    pub fn models(&self) -> impl ExactSizeIterator<Item = Model<'_>> {
        self.top_models.iter().map(|&id| self.model(id))
    }

    fn group(&self, id: GroupId) -> Group<'_> {
        Group { forge: self, id }
    }

    fn method(&self, id: MethodId) -> Method<'_> {
        Method { forge: self, id }
    }

    fn model(&self, id: ModelId) -> Model<'_> {
        Model { forge: self, id }
    }

    /// Returns the groups `ids` and every group inside them, depth first,
    /// keeping the order of `ids` and of each group's subgroups.
    fn depth_first<'f>(&'f self, ids: &'f [GroupId]) -> impl Iterator<Item = Group<'f>> {
        // The groups still to visit, the next one last, so each list is
        // pushed in reverse.
        let mut stack: Vec<GroupId> = ids.iter().rev().copied().collect();
        iter::from_fn(move || {
            let group = self.group(stack.pop()?);
            stack.extend(group.data().groups.iter().rev());
            Some(group)
        })
    }
}

/// A named collection of subgroups, methods and models in a [`Forge`].
///
/// A `Group` is a reference into the `Forge` it came from: it is cheap to
/// copy, and cannot outlive the `Forge`. Two `Group`s are equal when they
/// are the same group of the same `Forge`.
#[derive(Clone, Copy)]
pub struct Group<'f> {
    forge: &'f Forge,
    id: GroupId,
}

impl<'f> Group<'f> {
    /// Returns the name of the group.
    pub fn name(self) -> &'f Name {
        &self.data().name
    }

    /// Returns a short description of the group, or an empty string if it
    /// has none.
    ///
    /// Comes from the `x-forge-commands` extension at the root of the
    /// document, which has an entry for each group, keyed by name. A
    /// top-level group's description is the `description` of its entry. A
    /// subgroup's entry sits in the `groups` of its parent's entry, or
    /// anywhere above it under a key with dots: `a.b` in the root, or `b.c`
    /// in the `groups` of `a`, both describe the group `c` in `b` in `a`.
    /// Names match when they are equal as [`Name`]s. Two entries for the
    /// same group are an error.
    pub fn description(self) -> &'f str {
        &self.data().description
    }

    /// Returns the names of the groups from the top level down to this one,
    /// ending with this group's own name.
    pub fn path(self) -> impl ExactSizeIterator<Item = &'f Name> + DoubleEndedIterator {
        self.data()
            .path
            .iter()
            .map(move |&id| &self.forge.groups[id.index()].name)
    }

    /// Returns the group this one is inside, or `None` for a top-level
    /// group.
    pub fn parent(self) -> Option<Group<'f>> {
        // The path ends with this group, so its parent comes just before.
        let [.., parent, _] = self.data().path[..] else {
            return None;
        };
        Some(self.forge.group(parent))
    }

    /// Returns the groups directly inside this one, sorted by name.
    pub fn children(self) -> impl ExactSizeIterator<Item = Group<'f>> {
        self.data().groups.iter().map(move |&id| self.forge.group(id))
    }

    /// Returns every group below this one, depth first, walked the same way
    /// as [`Forge::groups`]. This group is not included.
    pub fn descendants(self) -> impl Iterator<Item = Group<'f>> {
        self.forge.depth_first(&self.data().groups)
    }

    /// Returns the methods directly in this group, sorted by name.
    pub fn methods(self) -> impl ExactSizeIterator<Item = Method<'f>> {
        self.data().methods.iter().map(move |&id| self.forge.method(id))
    }

    /// Returns the models placed directly in this group, in an unspecified
    /// order. See [`Model::group`] for where a model is placed.
    pub fn models(self) -> impl ExactSizeIterator<Item = Model<'f>> {
        self.data().models.iter().map(move |&id| self.forge.model(id))
    }

    fn data(self) -> &'f GroupData {
        &self.forge.groups[self.id.index()]
    }
}

impl PartialEq for Group<'_> {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self.forge, other.forge) && self.id == other.id
    }
}

impl Eq for Group<'_> {}

impl std::hash::Hash for Group<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(self.forge, state);
        self.id.hash(state);
    }
}

impl std::fmt::Debug for Group<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Group")
            .field("path", &self.path().collect::<Vec<_>>())
            .finish()
    }
}

/// A named operation in a [`Forge`]: one OpenAPI operation that an SDK
/// exposes as a function.
///
/// An operation can instead be exposed as several methods, each under its
/// own group and name, with the `x-forge-aliases` extension: an array of
/// objects, each an alias that is a method of the operation. The
/// operation's own group and name then make no method, and its own
/// `x-fern-ignore` does not stop its aliases. An empty array makes no
/// method, an element that is not an object is ignored, and a value that
/// is not an array is an error. Aliases do not nest: an `x-forge-aliases`
/// in an alias is ignored, as are its keys that are not extensions.
///
/// An alias says, as an operation would, the method's
/// [`group`](Method::group), [`name`](Method::name),
/// [`availability`](Method::availability), whether it is
/// [hidden](Method::is_hidden), its [`confirmation`](Method::confirmation)
/// and its [`extensions`](Method::extensions), and whether it is ignored
/// with `x-fern-ignore`. None of these come from the operation: an alias
/// without an extension does not have the operation's. The rest, from the
/// HTTP method and path to the responses, is the operation's, and every
/// alias has it. Each alias is a method of its own group, so a model one
/// uses is placed as though each alias were a separate operation.
///
/// Like a [`Group`], a `Method` is a cheap reference into its `Forge`. Two
/// `Method`s are equal when they are the same method of the same `Forge`.
#[derive(Clone, Copy)]
pub struct Method<'f> {
    forge: &'f Forge,
    id: MethodId,
}

impl<'f> Method<'f> {
    /// Returns the name of the method, which is unique within its group.
    ///
    /// Corresponds to the `x-fern-sdk-method-name` extension of the
    /// operation, or of the alias the method comes from. An operation or
    /// alias without one, or with an empty one, is not a method, and one
    /// with no letters or digits is an error. Two methods in a group with
    /// equal names are an error, whether they are aliases or not.
    pub fn name(self) -> &'f Name {
        &self.data().name
    }

    /// Returns the group the method is in.
    ///
    /// Corresponds to the `x-fern-sdk-group-name` extension of the
    /// operation, or of the alias the method comes from: a string of group
    /// names separated by dots, such as `accounts.members`, or an array
    /// with one group name per element, top level first. An operation or
    /// alias without one, with an empty one, or with `x-fern-ignore: true`
    /// is not a method. A group name with no letters or digits is an error.
    pub fn group(self) -> Group<'f> {
        self.forge.group(self.data().group)
    }

    /// Returns the HTTP method the operation is sent with.
    pub fn http_method(self) -> &'f HttpMethod {
        &self.data().http_method
    }

    /// Returns the path template the operation is declared under, such as
    /// `/accounts/{account_id}`.
    pub fn path(self) -> &'f str {
        self.forge.strings.get(self.data().path)
    }

    /// Returns a short summary of what the method does, or an empty string
    /// if it has none.
    ///
    /// Corresponds to `summary` in the
    /// [Operation Object](https://spec.openapis.org/oas/latest.html#operation-object).
    pub fn summary(self) -> &'f str {
        self.forge.strings.get(self.data().summary)
    }

    /// Returns a description of the method, or an empty string if it has
    /// none.
    ///
    /// Corresponds to `description` in the
    /// [Operation Object](https://spec.openapis.org/oas/latest.html#operation-object).
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data().description)
    }

    /// Reports whether the method is deprecated.
    ///
    /// Corresponds to `deprecated` in the
    /// [Operation Object](https://spec.openapis.org/oas/latest.html#operation-object).
    /// It is apart from [`availability`](Method::availability): a method
    /// can be deprecated without being [`Availability::Deprecated`], and
    /// the other way around.
    pub fn is_deprecated(self) -> bool {
        self.data().deprecated
    }

    /// Returns the stage of the API the method is in, such as
    /// [`Availability::Beta`], or `None` if the operation does not say.
    ///
    /// Corresponds to the `x-fern-availability` extension of the
    /// operation, a string that is one of `alpha`, `beta`, `preview`,
    /// `generally-available` and `deprecated`, as [`Availability`] lists.
    /// Any other value, including one that differs only in case, is an
    /// error naming the operation's method and path, as is a value that is
    /// not a string.
    ///
    /// It is apart from [`is_deprecated`](Method::is_deprecated), which
    /// comes from OpenAPI's own `deprecated`: an operation with
    /// `x-fern-availability: deprecated` and without `deprecated: true` is
    /// [`Availability::Deprecated`] but not deprecated, and one with
    /// `deprecated: true` has whatever availability it says, or none.
    pub fn availability(self) -> Option<Availability> {
        self.data().availability
    }

    /// Reports whether the method should be left out of listings of
    /// methods, such as a CLI's help, although it can still be called.
    ///
    /// Corresponds to the `x-forge-hidden` extension of the operation, a
    /// boolean, which is false without it. A value that is not a boolean
    /// is an error, as for `x-fern-ignore`. Unlike `x-fern-ignore`, a
    /// hidden operation is still a method.
    pub fn is_hidden(self) -> bool {
        self.data().hidden
    }

    /// Returns a sentence to show before calling the method, which changes
    /// or deletes something irreversibly, such as "This operation deletes
    /// the database.", or `None` if the method needs no confirmation.
    ///
    /// Corresponds to the `x-forge-require-confirmation` extension of the
    /// operation, a string, as written. An empty string is `Some("")`: the
    /// method needs confirmation, with no sentence of its own to show. A
    /// value that is not a string is an error.
    pub fn confirmation(self) -> Option<&'f str> {
        Some(self.forge.strings.get(self.data().confirmation?))
    }

    /// Returns the type of what a caller passes to call the method, or
    /// `None` if the method has no parameters and no body.
    ///
    /// The parameters are an object with a field for each path and query
    /// parameter, and [`location`](Method::location) says where each field
    /// is sent. The request is:
    ///
    /// - the body alone, of whatever type, when there are no parameters;
    /// - the intersection of the parameters and the body, when the body is
    ///   an object with fields, or a model, union or intersection of them;
    /// - the parameters and a `body` field holding the body, when the body
    ///   is anything else, or has a field with the name of a parameter;
    /// - the parameters alone, when there is no body.
    ///
    /// A body that is an intersection is one member of the request's
    /// intersection. The `body` field is required when the body is. The body
    /// is the type of its [JSON content](Body::json), or [`Scalar::Unknown`]
    /// when it has no JSON media type, although [`Content::ty`] types its
    /// other media types too.
    ///
    /// The order is path, query, then body. The parameters' fields are the
    /// path parameters in the order of the path template, then the query
    /// parameters in the order they are declared, the path item's first.
    /// The parameters are the first member of the intersection, and the
    /// `body` field is their last field.
    ///
    /// The body keeps its read-only fields, since a model is the same
    /// object in requests and responses: a generator leaves out of what a
    /// client sends the fields that [`Field::is_read_only`] reports. A
    /// parameter's field is never read-only.
    ///
    /// A parameter's field is named after the `x-fern-parameter-name`
    /// extension of the parameter, or else its wire name. Its description
    /// is the parameter's, or else its schema's, following `$ref`s, as
    /// [`Field::description`] says; from OpenAPI 3.1, the `description` of
    /// a Reference Object to the parameter overrides the parameter's. A
    /// parameter of the operation replaces one of the path item with the
    /// same name and location. A path template placeholder that neither
    /// declares is a string, and a path parameter that is not in the
    /// template is left out. Two parameters with equal names are an error.
    ///
    /// Header parameters are not part of the request: see
    /// [`headers`](Method::headers). Cookie parameters are ignored. In
    /// OpenAPI 3.2, the
    /// properties of the object of an `in: querystring` parameter are query
    /// parameters; there can be one such parameter, and not together with
    /// `in: query` ones. A parameter with `content` instead of `schema` is
    /// not covered yet, and is an error. [`Location`] says which styles are
    /// covered.
    pub fn request(self) -> Option<Type<'f>> {
        Some(Type::new(self.forge, self.data().request?))
    }

    /// Returns where `field` is sent, or `None` if it is not a parameter
    /// of the method.
    ///
    /// Every field of the parameters in [`request`](Method::request) has a
    /// location. The request's other fields, including a `body` field, are
    /// sent in the body. A field from anywhere else, such as another
    /// method's request, also gives `None`.
    pub fn location(self, field: Field<'f>) -> Option<Location> {
        let data = self.data();
        let TypeData::Object(params) = &self.forge.types[data.params?.index()] else {
            return None;
        };
        let fields = self.forge.fields.get(params.fields);
        let i = fields.iter().position(|f| ptr::eq(f, field.data))?;
        // The `body` field, which is last, has no location.
        data.locations.get(i).copied()
    }

    /// Returns the header parameters of the method, as an object with a
    /// field for each, or `None` if it has none.
    ///
    /// The headers are an [`Object`] rather than a [`Type`], since they are
    /// always one, and are apart from [`request`](Method::request): their
    /// fields are in neither the request nor [`location`](Method::location).
    /// Each field is sent as the header named by its wire name, which is
    /// the parameter's name as written. Its name, description, type, and
    /// whether it is required, come from the parameter as for a query
    /// parameter in the request, and it is deprecated when the parameter
    /// is.
    ///
    /// The fields are in the order the parameters are declared, the path
    /// item's first. A parameter of the operation replaces one of the path
    /// item, taking its place, when their names are the same ignoring
    /// ASCII case, since HTTP header names are case-insensitive: so
    /// `x-request-id` replaces `X-Request-ID`, and its field has the wire
    /// name `x-request-id`. Two header fields with equal names are an
    /// error, as `X-A` and `x-a` declared by the same path item are.
    ///
    /// Forge keeps header parameters named `Accept`, `Content-Type` and
    /// `Authorization` like any other, although OpenAPI says to ignore
    /// them, since APIs declare them for a caller to set, such as the
    /// content type of a raw upload. A generator that sets these headers
    /// itself can leave them out.
    ///
    /// Only the default style, `simple`, is covered: other styles are
    /// errors, and `explode`, which changes only how an object is written,
    /// is ignored. A parameter with `content` instead of `schema` is not
    /// covered yet, and is an error, as in the request.
    pub fn headers(self) -> Option<Object<'f>> {
        let TypeData::Object(data) = &self.forge.types[self.data().headers?.index()] else {
            return None;
        };
        Some(Object::new(self.forge, data))
    }

    /// Returns the request body, or `None` if the method has none.
    pub fn body(self) -> Option<Body<'f>> {
        Some(Body::new(self.forge, self.data().body.as_ref()?))
    }

    /// Returns the success responses, those with a `2XX` status, sorted by
    /// status.
    pub fn responses(self) -> impl ExactSizeIterator<Item = Response<'f>> {
        let forge = self.forge;
        self.data().responses.iter().map(move |data| Response::new(forge, data))
    }

    /// Returns every other response the method declares, sorted by status
    /// with `default` last.
    pub fn errors(self) -> impl ExactSizeIterator<Item = Response<'f>> {
        let forge = self.forge;
        self.data().errors.iter().map(move |data| Response::new(forge, data))
    }

    /// Returns the value of the extension `name` of the method's operation,
    /// or alias, such as `x-forge-params`, or `None` if it has none. Only
    /// extensions forge does not read itself are kept, as
    /// [`extensions`](Method::extensions) says.
    pub fn extension(self, name: &str) -> Option<&'f Json> {
        self.extensions().find(|&(n, _)| n == name).map(|(_, value)| value)
    }

    /// Returns every extension of the method's operation that forge does
    /// not read itself, in the order they are written, for plugins to read
    /// as they need.
    ///
    /// An extension is a key of the
    /// [Operation Object](https://spec.openapis.org/oas/latest.html#operation-object)
    /// that starts with `x-`. Those forge reads, `x-fern-sdk-method-name`,
    /// `x-fern-sdk-group-name`, `x-fern-ignore`, `x-fern-availability`,
    /// `x-forge-hidden`, `x-forge-require-confirmation` and
    /// `x-forge-aliases`, are left out, and other keys forge does not read
    /// are not kept. An extension written more than once is there once,
    /// with the last value written, in the place of the first, as with
    /// `JSON.parse`. Extensions of the path item, the parameters, the body,
    /// the responses and the schemas are not kept.
    ///
    /// For a method that comes from an alias, these are the extensions of
    /// the alias, left out the same way, and none of the operation's.
    pub fn extensions(self) -> impl ExactSizeIterator<Item = (&'f str, &'f Json)> {
        let extensions = self.forge.extensions.get(self.data().extensions);
        extensions.iter().map(|(name, value)| (name.as_str(), value))
    }

    fn data(self) -> &'f MethodData {
        &self.forge.methods[self.id.index()]
    }
}

impl PartialEq for Method<'_> {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self.forge, other.forge) && self.id == other.id
    }
}

impl Eq for Method<'_> {}

impl std::hash::Hash for Method<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(self.forge, state);
        self.id.hash(state);
    }
}

impl std::fmt::Debug for Method<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Method")
            .field("group", &self.group().path().collect::<Vec<_>>())
            .field("name", self.name())
            .field("http_method", self.http_method())
            .field("path", &self.path())
            .finish()
    }
}

/// The HTTP method of a [`Method`].
///
/// Each variant but `Other` is the method of one of the fixed fields of a
/// [Path Item Object](https://spec.openapis.org/oas/latest.html#path-item-object),
/// so `get` is [`Get`](HttpMethod::Get). A key in `additionalOperations` that is
/// exactly the method of a fixed field, such as `GET`, is that variant too,
/// so each method has one value. Such a key is ignored when the path item
/// also has the fixed field.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HttpMethod {
    Get,
    Put,
    Post,
    Delete,
    Options,
    Head,
    Patch,
    Trace,
    Query,
    Connect,
    /// Any other method, from a key in `additionalOperations`, as written,
    /// such as `COPY`. Methods are case-sensitive, so `get` is `Other` too.
    Other(String),
}

impl HttpMethod {
    /// Returns the method as it is sent in a request, such as `GET`.
    pub fn as_str(&self) -> &str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Put => "PUT",
            HttpMethod::Post => "POST",
            HttpMethod::Delete => "DELETE",
            HttpMethod::Options => "OPTIONS",
            HttpMethod::Head => "HEAD",
            HttpMethod::Patch => "PATCH",
            HttpMethod::Trace => "TRACE",
            HttpMethod::Query => "QUERY",
            HttpMethod::Connect => "CONNECT",
            HttpMethod::Other(method) => method,
        }
    }
}

/// The stage of the API a [`Method`] is in, as
/// [`Method::availability`] gives it.
///
/// Corresponds to the value of the `x-fern-availability` extension of an
/// operation, which each variant names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Availability {
    /// `alpha`.
    Alpha,
    /// `beta`.
    Beta,
    /// `preview`.
    Preview,
    /// `generally-available`.
    GenerallyAvailable,
    /// `deprecated`, which is apart from OpenAPI's `deprecated`, as
    /// [`Method::is_deprecated`] says.
    Deprecated,
}

impl Availability {
    /// Returns the availability as `x-fern-availability` writes it, such
    /// as `generally-available`.
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Alpha => "alpha",
            Availability::Beta => "beta",
            Availability::Preview => "preview",
            Availability::GenerallyAvailable => "generally-available",
            Availability::Deprecated => "deprecated",
        }
    }
}

/// A named schema from `components.schemas` in a [`Forge`], or from the
/// `$defs` of one, which an SDK declares as a type.
///
/// Only schemas that a method uses, directly or through other schemas, are
/// models. A use in the content of the body or of a response counts
/// whatever its media type, JSON or not, and so does a use in a header
/// parameter, one of [`Method::headers`]. Response headers are not read,
/// so a use in one does not count.
///
/// Like a [`Group`], a `Model` is a cheap reference into its `Forge`. Two
/// `Model`s are equal when they are the same model of the same `Forge`.
#[derive(Clone, Copy)]
pub struct Model<'f> {
    forge: &'f Forge,
    id: ModelId,
}

impl<'f> Model<'f> {
    /// Returns where the schema is under `components.schemas`: its key,
    /// such as `Account`, or for a schema in the `$defs` of another, a path
    /// such as `Tree/$defs/Node`.
    pub fn schema_name(self) -> &'f str {
        self.forge.strings.get(self.data().schema_name)
    }

    /// Returns the name of the model.
    ///
    /// Corresponds to the `x-fern-type-name` extension of the schema. A
    /// schema without one is named after its schema name, leaving out
    /// `$defs`, so `Tree/$defs/Node` has the name `Tree Node`.
    pub fn name(self) -> &'f Name {
        &self.data().name
    }

    /// Returns the group the model is placed in, or `None` if it is at the
    /// top level.
    ///
    /// A model is placed in the deepest group shared by every method that
    /// uses it, directly or through other models: a model used in `a.b.c`
    /// and `a.b.d` is in `a.b`, one used only in `a.b.e` is in `a.b.e`, and
    /// one used in `a` and `x` is at the top level.
    pub fn group(self) -> Option<Group<'f>> {
        Some(self.forge.group(self.data().group?))
    }

    /// Returns a description of the model, or an empty string if it has
    /// none.
    ///
    /// Corresponds to `description` in the
    /// [Schema Object](https://spec.openapis.org/oas/latest.html#schema-object),
    /// or `title` if it has no description.
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data().description)
    }

    /// Reports whether the model is deprecated.
    ///
    /// Corresponds to `deprecated` in the
    /// [Schema Object](https://spec.openapis.org/oas/latest.html#schema-object).
    pub fn is_deprecated(self) -> bool {
        self.data().deprecated
    }

    /// Returns the type of the model's schema.
    pub fn ty(self) -> Type<'f> {
        Type::new(self.forge, self.data().ty)
    }

    fn data(self) -> &'f ModelData {
        &self.forge.models[self.id.index()]
    }
}

impl PartialEq for Model<'_> {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self.forge, other.forge) && self.id == other.id
    }
}

impl Eq for Model<'_> {}

impl std::hash::Hash for Model<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(self.forge, state);
        self.id.hash(state);
    }
}

/// Writes the [schema name](Model::schema_name), such as `Account` or
/// `Tree/$defs/Node`.
impl std::fmt::Display for Model<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.schema_name())
    }
}

impl std::fmt::Debug for Model<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Model")
            .field("group", &self.group().map(|group| group.path().collect::<Vec<_>>()))
            .field("schema_name", &self.schema_name())
            .finish()
    }
}

/// The index of a group's data in its `Forge`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct GroupId(u32);

impl GroupId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

/// What a [`Forge`] stores for each group.
struct GroupData {
    name: Name,
    description: String,
    /// The groups directly inside this one.
    groups: Vec<GroupId>,
    /// The groups from the top level down to this one, ending with this
    /// group itself.
    path: Vec<GroupId>,
    /// The methods directly in this group.
    methods: Vec<MethodId>,
    /// The models placed directly in this group.
    models: Vec<ModelId>,
}

/// The index of a method's data in its `Forge`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct MethodId(u32);

impl MethodId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

/// What a [`Forge`] stores for each method.
struct MethodData {
    name: Name,
    /// The group the method is in.
    group: GroupId,
    http_method: HttpMethod,
    /// The path template, such as `/accounts/{account_id}`.
    path: Str,
    summary: Str,
    description: Str,
    deprecated: bool,
    availability: Option<Availability>,
    hidden: bool,
    /// The sentence to confirm with, or `None` for none.
    confirmation: Option<Str>,
    /// The type of the request.
    request: Option<TypeId>,
    /// The object of parameters in `request`.
    params: Option<TypeId>,
    /// Where each field of `params` is sent, in the same order, except a
    /// `body` field, which is last and has none.
    locations: Vec<Location>,
    /// The object of header parameters, if there are any.
    headers: Option<TypeId>,
    body: Option<BodyData>,
    responses: Vec<ResponseData>,
    errors: Vec<ResponseData>,
    /// The extensions of the operation that are not read, in
    /// `Forge::extensions`.
    extensions: Span<(String, Json)>,
}

/// The index of a model's data in its `Forge`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ModelId(u32);

impl ModelId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

/// What a [`Forge`] stores for each model.
struct ModelData {
    /// Where the schema is under `components.schemas`.
    schema_name: Str,
    name: Name,
    /// The group the model is placed in, or none for the top level.
    group: Option<GroupId>,
    description: Str,
    deprecated: bool,
    ty: TypeId,
}
