//! The types of values, built from schemas.

use std::fmt;

use crate::arena::{Id, Span, Str, Strings};
use crate::{Forge, Json, Model, ModelId, Name};

/// The type of a value, built from a schema.
///
/// A `Type` and the parts it carries are cheap references into the
/// [`Forge`] it came from.
///
/// A type that allows null, other than [`Scalar::Unknown`], is a
/// [`Union`] with a [`Scalar::Null`] member, however the schema says so:
/// with `nullable: true`, in any version of OpenAPI, a `"null"` type,
/// `const: null`, or `null` among the values of an `enum`.
#[derive(Clone, Copy, Debug)]
pub enum Type<'f> {
    /// A type with no parts.
    Scalar(Scalar),
    /// One of the values of an `enum`, which are all different, in the
    /// order it lists them. There is at least one, and none is null: an
    /// `enum` that lists `null` is a union of the other values and
    /// [`Scalar::Null`], and one that lists only `null` is `Scalar::Null`.
    ///
    /// A `const` is an enum of one value. An `enum` that lists an object or
    /// an array is not covered yet, and is [`Scalar::Unknown`].
    Enum(Enum<'f>),
    /// A list of values of one type: the type of `items`, or any value
    /// without it. A schema with `items` is an array even without `type`.
    ///
    /// A tuple, written with `prefixItems`, is not covered yet, and is
    /// [`Scalar::Unknown`].
    Array(Array<'f>),
    /// An object, with fields, other keys, both or neither. A map is an
    /// object with no fields and other keys. A schema with `properties` or
    /// `additionalProperties` is an object even without `type`.
    Object(Object<'f>),
    /// Any of the members: from `anyOf`, `oneOf`, or a `type` that lists
    /// more than one type.
    ///
    /// A member that only constrains the value, such as one with only
    /// `required` or `not`, is left out, and so is the whole `anyOf` or
    /// `oneOf` when every member is one. A `type` next to `anyOf` or
    /// `oneOf` is left out, and `properties` next to them make an
    /// [`Intersection`] of their object and the union.
    Union(Union<'f>),
    /// All of the members: from `allOf`.
    ///
    /// A member that gives no shape, such as `{}`, `true`, `{type: object}`
    /// or one with only a `description`, is left out, and a single member
    /// left is the type itself. A member with only `required` makes those
    /// fields of the other members required. A model among them becomes an
    /// object with a copy of its fields, so the model itself is unchanged.
    /// An `allOf` member adds its own members. A `type` or `items` next to
    /// `allOf` is left out, and `properties` next to it are one more
    /// member: their object.
    Intersection(Intersection<'f>),
    /// The type of the model, from a `$ref` to its schema.
    ///
    /// Every `$ref` to a schema in `components.schemas`, or in the `$defs`
    /// of one, is a model, whatever the schema is, even a primitive. A
    /// generator that wants to write the type in place can use
    /// [`Model::ty`]. A `$ref` to anywhere else in the document is written
    /// in place, and is an error if it leads back to itself. A `$ref` to
    /// another document is an error.
    ///
    /// In OpenAPI 3.0, the keywords next to a `$ref` are ignored. From 3.1,
    /// keywords that only describe, such as `description`, keep the model,
    /// `nullable: true` makes a union of the model and [`Scalar::Null`],
    /// and any other keyword makes an [`Intersection`] of the model and the
    /// rest of the schema.
    Model(Model<'f>),
}

/// A type with no parts: a primitive, or any value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scalar {
    /// Any value: from a schema that does not constrain its type, such as
    /// `{}`, `true` or one with only a `description`, from content with no
    /// schema, and from the schemas that are not covered yet.
    Unknown,
    Null,
    Boolean,
    /// A string, with no format or one not listed here, such as `uri`.
    String,
    /// A string with format `uuid`.
    Uuid,
    /// An integer or number, of the size its format gives.
    Number(Number),
    /// A string with format `date-time`.
    DateTime,
    /// A string with format `date`.
    Date,
    /// A string with format `byte`, or with `contentEncoding: base64`:
    /// base64-encoded bytes. The value is text, the base64 of the bytes,
    /// unlike [`Binary`](Scalar::Binary).
    Bytes,
    /// A string with format `binary`: raw bytes, such as a file uploaded
    /// as a part of `multipart/form-data` or a whole
    /// `application/octet-stream` body. The value is the bytes themselves,
    /// not base64 text as for [`Bytes`](Scalar::Bytes).
    ///
    /// Format `binary` decides the type even with `contentEncoding:
    /// base64`.
    Binary,
}

/// The size of a [`Scalar::Number`], from the `format` of an `integer` or
/// `number` schema, as defined by the
/// [Format Registry](https://spec.openapis.org/registry/format/).
///
/// A schema with no format, or one that is not a size, has no size: an
/// `integer` is [`Int`](Number::Int) and a `number` is
/// [`Double`](Number::Double). The format decides the size whatever the
/// type, so a `number` with format `int32` is [`Int32`](Number::Int32).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Number {
    /// An `integer` with no format: an integer of no particular size.
    Int,
    /// Format `int8`: a signed 8-bit integer.
    Int8,
    /// Format `int16`: a signed 16-bit integer.
    Int16,
    /// Format `int32`: a signed 32-bit integer.
    Int32,
    /// Format `int64`: a signed 64-bit integer.
    Int64,
    /// Format `uint8`: an unsigned 8-bit integer.
    Uint8,
    /// Format `uint16`: an unsigned 16-bit integer.
    Uint16,
    /// Format `uint32`: an unsigned 32-bit integer.
    Uint32,
    /// Format `uint64`: an unsigned 64-bit integer.
    Uint64,
    /// Format `float`: a single-precision floating-point number.
    Float,
    /// Format `double`, or a `number` with no format: a double-precision
    /// floating-point number.
    Double,
}

impl Number {
    /// Reports whether the number is an integer, rather than
    /// [`Float`](Number::Float) or [`Double`](Number::Double).
    pub fn is_integer(self) -> bool {
        !matches!(self, Number::Float | Number::Double)
    }
}

/// The values of a [`Type::Enum`].
#[derive(Clone, Copy)]
pub struct Enum<'f> {
    forge: &'f Forge,
    values: &'f [EnumData],
}

/// A value of a [`Type::Enum`]. Null is never a value; see
/// [`Type::Enum`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EnumValue<'f> {
    String(&'f str),
    Number(f64),
    Boolean(bool),
}

/// The element type and limits of a [`Type::Array`].
#[derive(Clone, Copy)]
pub struct Array<'f> {
    forge: &'f Forge,
    data: &'f ArrayData,
}

/// The fields and other keys of a [`Type::Object`].
#[derive(Clone, Copy)]
pub struct Object<'f> {
    forge: &'f Forge,
    data: &'f ObjectData,
}

