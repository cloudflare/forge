//! The objects of an OpenAPI document that a `Forge` is built from, as
//! the [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
//! names them, with only the fields a `Forge` reads. Every other field is
//! skipped as it is read.
//!
//! The objects are not nested in each other. A [`Doc`] keeps each kind of
//! object in an arena, and an object refers to those inside it by [`Id`].
//! Its lists are [`Span`]s of one [`List`] for each kind of item, and its
//! strings are [`Str`]s of one buffer. So reading a document allocates
//! only as the arenas grow, rather than for every object, list and string
//! in it. Extensions that name something are kept as they are written,
//! and read as [`Name`]s when they are used.
//!
//! The extensions of an Operation Object, and of each alias in its
//! `x-forge-aliases`, that are not read are kept too, as [`Json`], for
//! plugins to read. They are the one part of a document kept without being
//! read.

use std::collections::HashMap;
use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::read::{first, keys};
use crate::Name;
use crate::arena::{Id, List, Span, Str, Strings};
use crate::json::{self, Json};

/// An OpenAPI document: the fields of the OpenAPI Object at its root, and
/// the arenas of the objects in it.
#[derive(Default)]
pub(super) struct Doc {
    /// The version of the OpenAPI Specification the document uses, such
    /// as `3.1.0`, or empty for none, as in a Swagger 2.0 document.
    pub(super) openapi: String,
    pub(super) info: Info,
    /// The first server, or one with an empty URL for none. The others are
    /// not read.
    pub(super) servers: Server,
    /// Each path item by path, in the order they are written, leaving out
    /// extensions.
    pub(super) paths: Span<(Str, Id<PathItem>)>,
    pub(super) components: Components,
    pub(super) commands: Commands,
    /// The extensions of every operation, by name. They own their names,
    /// rather than keeping them in `strings`, so that a `Forge` can take
    /// them whole.
    pub(super) extensions: List<(String, Json)>,
    /// The `default` of every schema that has one, which a schema refers
    /// to by [`Id`], so that a schema without one costs only the `None`.
    /// A `Forge` takes them whole, as it does `extensions`.
    pub(super) defaults: Vec<Json>,

    strings: Strings,
    path_items: Vec<PathItem>,
    operations: Vec<Operation>,
    parameters: Vec<Parameter>,
    request_bodies: Vec<RequestBody>,
    responses: Vec<Response>,
    schemas: Vec<SchemaObject>,
    discriminators: Vec<Discriminator>,

    path_item_entries: List<(Str, Id<PathItem>)>,
    operation_entries: List<(Str, Id<Operation>)>,
    parameter_lists: List<Id<Parameter>>,
    parameter_entries: List<(Str, Id<Parameter>)>,
    request_body_entries: List<(Str, Id<RequestBody>)>,
    response_entries: List<(Str, Id<Response>)>,
    schema_lists: List<Schema>,
    /// Properties, `$defs`, `content` and `components.schemas`.
    schema_entries: List<(Str, Schema)>,
    types: List<SchemaType>,
    literals: List<Literal>,
    str_lists: List<Str>,
    str_entries: List<(Str, Str)>,
    /// The aliases in `x-forge-aliases`.
    aliases: List<Definition>,
}

impl Doc {
    /// Reads a document.
    pub(super) fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Doc, D::Error> {
        let mut doc = Doc::default();
        deserializer.deserialize_map(DocumentVisitor(&mut doc))?;
        Ok(doc)
    }

    pub(super) fn str(&self, s: Str) -> &str {
        self.strings.get(s)
    }

    pub(super) fn get<T: Node>(&self, id: Id<T>) -> &T {
        &T::arena(self)[id.index()]
    }

    pub(super) fn list<T: Item>(&self, span: Span<T>) -> &[T] {
        T::list(self).get(span)
    }

    fn add<T: Node>(&mut self, node: T) -> Id<T> {
        let arena = T::arena_mut(self);
        arena.push(node);
        Id::new(arena.len() - 1)
    }
}

/// An object kept in an arena of a [`Doc`].
pub(super) trait Node: Sized {
    fn arena(doc: &Doc) -> &Vec<Self>;
    fn arena_mut(doc: &mut Doc) -> &mut Vec<Self>;
}

/// An item of the lists in a [`Doc`].
pub(super) trait Item: Sized {
    fn list(doc: &Doc) -> &List<Self>;
    fn list_mut(doc: &mut Doc) -> &mut List<Self>;
}

macro_rules! arenas {
    ($trait:ident, $get:ident, $get_mut:ident, $holder:ident { $($ty:ty => $field:ident,)* }) => {
        $(impl $trait for $ty {
            fn $get(doc: &Doc) -> &$holder<Self> {
                &doc.$field
            }

            fn $get_mut(doc: &mut Doc) -> &mut $holder<Self> {
                &mut doc.$field
            }
        })*
    };
}

arenas!(Node, arena, arena_mut, Vec {
    PathItem => path_items,
    Operation => operations,
    Parameter => parameters,
    RequestBody => request_bodies,
    Response => responses,
    SchemaObject => schemas,
    Discriminator => discriminators,
    Json => defaults,
});

arenas!(Item, list, list_mut, List {
    (Str, Id<PathItem>) => path_item_entries,
    (Str, Id<Operation>) => operation_entries,
    Id<Parameter> => parameter_lists,
    (Str, Id<Parameter>) => parameter_entries,
    (Str, Id<RequestBody>) => request_body_entries,
    (Str, Id<Response>) => response_entries,
    Schema => schema_lists,
    (Str, Schema) => schema_entries,
    SchemaType => types,
    Literal => literals,
    Str => str_lists,
    (Str, Str) => str_entries,
    Definition => aliases,
});

/// The Info Object.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct Info {
    pub(super) title: String,
    pub(super) summary: String,
    pub(super) description: String,
    pub(super) version: String,
}

/// The Server Object.
#[derive(Deserialize, Default)]
pub(super) struct Server {
    pub(super) url: String,
    #[serde(default)]
    pub(super) variables: HashMap<String, ServerVariable>,
}

/// The Server Variable Object.
#[derive(Deserialize)]
pub(super) struct ServerVariable {
    pub(super) default: String,
}

/// The Components Object: what the rest of the document can refer to with
/// a `$ref`, by name, in the order they are written.
#[derive(Clone, Copy, Default)]
pub(super) struct Components {
    pub(super) schemas: Span<(Str, Schema)>,
    pub(super) parameters: Span<(Str, Id<Parameter>)>,
    pub(super) request_bodies: Span<(Str, Id<RequestBody>)>,
    pub(super) responses: Span<(Str, Id<Response>)>,
    pub(super) path_items: Span<(Str, Id<PathItem>)>,
}