/// A property of an [`Object`].
#[derive(Clone, Copy)]
pub struct Field<'f> {
    forge: &'f Forge,
    pub(crate) data: &'f FieldData,
}

/// The members of a [`Type::Union`].
#[derive(Clone, Copy)]
pub struct Union<'f> {
    forge: &'f Forge,
    data: &'f UnionData,
}

/// The members of a [`Type::Intersection`].
#[derive(Clone, Copy)]
pub struct Intersection<'f> {
    forge: &'f Forge,
    members: &'f [TypeId],
}

/// The property whose value says which member of a [`Union`] a value is.
#[derive(Clone, Copy)]
pub struct Discriminator<'f> {
    forge: &'f Forge,
    data: &'f DiscriminatorData,
}

impl<'f> Type<'f> {
    /// Returns the type with ID `id` in `forge`.
    pub(crate) fn new(forge: &'f Forge, id: TypeId) -> Type<'f> {
        match &forge.types[id.index()] {
            TypeData::Scalar(scalar) => Type::Scalar(*scalar),
            TypeData::Enum(values) => Type::Enum(Enum {
                forge,
                values: forge.values.get(*values),
            }),
            TypeData::Array(data) => Type::Array(Array { forge, data }),
            TypeData::Object(data) => Type::Object(Object { forge, data }),
            TypeData::Union(data) => Type::Union(Union { forge, data }),
            TypeData::Intersection(members) => Type::Intersection(Intersection {
                forge,
                members: forge.members.get(*members),
            }),
            TypeData::Model(id) => Type::Model(forge.model(*id)),
        }
    }
}

impl<'f> Enum<'f> {
    /// Returns the values, which are all different, in the order the
    /// `enum` lists them. There is at least one.
    pub fn values(self) -> impl ExactSizeIterator<Item = EnumValue<'f>> {
        self.values.iter().map(move |value| value.get(&self.forge.strings))
    }
}