/// A Path Item Object, or a `$ref` to one.
#[derive(Default)]
pub(super) struct PathItem {
    /// The `$ref`, or empty for none. An empty `$ref` is an error.
    pub(super) reference: Str,
    /// The parameters of every operation, which an operation's own
    /// parameter replaces.
    pub(super) parameters: Span<Id<Parameter>>,
    pub(super) get: Option<Id<Operation>>,
    pub(super) put: Option<Id<Operation>>,
    pub(super) post: Option<Id<Operation>>,
    pub(super) delete: Option<Id<Operation>>,
    pub(super) options: Option<Id<Operation>>,
    pub(super) head: Option<Id<Operation>>,
    pub(super) patch: Option<Id<Operation>>,
    pub(super) trace: Option<Id<Operation>>,
    pub(super) query: Option<Id<Operation>>,
    pub(super) connect: Option<Id<Operation>>,
    /// The operations of other methods, by method, in the order they are
    /// written.
    pub(super) additional_operations: Span<(Str, Id<Operation>)>,
}

/// An Operation Object.
#[derive(Default)]
pub(super) struct Operation {
    /// The extensions that make the operation a method.
    pub(super) definition: Definition,
    /// The `x-forge-aliases`: a definition for each element, in the order
    /// they are written, or `None` without it. An element that is not an
    /// object is an empty definition, which makes no method.
    pub(super) aliases: Option<Span<Definition>>,
    pub(super) summary: Str,
    pub(super) description: Str,
    pub(super) deprecated: bool,
    pub(super) parameters: Span<Id<Parameter>>,
    pub(super) request_body: Option<Id<RequestBody>>,
    /// Each response by status, in the order they are written, leaving
    /// out extensions.
    pub(super) responses: Span<(Str, Id<Response>)>,
}

/// The extensions that make an Operation Object, or an alias of one in its
/// `x-forge-aliases`, a method.
#[derive(Default)]
pub(super) struct Definition {
    /// The `x-fern-sdk-method-name`, or empty for none.
    pub(super) method_name: Str,
    /// The `x-fern-sdk-group-name`: the group path, top level first, or
    /// empty for none.
    pub(super) group_names: Span<Str>,
    /// `x-fern-ignore`.
    pub(super) ignore: bool,
    /// `x-forge-hidden`.
    pub(super) hidden: bool,
    /// The `x-forge-require-confirmation`, or `None` for none. An empty
    /// one is `Some`.
    pub(super) confirmation: Option<Str>,
    /// The `x-fern-availability` as written, or `None` for none. It is
    /// checked as the method is built, so that an error can name the
    /// operation.
    pub(super) availability: Option<Str>,
    /// Each other extension, which is not read, in `Doc::extensions`, in
    /// the order they are written. One written more than once has the last
    /// value written, in the place of the first.
    pub(super) extensions: Span<(String, Json)>,
}

/// A Parameter Object, or a `$ref` to one.
#[derive(Default)]
pub(super) struct Parameter {
    /// The `$ref`, or empty for none. An empty `$ref` is an error.
    pub(super) reference: Str,
    pub(super) name: Str,
    /// `in`.
    pub(super) location: Option<ParameterLocation>,
    pub(super) description: Str,
    pub(super) required: bool,
    pub(super) deprecated: bool,
    pub(super) style: Option<ParameterStyle>,
    pub(super) explode: Option<bool>,
    /// The schema, or `true` for any value if there is none.
    pub(super) schema: Schema,
    /// The schema of each media type of a parameter described by
    /// `content` rather than `schema`, in the order they are written.
    pub(super) content: Span<(Str, Schema)>,
    /// The `x-fern-parameter-name`, or empty for none.
    pub(super) field_name: Str,
}

/// Where a parameter is sent: the `in` of a Parameter Object.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ParameterLocation {
    Path,
    Query,
    Querystring,
    Header,
    Cookie,
}

/// How a parameter's value is written: the `style` of a Parameter Object.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum ParameterStyle {
    Matrix,
    Label,
    Simple,
    Form,
    SpaceDelimited,
    PipeDelimited,
    DeepObject,
}

/// A Request Body Object, or a `$ref` to one.
#[derive(Default)]
pub(super) struct RequestBody {
    /// The `$ref`, or empty for none. An empty `$ref` is an error.
    pub(super) reference: Str,
    pub(super) description: Str,
    pub(super) required: bool,
    /// The schema of each media type, in the order they are written.
    pub(super) content: Span<(Str, Schema)>,
}

/// A Response Object, or a `$ref` to one.
#[derive(Default)]
pub(super) struct Response {
    /// The `$ref`, or empty for none. An empty `$ref` is an error.
    pub(super) reference: Str,
    pub(super) description: Str,
    /// The schema of each media type, in the order they are written.
    pub(super) content: Span<(Str, Schema)>,
}

/// A Schema Object, or, from OpenAPI 3.1, `true` for any value or `false`
/// for none.
#[derive(Clone, Copy)]
pub(super) enum Schema {
    Bool(bool),
    Object(Id<SchemaObject>),
}

/// A schema written where none is, which allows any value.
impl Default for Schema {
    fn default() -> Schema {
        Schema::Bool(true)
    }
}

/// A Schema Object that is an object, rather than `true` or `false`.
#[derive(Default)]
pub(super) struct SchemaObject {
    /// The `$ref`, or empty for none. An empty `$ref` is an error.
    pub(super) reference: Str,
    /// The types the schema allows: one for a string, any number for an
    /// array, and none without `type`.
    pub(super) types: Span<SchemaType>,
    pub(super) format: Option<Str>,
    pub(super) content_encoding: ContentEncoding,
    pub(super) nullable: bool,
    /// The values of `enum`, or none without it. An empty `enum`, which
    /// allows no value, is read as none.
    pub(super) values: Span<Literal>,
    /// The one value the schema allows, which is `Some(Literal::Null)` for
    /// `const: null`.
    pub(super) constant: Option<Literal>,
    /// Each property, in the order they are written.
    pub(super) properties: Span<(Str, Schema)>,
    pub(super) additional_properties: Option<Schema>,
    /// The `unevaluatedProperties`, or `true` without it.
    pub(super) unevaluated_properties: Schema,
    pub(super) required: Span<Str>,
    pub(super) items: Option<Schema>,
    /// The `minItems`, or `None` without it.
    pub(super) min_items: Option<u64>,
    /// The `maxItems`, or `None` without it.
    pub(super) max_items: Option<u64>,
    /// Whether the schema has `prefixItems`: it is a tuple, which is not
    /// covered, so its items are not kept.
    pub(super) prefix_items: bool,
    /// The members of `allOf`, `anyOf` and `oneOf`, or none without them.
    /// An empty one has no members, as it has none without it.
    pub(super) all_of: Span<Schema>,
    pub(super) any_of: Span<Schema>,
    pub(super) one_of: Span<Schema>,
    /// Whether the schema has `not`, which only constrains the value, so
    /// its schema is not kept.
    pub(super) not: bool,
    pub(super) discriminator: Option<Id<Discriminator>>,
    /// The schemas in `$defs`, in the order they are written.
    pub(super) defs: Span<(Str, Schema)>,
    pub(super) title: Str,
    pub(super) description: Str,
    /// The `default`, in `Doc::defaults`, which is `Some` for `default:
    /// null` too, or `None` without it. It is kept as written, without
    /// being checked against the schema.
    pub(super) default: Option<Id<Json>>,
    pub(super) deprecated: bool,
    /// `readOnly`: the value appears in responses, and a client should not
    /// send it.
    pub(super) read_only: bool,
    /// Whether the schema is marked `x-sensitive: true`: the value is a
    /// secret, such as a password or a token.
    pub(super) sensitive: bool,
    /// The `x-fern-type-name`: the name of the model, for a schema in
    /// `components.schemas`, or empty for none.
    pub(super) model_name: Str,
    /// The `x-fern-property-name`: the name of the field, for a property's
    /// schema, or empty for none.
    pub(super) field_name: Str,
    /// Whether a property's schema is marked `x-stainless-skip: true`. A
    /// list of the targets to skip it for is ignored.
    pub(super) skip: bool,
}

/// A value of `type` in a Schema Object.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum SchemaType {
    String,
    Integer,
    Number,
    Boolean,
    Array,
    Object,
    Null,
}

/// A recognized `format` that decides a type. The original text is kept
/// separately, including formats that do not change the classification.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Format {
    DateTime,
    Date,
    Byte,
    Binary,
    Int8,
    Int16,
    Int32,
    Int64,
    Uint8,
    Uint16,
    Uint32,
    Uint64,
    Float,
    Double,
    Other,
}

impl Format {
    pub(super) fn from_str(format: &str) -> Self {
        match format {
            "date-time" => Self::DateTime,
            "date" => Self::Date,
            "byte" => Self::Byte,
            "binary" => Self::Binary,
            "int8" => Self::Int8,
            "int16" => Self::Int16,
            "int32" => Self::Int32,
            "int64" => Self::Int64,
            "uint8" => Self::Uint8,
            "uint16" => Self::Uint16,
            "uint32" => Self::Uint32,
            "uint64" => Self::Uint64,
            "float" => Self::Float,
            "double" => Self::Double,
            _ => Self::Other,
        }
    }
}

/// A `contentEncoding` in a Schema Object. Every encoding but base64, and
/// no encoding, is `Other`.
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ContentEncoding {
    Base64,
    #[default]
    #[serde(other)]
    Other,
}

/// A value in an `enum` or `const`.
#[derive(Clone, Copy)]
pub(super) enum Literal {
    Null,
    Boolean(bool),
    Number(f64),
    String(Str),
    /// An array or object, which is not covered, so it is not kept.
    Composite,
}

/// A Discriminator Object.
pub(super) struct Discriminator {
    /// `propertyName`.
    pub(super) property_name: Str,
    /// Each value of the property and the `$ref` or schema name it maps
    /// to, in the order they are written.
    pub(super) mapping: Span<(Str, Str)>,
    /// The `$ref` or schema name of the default, or empty for none.
    pub(super) default_mapping: Str,
}

/// The `x-forge-commands` extension of the OpenAPI Object: an entry for
/// each top-level group, by name.
#[derive(Default)]
pub(super) struct Commands(pub(super) HashMap<Name, Command>);

/// An entry in `x-forge-commands`.
#[derive(Deserialize, Default)]
pub(super) struct Command {
    #[serde(default)]
    pub(super) description: String,
    /// The entries of the group's subgroups.
    #[serde(default)]
    pub(super) groups: Commands,
    /// Whether an entry describes this group, rather than it only being on
    /// the way to a group a dotted name describes.
    #[serde(skip)]
    pub(super) described: bool,
}

/// An object that can instead be a `$ref` to one in `components`.
pub(super) trait Referable: Node {
    /// Returns the `$ref`, which is empty if this is the object itself.
    fn reference(&self) -> Str;
}

impl Referable for PathItem {
    fn reference(&self) -> Str {
        self.reference
    }
}

impl Referable for Parameter {
    fn reference(&self) -> Str {
        self.reference
    }
}

impl Referable for RequestBody {
    fn reference(&self) -> Str {
        self.reference
    }
}

impl Referable for Response {
    fn reference(&self) -> Str {
        self.reference
    }
}

impl ParameterLocation {
    /// Returns the location as the document writes it, such as `query`.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            ParameterLocation::Path => "path",
            ParameterLocation::Query => "query",
            ParameterLocation::Querystring => "querystring",
            ParameterLocation::Header => "header",
            ParameterLocation::Cookie => "cookie",
        }
    }
}

impl ParameterStyle {
    /// Returns the style as the document writes it, such as `form`.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            ParameterStyle::Matrix => "matrix",
            ParameterStyle::Label => "label",
            ParameterStyle::Simple => "simple",
            ParameterStyle::Form => "form",
            ParameterStyle::SpaceDelimited => "spaceDelimited",
            ParameterStyle::PipeDelimited => "pipeDelimited",
            ParameterStyle::DeepObject => "deepObject",
        }
    }
}

// Reading.
//
// Each value is read into the `Doc` by a `Read`, which says what it is
// read as: an `Id` of the object it adds, a `Span` of the list it adds,
// or a value such as a `Str`.

/// A way of reading a value into a `Doc`, as an `Out`.
trait Read {
    type Out;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Self::Out, D::Error>;
}

/// What reads a value with `T` into a `Doc`.
struct Seed<'a, T>(&'a mut Doc, PhantomData<T>);

fn seed<T: Read>(doc: &mut Doc) -> Seed<'_, T> {
    Seed(doc, PhantomData)
}

impl<'de, T: Read> DeserializeSeed<'de> for Seed<'_, T> {
    type Value = T::Out;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<T::Out, D::Error> {
        T::read(self.0, deserializer)
    }
}

/// An object read from a map, key by key.
trait ReadObject {
    type Out;
    /// What the object is, for errors, such as `a Parameter Object`.
    const EXPECTING: &'static str;

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, map: A) -> Result<Self::Out, A::Error>;
}

struct ObjectVisitor<'a, T>(&'a mut Doc, PhantomData<T>);

impl<'de, T: ReadObject> Visitor<'de> for ObjectVisitor<'_, T> {
    type Value = T::Out;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(T::EXPECTING)
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T::Out, A::Error> {
        T::read_object(self.0, map)
    }
}

impl<T: ReadObject> Read for T {
    type Out = T::Out;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<T::Out, D::Error> {
        deserializer.deserialize_map(ObjectVisitor::<T>(doc, PhantomData))
    }
}

/// Reads a string.
struct ReadStr;

impl Read for ReadStr {
    type Out = Str;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Str, D::Error> {
        struct StrVisitor<'a>(&'a mut Strings);

        impl Visitor<'_> for StrVisitor<'_> {
            type Value = Str;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Str, E> {
                Ok(self.0.push(v))
            }
        }

        deserializer.deserialize_str(StrVisitor(&mut doc.strings))
    }
}

/// Reads a `$ref`, which cannot be empty: the empty reference points to the
/// whole document, which is never what a `$ref` can stand for here.
struct Reference;

impl Read for Reference {
    type Out = Str;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Str, D::Error> {
        struct ReferenceVisitor<'a>(&'a mut Strings);