impl EnumData {
    /// Returns the value, whose string is in `strings`.
    pub(crate) fn get(self, strings: &Strings) -> EnumValue<'_> {
        match self {
            EnumData::String(s) => EnumValue::String(strings.get(s)),
            EnumData::Number(n) => EnumValue::Number(n),
            EnumData::Boolean(b) => EnumValue::Boolean(b),
        }
    }
}

impl<'f> Array<'f> {
    /// Returns the type of the elements.
    pub fn elem(self) -> Type<'f> {
        Type::new(self.forge, self.data.elem)
    }

    /// Returns the fewest elements the array can have: its `minItems`, or
    /// `None` if it is absent. An explicit zero is `Some(0)`.
    ///
    /// Reading and reference handling follow [`Array::max_items`]. Forge
    /// preserves the bounds without checking whether they are consistent.
    pub fn min_items(self) -> Option<u64> {
        self.data.min_items
    }

    /// Returns the most elements the array can have, or `None` if it has
    /// no limit.
    ///
    /// Corresponds to `maxItems` on the array's schema, which must be a
    /// non-negative integer: a number with no fractional part, such as
    /// `2.0`, is one, as JSON Schema says, and any other value, such as
    /// `-1`, `2.5` or `"2"`, is an error, on any schema. A `maxItems` on a
    /// schema that is not an array is read, and ignored.
    ///
    /// Each array schema is its own array, so two arrays of the same
    /// elements with different limits are never the same type. An array
    /// that is a model, reached by a `$ref`, has the limit of the model's
    /// schema, in [`Model::ty`]. A `maxItems` next to a `$ref` is not the
    /// array's: in OpenAPI 3.0 it is ignored, as every keyword next to a
    /// `$ref` is, and from 3.1, on its own, it keeps the model, as other
    /// keywords that only constrain a value do.
    pub fn max_items(self) -> Option<u64> {
        self.data.max_items
    }
}

impl<'f> Object<'f> {
    /// Returns the object `data` in `forge`.
    pub(crate) fn new(forge: &'f Forge, data: &'f ObjectData) -> Object<'f> {
        Object { forge, data }
    }

    /// Returns the fields, one for each property, in an unspecified order,
    /// except in a [`Method::request`](crate::Method::request) and in
    /// [`Method::headers`](crate::Method::headers).
    ///
    /// A property marked `x-stainless-skip: true`, or whose schema is
    /// `false`, has no field. A name in `required` that is not a property is
    /// ignored. Two fields with equal names are an error.
    pub fn fields(self) -> impl ExactSizeIterator<Item = Field<'f>> {
        let forge = self.forge;
        forge
            .fields
            .get(self.data.fields)
            .iter()
            .map(move |data| Field { forge, data })
    }

    /// Returns the type of the values under keys other than the fields, or
    /// `None` if the object allows no other keys.
    ///
    /// Corresponds to `additionalProperties`. Without it, an object with
    /// properties allows no other keys, and one without allows any, so
    /// `{type: object}` has [`Scalar::Unknown`] values. An object with no
    /// properties and `additionalProperties: false` is the empty object.
    /// `patternProperties` is ignored, since no type can say which keys
    /// match a pattern.
    ///
    /// The `unevaluatedProperties` of an `allOf` becomes one more member of
    /// the [`Intersection`]: an object with no fields and those values.
    pub fn extra(self) -> Option<Type<'f>> {
        Some(Type::new(self.forge, self.data.extra?))
    }
}