        impl Visitor<'_> for ReferenceVisitor<'_> {
            type Value = Str;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a $ref")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Str, E> {
                if v.is_empty() {
                    return Err(E::custom(
                        "$ref \"\" points to the whole document, which is not covered",
                    ));
                }
                Ok(self.0.push(v))
            }
        }

        deserializer.deserialize_str(ReferenceVisitor(&mut doc.strings))
    }
}

/// Reads a value that can be `null`, which is `None`, as is a missing one.
struct Nullable<T>(PhantomData<T>);

impl<T: Read> Read for Nullable<T> {
    type Out = Option<T::Out>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Option<T::Out>, D::Error> {
        struct NullableVisitor<'a, T>(&'a mut Doc, PhantomData<T>);

        impl<'de, T: Read> Visitor<'de> for NullableVisitor<'_, T> {
            type Value = Option<T::Out>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a value or null")
            }

            fn visit_none<E: de::Error>(self) -> Result<Option<T::Out>, E> {
                Ok(None)
            }

            fn visit_unit<E: de::Error>(self) -> Result<Option<T::Out>, E> {
                Ok(None)
            }

            fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Option<T::Out>, D::Error> {
                T::read(self.0, deserializer).map(Some)
            }
        }

        deserializer.deserialize_option(NullableVisitor::<T>(doc, PhantomData))
    }
}

/// Reads an array, each element with `T`, as a list.
struct Seq<T>(PhantomData<T>);

impl<T: Read> Read for Seq<T>
where
    T::Out: Item,
{
    type Out = Span<T::Out>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Span<T::Out>, D::Error> {
        struct SeqVisitor<'a, T>(&'a mut Doc, PhantomData<T>);

        impl<'de, T: Read> Visitor<'de> for SeqVisitor<'_, T>
        where
            T::Out: Item,
        {
            type Value = Span<T::Out>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a sequence")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Span<T::Out>, A::Error> {
                let doc = self.0;
                let start = T::Out::list_mut(doc).start();
                while let Some(item) = seq.next_element_seed(seed::<T>(doc))? {
                    T::Out::list_mut(doc).push(item);
                }
                Ok(T::Out::list_mut(doc).finish(start))
            }
        }

        deserializer.deserialize_seq(SeqVisitor::<T>(doc, PhantomData))
    }
}

/// Reads an object as its entries, each value with `T`, in the order they
/// are written, leaving out extensions, keys that start with `x-`, if
/// `SKIP_EXTENSIONS`. Their values are skipped without being read.
struct Entries<T, const SKIP_EXTENSIONS: bool>(PhantomData<T>);

/// Reads an object as its entries; see [`Entries`].
type AllEntries<T> = Entries<T, false>;

impl<T: Read, const SKIP_EXTENSIONS: bool> Read for Entries<T, SKIP_EXTENSIONS>
where
    (Str, T::Out): Item,
{
    type Out = Span<(Str, T::Out)>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Span<(Str, T::Out)>, D::Error> {
        struct EntriesVisitor<'a, T, const S: bool>(&'a mut Doc, PhantomData<T>);

        impl<'de, T: Read, const S: bool> Visitor<'de> for EntriesVisitor<'_, T, S>
        where
            (Str, T::Out): Item,
        {
            type Value = Span<(Str, T::Out)>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Span<(Str, T::Out)>, A::Error> {
                let doc = self.0;
                let start = <(Str, T::Out)>::list_mut(doc).start();
                while let Some(key) = map.next_key_seed(KeySeed::<S>(&mut doc.strings))? {
                    let Some(key) = key else {
                        map.next_value::<IgnoredAny>()?;
                        continue;
                    };
                    let value = map.next_value_seed(seed::<T>(doc))?;
                    <(Str, T::Out)>::list_mut(doc).push((key, value));
                }
                Ok(<(Str, T::Out)>::list_mut(doc).finish(start))
            }
        }

        deserializer.deserialize_map(EntriesVisitor::<T, SKIP_EXTENSIONS>(doc, PhantomData))
    }
}

/// Reads the key of an entry, or `None` for an extension if
/// `SKIP_EXTENSIONS`, which is not kept.
struct KeySeed<'a, const SKIP_EXTENSIONS: bool>(&'a mut Strings);

impl<'de, const SKIP_EXTENSIONS: bool> DeserializeSeed<'de> for KeySeed<'_, SKIP_EXTENSIONS> {
    type Value = Option<Str>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Option<Str>, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<const SKIP_EXTENSIONS: bool> Visitor<'_> for KeySeed<'_, SKIP_EXTENSIONS> {
    type Value = Option<Str>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a string")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Option<Str>, E> {
        if SKIP_EXTENSIONS && v.starts_with("x-") {
            return Ok(None);
        }
        Ok(Some(self.0.push(v)))
    }
}

/// Reads a `type`: one type, or an array of them.
struct Types;

impl Read for Types {
    type Out = Span<SchemaType>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Span<SchemaType>, D::Error> {
        struct TypesVisitor<'a>(&'a mut List<SchemaType>);

        impl<'de> Visitor<'de> for TypesVisitor<'_> {
            type Value = Span<SchemaType>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a type or an array of types")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Span<SchemaType>, E> {
                let ty = SchemaType::deserialize(de::value::StrDeserializer::new(v))?;
                let start = self.0.start();
                self.0.push(ty);
                Ok(self.0.finish(start))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Span<SchemaType>, A::Error> {
                let start = self.0.start();
                while let Some(ty) = seq.next_element()? {
                    self.0.push(ty);
                }
                Ok(self.0.finish(start))
            }
        }

        deserializer.deserialize_any(TypesVisitor(&mut doc.types))
    }
}

/// Reads an `x-fern-sdk-group-name`: a string split on dots, or an array of
/// strings that are not split. The empty string is no group.
struct GroupNames;

impl Read for GroupNames {
    type Out = Span<Str>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Span<Str>, D::Error> {
        struct GroupNamesVisitor<'a>(&'a mut Doc);

        impl<'de> Visitor<'de> for GroupNamesVisitor<'_> {
            type Value = Span<Str>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string or an array of strings")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Span<Str>, E> {
                if v.is_empty() {
                    return Ok(Span::default());
                }
                let doc = self.0;
                Ok(doc.strings.push_split(v, '.', &mut doc.str_lists))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Span<Str>, A::Error> {
                // The same as reading the array as a `Seq` of strings.
                SeqOfStrs(self.0).visit_seq(seq)
            }
        }

        deserializer.deserialize_any(GroupNamesVisitor(doc))
    }
}

/// Reads an array of strings.
struct SeqOfStrs<'a>(&'a mut Doc);

impl<'de> Visitor<'de> for SeqOfStrs<'_> {
    type Value = Span<Str>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array of strings")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Span<Str>, A::Error> {
        let doc = self.0;
        let start = doc.str_lists.start();
        while let Some(s) = seq.next_element_seed(seed::<ReadStr>(doc))? {
            doc.str_lists.push(s);
        }
        Ok(doc.str_lists.finish(start))
    }
}

/// Reads a value in an `enum` or `const`.
impl Read for Literal {
    type Out = Literal;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Literal, D::Error> {
        struct LiteralVisitor<'a>(&'a mut Strings);

        impl<'de> Visitor<'de> for LiteralVisitor<'_> {
            type Value = Literal;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any value")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Literal, E> {
                Ok(Literal::Null)
            }

            fn visit_none<E: de::Error>(self) -> Result<Literal, E> {
                Ok(Literal::Null)
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Literal, E> {
                Ok(Literal::Boolean(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Literal, E> {
                Ok(Literal::Number(v as f64))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Literal, E> {
                Ok(Literal::Number(v as f64))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Literal, E> {
                Ok(Literal::Number(v))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Literal, E> {
                Ok(Literal::String(self.0.push(v)))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Literal, A::Error> {
                while let Some(IgnoredAny) = seq.next_element()? {}
                Ok(Literal::Composite)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Literal, A::Error> {
                while let Some((IgnoredAny, IgnoredAny)) = map.next_entry()? {}
                Ok(Literal::Composite)
            }
        }

        deserializer.deserialize_any(LiteralVisitor(&mut doc.strings))
    }
}

/// Reads a Schema Object, or `true` or `false`.
impl Read for Schema {
    type Out = Schema;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Schema, D::Error> {
        struct SchemaVisitor<'a>(&'a mut Doc);

        impl<'de> Visitor<'de> for SchemaVisitor<'_> {
            type Value = Schema;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a Schema Object or a boolean")
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Schema, E> {
                Ok(Schema::Bool(v))
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Schema, A::Error> {
                SchemaObject::read_object(self.0, map).map(Schema::Object)
            }
        }

        deserializer.deserialize_any(SchemaVisitor(doc))
    }
}

/// Reads a Media Type Object as its schema, or `true` if it has none.
struct MediaType;

keys! {
    MediaTypeKey { Schema = "schema", }
}

impl ReadObject for MediaType {
    type Out = Schema;
    const EXPECTING: &'static str = "a Media Type Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Schema, A::Error> {
        let mut schema = Schema::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<MediaTypeKey>()? {
            key.once(&mut seen)?;
            match key {
                MediaTypeKey::Schema => schema = map.next_value_seed(seed::<Schema>(doc))?,
                MediaTypeKey::Other => skip(&mut map)?,
            }
        }
        Ok(schema)
    }
}

/// Skips the value of the entry being read.
fn skip<'de, A: MapAccess<'de>>(map: &mut A) -> Result<(), A::Error> {
    map.next_value::<IgnoredAny>()?;
    Ok(())
}

/// Reads that a key is there, skipping its value.
fn present<'de, A: MapAccess<'de>>(map: &mut A) -> Result<bool, A::Error> {
    skip(map)?;
    Ok(true)
}

/// The first of `servers`.
struct FirstServer(Server);

impl<'de> Deserialize<'de> for FirstServer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<FirstServer, D::Error> {
        first(deserializer).map(FirstServer)
    }
}

keys! {
    DocumentKey {
        Openapi = "openapi",
        Info = "info",
        Servers = "servers",
        Paths = "paths",
        Components = "components",
        Commands = "x-forge-commands",
    }
}

struct DocumentVisitor<'a>(&'a mut Doc);

impl<'de> Visitor<'de> for DocumentVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an OpenAPI Object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let doc = self.0;
        let mut seen = 0;
        while let Some(key) = map.next_key::<DocumentKey>()? {
            key.once(&mut seen)?;
            match key {
                DocumentKey::Openapi => doc.openapi = map.next_value()?,
                DocumentKey::Info => doc.info = map.next_value()?,
                DocumentKey::Servers => doc.servers = map.next_value::<FirstServer>()?.0,
                DocumentKey::Paths => {
                    doc.paths = map.next_value_seed(seed::<Entries<PathItem, true>>(doc))?;
                }
                DocumentKey::Components => {
                    doc.components = map.next_value_seed(seed::<Components>(doc))?;
                }
                DocumentKey::Commands => doc.commands = map.next_value()?,
                DocumentKey::Other => skip(&mut map)?,
            }
        }
        Ok(())
    }
}

keys! {
    ComponentsKey {
        Schemas = "schemas",
        Parameters = "parameters",
        RequestBodies = "requestBodies",
        Responses = "responses",
        PathItems = "pathItems",
    }
}

impl ReadObject for Components {
    type Out = Components;
    const EXPECTING: &'static str = "a Components Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Components, A::Error> {
        let mut components = Components::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<ComponentsKey>()? {
            key.once(&mut seen)?;
            match key {
                ComponentsKey::Schemas => {
                    components.schemas = map.next_value_seed(seed::<AllEntries<Schema>>(doc))?;
                }
                ComponentsKey::Parameters => {
                    components.parameters = map.next_value_seed(seed::<AllEntries<Parameter>>(doc))?;
                }
                ComponentsKey::RequestBodies => {
                    components.request_bodies = map.next_value_seed(seed::<AllEntries<RequestBody>>(doc))?;
                }
                ComponentsKey::Responses => {
                    components.responses = map.next_value_seed(seed::<AllEntries<Response>>(doc))?;
                }
                ComponentsKey::PathItems => {
                    components.path_items = map.next_value_seed(seed::<AllEntries<PathItem>>(doc))?;
                }
                ComponentsKey::Other => skip(&mut map)?,
            }
        }
        Ok(components)
    }
}

keys! {
    PathItemKey {
        Ref = "$ref",
        Parameters = "parameters",
        Get = "get",
        Put = "put",
        Post = "post",
        Delete = "delete",
        Options = "options",
        Head = "head",
        Patch = "patch",
        Trace = "trace",
        Query = "query",
        Connect = "connect",
        AdditionalOperations = "additionalOperations",
    }
}

impl ReadObject for PathItem {
    type Out = Id<PathItem>;
    const EXPECTING: &'static str = "a Path Item Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<PathItem>, A::Error> {
        let mut item = PathItem::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<PathItemKey>()? {
            key.once(&mut seen)?;
            let operation = match key {
                PathItemKey::Ref => {
                    item.reference = map.next_value_seed(seed::<Reference>(doc))?;
                    continue;
                }
                PathItemKey::Parameters => {
                    item.parameters = map.next_value_seed(seed::<Seq<Parameter>>(doc))?;
                    continue;
                }
                PathItemKey::AdditionalOperations => {
                    item.additional_operations = map.next_value_seed(seed::<AllEntries<Operation>>(doc))?;
                    continue;
                }
                PathItemKey::Other => {
                    skip(&mut map)?;
                    continue;
                }
                PathItemKey::Get => &mut item.get,
                PathItemKey::Put => &mut item.put,
                PathItemKey::Post => &mut item.post,
                PathItemKey::Delete => &mut item.delete,
                PathItemKey::Options => &mut item.options,
                PathItemKey::Head => &mut item.head,
                PathItemKey::Patch => &mut item.patch,
                PathItemKey::Trace => &mut item.trace,
                PathItemKey::Query => &mut item.query,
                PathItemKey::Connect => &mut item.connect,
            };
            *operation = map.next_value_seed(seed::<Nullable<Operation>>(doc))?;
        }
        Ok(doc.add(item))
    }
}