impl<'f> Field<'f> {
    /// Returns the property's name in the object, as it is sent.
    pub fn wire_name(self) -> &'f str {
        self.forge.strings.get(self.data.wire_name)
    }

    /// Returns the name of the field.
    ///
    /// Corresponds to the `x-fern-property-name` extension of the
    /// property, or its wire name if it has none.
    pub fn name(self) -> &'f Name {
        &self.forge.names[self.data.name.index()]
    }

    /// Reports whether the object must have the property.
    ///
    /// A field for a parameter is required when the parameter is, and a
    /// path parameter always is.
    pub fn is_required(self) -> bool {
        self.data.required
    }

    /// Returns the type of the property's value.
    pub fn ty(self) -> Type<'f> {
        Type::new(self.forge, self.data.ty)
    }

    /// Returns a description of the property, or an empty string if it has
    /// none.
    ///
    /// The description is the property's own `description`, or else that
    /// of the schema its `$ref` points to, following `$ref`s through any
    /// chain of them. From OpenAPI 3.1, a `description` next to a `$ref` is
    /// the property's own; in 3.0 it is ignored, as every keyword next to a
    /// `$ref` is. From 3.1 too, a description is an annotation that every
    /// schema applied in place gives, so without the others it is the first
    /// one of an `allOf` member, in order, each read the same way; a member
    /// of `anyOf` or `oneOf` applies only to some values, and gives none.
    /// It is never the `title`, unlike a
    /// [`Model::description`](crate::Model::description).
    ///
    /// A field for a parameter has the parameter's `description`, or else
    /// its schema's, as for a property. From OpenAPI 3.1, the `description`
    /// of a Reference Object to the parameter overrides the parameter's.
    /// The `body` field of a [`Method::request`](crate::Method::request)
    /// has the body's description, and a path template placeholder that no
    /// parameter declares has none.
    pub fn description(self) -> &'f str {
        self.forge.strings.get(self.data.description)
    }

    /// Reports whether the property is deprecated.
    ///
    /// A field for a parameter is deprecated when the parameter is, unless
    /// it is a path parameter, which a caller must always send.
    pub fn is_deprecated(self) -> bool {
        self.data.deprecated
    }

    /// Reports whether the field is read-only: the server sets the
    /// property, so a client should not send it, though the same model's
    /// field appears in responses.
    ///
    /// Corresponds to `readOnly: true` on the property's schema, or on the
    /// schema its `$ref` points to, following `$ref`s through any chain of
    /// them: the field is read-only if any of them says so, and a
    /// `readOnly: false` does not undo another's `true`. From OpenAPI 3.1,
    /// a `readOnly` next to a `$ref` is the property's own; in 3.0 it is
    /// ignored, as every keyword next to a `$ref` is. A value that is not a
    /// boolean is an error.
    ///
    /// Forge keeps a read-only field in its object: a model is the same
    /// object in requests and responses, so the field cannot be dropped
    /// from one without the other. A generator decides to leave read-only
    /// fields out of what a client sends, such as a request body.
    ///
    /// A field for a parameter is never read-only, even when its schema is
    /// marked `readOnly`, since a client sends every parameter. That
    /// includes a field in [`Method::headers`](crate::Method::headers) and
    /// a property of the object of an `in: querystring` parameter. Nor is
    /// the `body` field of a [`Method::request`](crate::Method::request),
    /// or a path template placeholder that no parameter declares.
    pub fn is_read_only(self) -> bool {
        self.data.read_only
    }

    /// Reports whether the field holds a secret, such as a password or a
    /// token, which a client should mask when it shows it.
    ///
    /// Corresponds to the `x-sensitive: true` extension on the property's
    /// schema, or on any schema along its chain of `$ref`s. Unlike
    /// `readOnly`, an `x-sensitive` next to a `$ref` counts in every
    /// version of OpenAPI, since tools commonly honour extensions there. A
    /// value that is not a boolean is an error, as it is for a schema's
    /// `x-stainless-skip` and an operation's `x-forge-hidden`.
    ///
    /// A field for a parameter, whether in the request or in
    /// [`Method::headers`](crate::Method::headers), is sensitive when the
    /// parameter's schema is, in the same way: `x-sensitive` next to its
    /// `$ref` or along its chain. An `x-sensitive` on the Parameter Object
    /// itself, rather than its schema, is ignored. The `body` field of a
    /// request, and a path template placeholder that no parameter
    /// declares, are never sensitive.
    pub fn is_sensitive(self) -> bool {
        self.data.sensitive
    }

    /// Returns the default of the property: the value to take for it when
    /// it is left out, or `None` if there is none. `default: null` is
    /// `Some(&Json::Null)`, apart from no default.
    ///
    /// Corresponds to `default` on the property's schema, or else on the
    /// schema its `$ref` points to, following `$ref`s through any chain of
    /// them: the first one along the way. From OpenAPI 3.1, a `default`
    /// next to a `$ref` is the property's own; in 3.0 it is ignored, as
    /// every keyword next to a `$ref` is. A `default` inside `allOf`,
    /// `anyOf` or `oneOf` members is not read.
    ///
    /// Forge keeps the default as written, and does not check it against
    /// the schema: a default that the field's type does not allow, such as
    /// a string for an integer, is returned all the same.
    ///
    /// A field for a parameter, whether in the request or in
    /// [`Method::headers`](crate::Method::headers), has the default of the
    /// parameter's schema, in the same way, since the Parameter Object has
    /// no `default` of its own: one written on it is ignored. The `body`
    /// field of a [`Method::request`](crate::Method::request), and a path
    /// template placeholder that no parameter declares, have none.
    pub fn default(self) -> Option<&'f Json> {
        Some(&self.forge.defaults[self.data.default?.index()])
    }
}