keys! {
    /// The keys of a [`Definition`], in an Operation Object or an alias.
    DefinitionKey {
        MethodName = "x-fern-sdk-method-name",
        GroupNames = "x-fern-sdk-group-name",
        Ignore = "x-fern-ignore",
        Hidden = "x-forge-hidden",
        Confirmation = "x-forge-require-confirmation",
        Availability = "x-fern-availability",
    }
}

impl Definition {
    /// Reads the value of `key`, the key of the entry `map` is reading.
    fn read_value<'de, A: MapAccess<'de>>(
        &mut self,
        doc: &mut Doc,
        map: &mut A,
        key: DefinitionKey,
    ) -> Result<(), A::Error> {
        match key {
            DefinitionKey::MethodName => self.method_name = map.next_value_seed(seed::<ReadStr>(doc))?,
            DefinitionKey::GroupNames => self.group_names = map.next_value_seed(seed::<GroupNames>(doc))?,
            DefinitionKey::Ignore => self.ignore = map.next_value()?,
            DefinitionKey::Hidden => self.hidden = map.next_value()?,
            DefinitionKey::Confirmation => {
                self.confirmation = Some(map.next_value_seed(seed::<ReadStr>(doc))?);
            }
            DefinitionKey::Availability => {
                self.availability = Some(map.next_value_seed(seed::<ReadStr>(doc))?);
            }
            DefinitionKey::Other => skip(map)?,
        }
        Ok(())
    }
}

/// Reads an alias in `x-forge-aliases`: an object of the keys of a
/// definition and other extensions. Its keys that are not extensions are
/// skipped, and so is an `x-forge-aliases` in it, since aliases do not
/// nest.
struct Alias;

impl ReadObject for Alias {
    type Out = Definition;
    const EXPECTING: &'static str = "an alias";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Definition, A::Error> {
        let mut definition = Definition::default();
        let mut seen = 0;
        // As for an operation.
        let mut extensions = Vec::new();
        while let Some(field) = map.next_key::<AliasField>()? {
            match field {
                AliasField::Definition(key) => {
                    key.once(&mut seen)?;
                    definition.read_value(doc, &mut map, key)?;
                }
                AliasField::Extension(name) => json::insert(&mut extensions, name, map.next_value()?),
                AliasField::Other => skip(&mut map)?,
            }
        }
        definition.extensions = doc.extensions.extend(extensions);
        Ok(definition)
    }
}

/// Reads an `x-forge-aliases`: an array, each object in which is read as
/// an [`Alias`]. Each other element is read as an empty definition, which
/// makes no method, so that every alias is at its index in the array.
struct Aliases;

impl Read for Aliases {
    type Out = Span<Definition>;

    fn read<'de, D: Deserializer<'de>>(doc: &mut Doc, deserializer: D) -> Result<Span<Definition>, D::Error> {
        struct AliasesVisitor<'a>(&'a mut Doc);

        impl<'de> Visitor<'de> for AliasesVisitor<'_> {
            type Value = Span<Definition>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an array of aliases")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Span<Definition>, A::Error> {
                let doc = self.0;
                let start = doc.aliases.start();
                while let Some(alias) = seq.next_element_seed(MaybeAlias(doc))? {
                    doc.aliases.push(alias.unwrap_or_default());
                }
                Ok(doc.aliases.finish(start))
            }
        }

        deserializer.deserialize_seq(AliasesVisitor(doc))
    }
}

/// What reads an element of `x-forge-aliases`: an [`Alias`] if it is an
/// object, or else `None`.
struct MaybeAlias<'a>(&'a mut Doc);

impl<'de> DeserializeSeed<'de> for MaybeAlias<'_> {
    type Value = Option<Definition>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Option<Definition>, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for MaybeAlias<'_> {
    type Value = Option<Definition>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any value")
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Option<Definition>, A::Error> {
        Alias::read_object(self.0, map).map(Some)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_none<E: de::Error>(self) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Option<Definition>, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Option<Definition>, E> {
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Option<Definition>, A::Error> {
        while let Some(IgnoredAny) = seq.next_element()? {}
        Ok(None)
    }
}

/// A key of an alias: one of a definition, an extension that is not read,
/// which is kept by its name, or any other key, which is skipped, as
/// [`Alias`] says.
enum AliasField {
    Definition(DefinitionKey),
    Extension(String),
    Other,
}

impl<'de> Deserialize<'de> for AliasField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<AliasField, D::Error> {
        struct FieldVisitor;

        impl Visitor<'_> for FieldVisitor {
            type Value = AliasField;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a key")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<AliasField, E> {
                Ok(match DefinitionKey::from_key(v) {
                    DefinitionKey::Other if !v.starts_with("x-") => AliasField::Other,
                    DefinitionKey::Other => match OperationKey::from_key(v) {
                        OperationKey::Aliases => AliasField::Other,
                        _ => AliasField::Extension(v.to_owned()),
                    },
                    key => AliasField::Definition(key),
                })
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

keys! {
    OperationKey {
        Aliases = "x-forge-aliases",
        Summary = "summary",
        Description = "description",
        Deprecated = "deprecated",
        Parameters = "parameters",
        RequestBody = "requestBody",
        Responses = "responses",
    }
}

impl ReadObject for Operation {
    type Out = Id<Operation>;
    const EXPECTING: &'static str = "an Operation Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<Operation>, A::Error> {
        let mut operation = Operation::default();
        let mut seen = 0;
        let mut seen_definition = 0;
        // Kept apart until the operation is read, so that an extension
        // written again can replace the first. Empty, it allocates nothing.
        let mut extensions = Vec::new();
        while let Some(field) = map.next_key::<OperationField>()? {
            let key = match field {
                OperationField::Key(key) => key,
                OperationField::Definition(key) => {
                    key.once(&mut seen_definition)?;
                    operation.definition.read_value(doc, &mut map, key)?;
                    continue;
                }
                OperationField::Extension(name) => {
                    json::insert(&mut extensions, name, map.next_value()?);
                    continue;
                }
            };
            key.once(&mut seen)?;
            match key {
                OperationKey::Aliases => {
                    operation.aliases = Some(map.next_value_seed(seed::<Aliases>(doc))?);
                }
                OperationKey::Summary => operation.summary = map.next_value_seed(seed::<ReadStr>(doc))?,
                OperationKey::Description => {
                    operation.description = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                OperationKey::Deprecated => operation.deprecated = map.next_value()?,
                OperationKey::Parameters => {
                    operation.parameters = map.next_value_seed(seed::<Seq<Parameter>>(doc))?;
                }
                OperationKey::RequestBody => {
                    operation.request_body = map.next_value_seed(seed::<Nullable<RequestBody>>(doc))?;
                }
                OperationKey::Responses => {
                    operation.responses = map.next_value_seed(seed::<Entries<Response, true>>(doc))?;
                }
                OperationKey::Other => skip(&mut map)?,
            }
        }
        operation.definition.extensions = doc.extensions.extend(extensions);
        Ok(doc.add(operation))
    }
}

/// A key of an Operation Object: one of its definition, another that is
/// read, or an extension that is not, which is kept by its name. Any other
/// key is `OperationKey::Other`.
enum OperationField {
    Definition(DefinitionKey),
    Key(OperationKey),
    Extension(String),
}

impl<'de> Deserialize<'de> for OperationField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<OperationField, D::Error> {
        struct FieldVisitor;

        impl Visitor<'_> for FieldVisitor {
            type Value = OperationField;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a key")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<OperationField, E> {
                match DefinitionKey::from_key(v) {
                    DefinitionKey::Other => {}
                    key => return Ok(OperationField::Definition(key)),
                }
                Ok(match OperationKey::from_key(v) {
                    OperationKey::Other if v.starts_with("x-") => OperationField::Extension(v.to_owned()),
                    key => OperationField::Key(key),
                })
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

keys! {
    ParameterKey {
        Ref = "$ref",
        Name = "name",
        In = "in",
        Description = "description",
        Required = "required",
        Deprecated = "deprecated",
        Style = "style",
        Explode = "explode",
        Schema = "schema",
        Content = "content",
        FieldName = "x-fern-parameter-name",
    }
}

impl ReadObject for Parameter {
    type Out = Id<Parameter>;
    const EXPECTING: &'static str = "a Parameter Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<Parameter>, A::Error> {
        let mut param = Parameter::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<ParameterKey>()? {
            key.once(&mut seen)?;
            match key {
                ParameterKey::Ref => param.reference = map.next_value_seed(seed::<Reference>(doc))?,
                ParameterKey::Name => param.name = map.next_value_seed(seed::<ReadStr>(doc))?,
                ParameterKey::In => param.location = map.next_value()?,
                ParameterKey::Description => {
                    param.description = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                ParameterKey::Required => param.required = map.next_value()?,
                ParameterKey::Deprecated => param.deprecated = map.next_value()?,
                ParameterKey::Style => param.style = map.next_value()?,
                ParameterKey::Explode => param.explode = map.next_value()?,
                ParameterKey::Schema => param.schema = map.next_value_seed(seed::<Schema>(doc))?,
                ParameterKey::Content => {
                    param.content = map.next_value_seed(seed::<AllEntries<MediaType>>(doc))?;
                }
                ParameterKey::FieldName => param.field_name = map.next_value_seed(seed::<ReadStr>(doc))?,
                ParameterKey::Other => skip(&mut map)?,
            }
        }
        Ok(doc.add(param))
    }
}

keys! {
    RequestBodyKey {
        Ref = "$ref",
        Description = "description",
        Required = "required",
        Content = "content",
    }
}

impl ReadObject for RequestBody {
    type Out = Id<RequestBody>;
    const EXPECTING: &'static str = "a Request Body Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<RequestBody>, A::Error> {
        let mut body = RequestBody::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<RequestBodyKey>()? {
            key.once(&mut seen)?;
            match key {
                RequestBodyKey::Ref => body.reference = map.next_value_seed(seed::<Reference>(doc))?,
                RequestBodyKey::Description => {
                    body.description = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                RequestBodyKey::Required => body.required = map.next_value()?,
                RequestBodyKey::Content => {
                    body.content = map.next_value_seed(seed::<AllEntries<MediaType>>(doc))?;
                }
                RequestBodyKey::Other => skip(&mut map)?,
            }
        }
        Ok(doc.add(body))
    }
}

keys! {
    ResponseKey {
        Ref = "$ref",
        Description = "description",
        Content = "content",
    }
}

impl ReadObject for Response {
    type Out = Id<Response>;
    const EXPECTING: &'static str = "a Response Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<Response>, A::Error> {
        let mut response = Response::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<ResponseKey>()? {
            key.once(&mut seen)?;
            match key {
                ResponseKey::Ref => response.reference = map.next_value_seed(seed::<Reference>(doc))?,
                ResponseKey::Description => {
                    response.description = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                ResponseKey::Content => {
                    response.content = map.next_value_seed(seed::<AllEntries<MediaType>>(doc))?;
                }
                ResponseKey::Other => skip(&mut map)?,
            }
        }
        Ok(doc.add(response))
    }
}

keys! {
    SchemaKey {
        Ref = "$ref",
        Type = "type",
        Format = "format",
        ContentEncoding = "contentEncoding",
        Nullable = "nullable",
        Enum = "enum",
        Const = "const",
        Properties = "properties",
        AdditionalProperties = "additionalProperties",
        UnevaluatedProperties = "unevaluatedProperties",
        Required = "required",
        Items = "items",
        MinItems = "minItems",
        MaxItems = "maxItems",
        PrefixItems = "prefixItems",
        AllOf = "allOf",
        AnyOf = "anyOf",
        OneOf = "oneOf",
        Not = "not",
        Discriminator = "discriminator",
        Defs = "$defs",
        Title = "title",
        Description = "description",
        Default = "default",
        Deprecated = "deprecated",
        ReadOnly = "readOnly",
        Sensitive = "x-sensitive",
        ModelName = "x-fern-type-name",
        FieldName = "x-fern-property-name",
        Skip = "x-stainless-skip",
    }
}

impl ReadObject for SchemaObject {
    type Out = Id<SchemaObject>;
    const EXPECTING: &'static str = "a Schema Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<SchemaObject>, A::Error> {
        let mut schema = SchemaObject::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<SchemaKey>()? {
            key.once(&mut seen)?;
            match key {
                SchemaKey::Ref => schema.reference = map.next_value_seed(seed::<Reference>(doc))?,
                SchemaKey::Type => schema.types = map.next_value_seed(seed::<Types>(doc))?,
                SchemaKey::Format => schema.format = Some(map.next_value_seed(seed::<ReadStr>(doc))?),
                SchemaKey::ContentEncoding => schema.content_encoding = map.next_value()?,
                SchemaKey::Nullable => schema.nullable = map.next_value()?,
                SchemaKey::Enum => schema.values = map.next_value_seed(seed::<Seq<Literal>>(doc))?,
                SchemaKey::Const => {
                    schema.constant = Some(map.next_value_seed(seed::<Literal>(doc))?);
                }
                SchemaKey::Properties => {
                    schema.properties = map.next_value_seed(seed::<AllEntries<Schema>>(doc))?;
                }
                SchemaKey::AdditionalProperties => {
                    schema.additional_properties = map.next_value_seed(seed::<Nullable<Schema>>(doc))?;
                }
                SchemaKey::UnevaluatedProperties => {
                    schema.unevaluated_properties = map.next_value_seed(seed::<Schema>(doc))?;
                }
                SchemaKey::Required => {
                    schema.required = map.next_value_seed(SeqOfStrsSeed(doc))?;
                }
                SchemaKey::Items => schema.items = map.next_value_seed(seed::<Nullable<Schema>>(doc))?,
                SchemaKey::MinItems => schema.min_items = Some(map.next_value::<Count>()?.0),
                SchemaKey::MaxItems => schema.max_items = Some(map.next_value::<Count>()?.0),
                SchemaKey::PrefixItems => schema.prefix_items = present(&mut map)?,
                SchemaKey::AllOf => schema.all_of = map.next_value_seed(seed::<Seq<Schema>>(doc))?,
                SchemaKey::AnyOf => schema.any_of = map.next_value_seed(seed::<Seq<Schema>>(doc))?,
                SchemaKey::OneOf => schema.one_of = map.next_value_seed(seed::<Seq<Schema>>(doc))?,
                SchemaKey::Not => schema.not = present(&mut map)?,
                SchemaKey::Discriminator => {
                    schema.discriminator = map.next_value_seed(seed::<Nullable<Discriminator>>(doc))?;
                }
                SchemaKey::Defs => schema.defs = map.next_value_seed(seed::<AllEntries<Schema>>(doc))?,
                SchemaKey::Title => schema.title = map.next_value_seed(seed::<ReadStr>(doc))?,
                SchemaKey::Description => {
                    schema.description = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                SchemaKey::Default => schema.default = Some(doc.add(map.next_value::<Json>()?)),
                SchemaKey::Deprecated => schema.deprecated = map.next_value()?,
                SchemaKey::ReadOnly => schema.read_only = map.next_value()?,
                SchemaKey::Sensitive => schema.sensitive = map.next_value()?,
                SchemaKey::ModelName => schema.model_name = map.next_value_seed(seed::<ReadStr>(doc))?,
                SchemaKey::FieldName => schema.field_name = map.next_value_seed(seed::<ReadStr>(doc))?,
                SchemaKey::Skip => schema.skip = map.next_value::<StainlessSkip>()?.0,
                SchemaKey::Other => skip(&mut map)?,
            }
        }
        Ok(doc.add(schema))
    }
}

/// What reads an array of strings into a `Doc`.
struct SeqOfStrsSeed<'a>(&'a mut Doc);

impl<'de> DeserializeSeed<'de> for SeqOfStrsSeed<'_> {
    type Value = Span<Str>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Span<Str>, D::Error> {
        deserializer.deserialize_seq(SeqOfStrs(self.0))
    }
}

keys! {
    DiscriminatorKey {
        PropertyName = "propertyName",
        Mapping = "mapping",
        DefaultMapping = "defaultMapping",
    }
}

impl ReadObject for Discriminator {
    type Out = Id<Discriminator>;
    const EXPECTING: &'static str = "a Discriminator Object";

    fn read_object<'de, A: MapAccess<'de>>(doc: &mut Doc, mut map: A) -> Result<Id<Discriminator>, A::Error> {
        let mut property_name = None;
        let mut mapping = Span::default();
        let mut default_mapping = Str::default();
        let mut seen = 0;
        while let Some(key) = map.next_key::<DiscriminatorKey>()? {
            key.once(&mut seen)?;
            match key {
                DiscriminatorKey::PropertyName => {
                    property_name = Some(map.next_value_seed(seed::<ReadStr>(doc))?);
                }
                DiscriminatorKey::Mapping => {
                    mapping = map.next_value_seed(seed::<AllEntries<ReadStr>>(doc))?;
                }
                DiscriminatorKey::DefaultMapping => {
                    default_mapping = map.next_value_seed(seed::<ReadStr>(doc))?;
                }
                DiscriminatorKey::Other => skip(&mut map)?,
            }
        }
        let Some(property_name) = property_name else {
            return Err(de::Error::missing_field("propertyName"));
        };
        Ok(doc.add(Discriminator {
            property_name,
            mapping,
            default_mapping,
        }))
    }
}

/// A count, such as `maxItems`: a non-negative integer. A number with no
/// fractional part, such as `2.0`, is one, as JSON Schema says; any other
/// number, such as `-1` or `2.5`, and any value that is not a number, is
/// an error.
struct Count(u64);

impl<'de> Deserialize<'de> for Count {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Count, D::Error> {
        struct CountVisitor;

        impl Visitor<'_> for CountVisitor {
            type Value = Count;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a non-negative integer")
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Count, E> {
                Ok(Count(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Count, E> {
                match u64::try_from(v) {
                    Ok(v) => Ok(Count(v)),
                    Err(_) => Err(E::invalid_value(de::Unexpected::Signed(v), &self)),
                }
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Count, E> {
                // 2^64 is the first float that does not fit in a `u64`.
                if v >= 0.0 && v.fract() == 0.0 && v < 18_446_744_073_709_552_000.0 {
                    Ok(Count(v as u64))
                } else {
                    Err(E::invalid_value(de::Unexpected::Float(v), &self))
                }
            }
        }

        deserializer.deserialize_any(CountVisitor)
    }
}

/// An `x-stainless-skip`: `true` or `false`, or a list of the targets to
/// skip for, which is not `true`.
struct StainlessSkip(bool);

impl<'de> Deserialize<'de> for StainlessSkip {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<StainlessSkip, D::Error> {
        struct SkipVisitor;

        impl<'de> Visitor<'de> for SkipVisitor {
            type Value = StainlessSkip;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a boolean or an array of targets")
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<StainlessSkip, E> {
                Ok(StainlessSkip(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<StainlessSkip, A::Error> {
                while let Some(IgnoredAny) = seq.next_element()? {}
                Ok(StainlessSkip(false))
            }
        }

        deserializer.deserialize_any(SkipVisitor)
    }
}

/// Reads `x-forge-commands`. A key with dots, such as
/// `dynamic-routing.deployments`, is a path: it describes the group
/// `deployments` inside `dynamic-routing`, the same as nesting the entry in
/// the `groups` of a `dynamic-routing` entry.
impl<'de> Deserialize<'de> for Commands {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Commands, D::Error> {
        struct CommandsVisitor;

        impl<'de> Visitor<'de> for CommandsVisitor {
            type Value = Commands;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of commands")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Commands, A::Error> {
                let mut commands = Commands(HashMap::with_capacity(map.size_hint().unwrap_or(0)));
                while let Some((key, mut command)) = map.next_entry::<String, Command>()? {
                    command.described = true;
                    let path: Vec<Name> = key.split('.').map(Name::new).collect();
                    commands.insert(&path, command).map_err(de::Error::custom)?;
                }
                Ok(commands)
            }
        }

        deserializer.deserialize_map(CommandsVisitor)
    }
}

impl Commands {
    /// Places `command` at `path`, adding the groups on the way that no
    /// entry describes. Two entries that describe the same group, such as
    /// `abuse_reports` and `abuse-reports`, or `a.b` and `b` in the `groups`
    /// of `a`, are an error.
    fn insert(&mut self, path: &[Name], command: Command) -> Result<(), String> {
        let (name, rest) = path.split_first().expect("a key has at least one name");
        let entry = self.0.entry(name.clone()).or_default();
        if !rest.is_empty() {
            return entry.groups.insert(rest, command);
        }
        if entry.described && command.described {
            let words = name.words().join(" ");
            return Err(format!("two entries in x-forge-commands have the name {words:?}"));
        }
        let Command {
            description,
            groups,
            described,
        } = command;
        if described {
            entry.description = description;
            entry.described = true;
        }
        for (name, group) in groups.0 {
            entry.groups.insert(&[name], group)?;
        }
        Ok(())
    }
}