impl<'f> Union<'f> {
    /// Returns the members, in an unspecified order.
    ///
    /// A union has at least two members, which are all different, and at
    /// most one of them is an enum. Only a union with a discriminator is a
    /// member of another union, which then has no discriminator.
    pub fn members(self) -> impl ExactSizeIterator<Item = Type<'f>> {
        let forge = self.forge;
        forge
            .members
            .get(self.data.members)
            .iter()
            .map(move |&id| Type::new(forge, id))
    }

    /// Reports whether a value is at most one of the members, so that the
    /// members exclude each other.
    ///
    /// A union from `oneOf` is exclusive, and so is one from a `type` that
    /// lists more than one type, or from null and another type, since a
    /// value has one JSON type. A union from `anyOf` is not, since a value
    /// can be more than one of its members. A union with a member that
    /// is a union without a discriminator has that union's members, and is
    /// exclusive only if both are.
    pub fn is_exclusive(self) -> bool {
        self.data.exclusive
    }

    /// Returns the property that says which member a value is, or `None`
    /// if there is none.
    pub fn discriminator(self) -> Option<Discriminator<'f>> {
        let data = self.data.discriminator.as_ref()?;
        Some(Discriminator {
            forge: self.forge,
            data,
        })
    }
}

impl<'f> Intersection<'f> {
    /// Returns the members, in an unspecified order, except in a
    /// [`Method::request`](crate::Method::request).
    pub fn members(self) -> impl ExactSizeIterator<Item = Type<'f>> {
        self.members.iter().map(move |&id| Type::new(self.forge, id))
    }
}

impl<'f> Discriminator<'f> {
    /// Returns the property's name in the object, as it is sent.
    pub fn wire_name(self) -> &'f str {
        self.forge.strings.get(self.data.wire_name)
    }

    /// Returns the name of the property's field: the
    /// `x-fern-property-name` of the property in the members, or else its
    /// wire name.
    pub fn name(self) -> &'f Name {
        &self.data.name
    }

    /// Returns each value of the property and the member of the union it
    /// says a value is, in an unspecified order. A member is a
    /// [`Type::Model`], or an object written in place.
    ///
    /// The cases come from `mapping`, whose values are a `$ref` or a schema
    /// name. A member the mapping leaves out has a case for the one value
    /// of an `enum` on its property, or else, for a model, for its schema
    /// name.
    pub fn cases(self) -> impl ExactSizeIterator<Item = (&'f str, Type<'f>)> {
        let forge = self.forge;
        self.data
            .cases
            .iter()
            .map(move |&(value, id)| (forge.strings.get(value), Type::new(forge, id)))
    }

    /// Returns the model of a value whose property is missing or matches
    /// no case, or `None` if there is none.
    ///
    /// Corresponds to `defaultMapping` in the
    /// [Discriminator Object](https://spec.openapis.org/oas/latest.html#discriminator-object),
    /// added in OpenAPI 3.2.
    pub fn default(self) -> Option<Model<'f>> {
        Some(self.forge.model(self.data.default?))
    }
}

/// The index of a type's data in its `Forge`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TypeId(pub(crate) u32);

impl TypeId {
    pub(crate) fn index(self) -> usize {
        self.0 as usize
    }
}

/// The index of a name in its `Forge`. Names are kept once each, so two
/// names are equal when their IDs are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct NameId(pub(crate) u32);

impl NameId {
    pub(crate) fn index(self) -> usize {
        self.0 as usize
    }
}

/// What a [`Forge`] stores for a type. The types inside it are stored
/// separately, by ID, and its lists in the `Forge`'s arenas.
pub(crate) enum TypeData {
    Scalar(Scalar),
    Enum(Span<EnumData>),
    Array(ArrayData),
    Object(ObjectData),
    Union(UnionData),
    Intersection(Span<TypeId>),
    Model(ModelId),
}

/// What a [`Forge`] stores for an [`EnumValue`].
#[derive(Clone, Copy)]
pub(crate) enum EnumData {
    String(Str),
    Number(f64),
    Boolean(bool),
}

#[derive(Clone, Copy)]
pub(crate) struct ArrayData {
    pub(crate) elem: TypeId,
    /// The `minItems`, if the schema specifies it.
    pub(crate) min_items: Option<u64>,
    /// The `maxItems`, if the array has a limit.
    pub(crate) max_items: Option<u64>,
}

#[derive(Clone, Copy)]
pub(crate) struct ObjectData {
    pub(crate) fields: Span<FieldData>,
    /// The type of the values under other keys, if it allows them.
    pub(crate) extra: Option<TypeId>,
}

pub(crate) struct FieldData {
    pub(crate) wire_name: Str,
    pub(crate) name: NameId,
    pub(crate) required: bool,
    pub(crate) ty: TypeId,
    pub(crate) description: Str,
    pub(crate) deprecated: bool,
    pub(crate) read_only: bool,
    pub(crate) sensitive: bool,
    /// The default, in `Forge::defaults`.
    pub(crate) default: Option<Id<Json>>,
}

pub(crate) struct UnionData {
    pub(crate) members: Span<TypeId>,
    /// Whether a value is at most one of the members.
    pub(crate) exclusive: bool,
    /// Most unions have none.
    pub(crate) discriminator: Option<DiscriminatorData>,
}

pub(crate) struct DiscriminatorData {
    pub(crate) wire_name: Str,
    pub(crate) name: Name,
    /// Each value of the property and the member it names.
    pub(crate) cases: Vec<(Str, TypeId)>,
    /// The model of a value that matches no case.
    pub(crate) default: Option<ModelId>,
}

impl fmt::Debug for Enum<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.values()).finish()
    }
}

impl fmt::Debug for Array<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.elem().fmt(f)
    }
}

impl fmt::Debug for Object<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Object")
            .field("fields", &self.fields().collect::<Vec<_>>())
            .field("extra", &self.extra())
            .finish()
    }
}

impl fmt::Debug for Field<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Field")
            .field("wire_name", &self.wire_name())
            .field("required", &self.is_required())
            .field("ty", &self.ty())
            .finish()
    }
}

impl fmt::Debug for Union<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Union")
            .field("members", &self.members().collect::<Vec<_>>())
            .field("exclusive", &self.is_exclusive())
            .field("discriminator", &self.discriminator())
            .finish()
    }
}

impl fmt::Debug for Intersection<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Intersection")
            .field("members", &self.members().collect::<Vec<_>>())
            .finish()
    }
}

impl fmt::Debug for Discriminator<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Discriminator")
            .field("wire_name", &self.wire_name())
            .field("cases", &self.cases().collect::<Vec<_>>())
            .field("default", &self.default())
            .finish()
    }
}
