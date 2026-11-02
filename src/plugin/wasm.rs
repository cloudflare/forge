//! Runs plugins compiled to WebAssembly components, in any language that
//! targets the component model.
//!
//! A plugin is a component of the `plugin` world in [`WIT`]. It exports
//! `generate` and `generate-group`, which [`WasmPlugin`] calls where
//! [`Plugin::generate`] and [`Plugin::generate_group`] are, and imports
//! the `forge` interface, which reads the [`Forge`] the host runs it on.
//!
//! The forge is never copied into a plugin. It stays in the host, and the
//! plugin reads it a part at a time through ids: a group, method, model or
//! type is a `u32`, and the plugin calls `get-group`, `get-method`,
//! `get-model` or `get-type` for the part's data. Groups run in parallel,
//! each in an instance of its own, and every instance reads the same
//! forge.
//!
//! A plugin gets no files, network, environment or clock, only standard
//! error, so it can print why it panicked.
//!
//! ```no_run
//! # fn main() -> Result<(), forge::Err> {
//! # let forge = forge::Forge::default();
//! let plugin = forge::wasm::WasmPlugin::from_file("ts.wasm")?;
//! forge::write("sdk", forge::run(&forge, &plugin)?)?;
//! # Ok(())
//! # }
//! ```

use std::borrow::Cow;
use std::path::Path;
use std::ptr;
use std::sync::Mutex;

use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use crate::arena::Str;
use crate::method::{ContentData, ResponseData};
use crate::types::{EnumData, FieldData, TypeData};
use crate::{Availability, Err, File, Forge, Group, HttpMethod, Json, Location, Name, Number, Plugin, Scalar};

/// Defines [`WIT`] and its host bindings from one copy of the text.
macro_rules! wit {
    ($wit:literal) => {
        /// The WIT package of the `plugin` world that plugins are components
        /// of. Plugins in other languages generate their bindings from it.
        pub const WIT: &str = $wit;

        mod bindings {
            wasmtime::component::bindgen!({
                inline: $wit,
                world: "plugin",
                // A plugin that passes an id the host never gave out traps,
                // rather than panicking the host.
                imports: { default: trappable },
            });
        }
    };
}

wit!(
    r#"
package forge:plugin@0.3.0;

/// Read-only access to the forge a plugin runs on, which the host keeps.
/// Each id is an index the host gave out. An id the host never gave out
/// traps.
///
/// Everything a part has is returned in one call, and orders and meanings
/// are as the Rust API documents them.
interface forge {
    type group-id = u32;
    type method-id = u32;
    type model-id = u32;
    type type-id = u32;

    /// The lower-case words of a `Name`.
    type name = list<string>;

    /// A JSON value, which forge keeps without reading, as JSON text that
    /// `JSON.parse` reads back: an object's members in the order they are
    /// written, each key once. WIT has no recursive types, so a value is
    /// its text.
    type json = string;

    record forge-info {
        version: string,
        description: string,
        base-url: string,
    }

    /// How many of each part the forge has. Ids run from 0 to the count.
    record forge-counts {
        groups: u32,
        methods: u32,
        models: u32,
        types: u32,
    }

    record group-info {
        name: name,
        description: string,
        /// The groups from the top level down to this one, ending with it.
        path: list<group-id>,
        /// The groups directly inside, sorted by name.
        children: list<group-id>,
        /// The methods directly inside, sorted by name.
        methods: list<method-id>,
        models: list<model-id>,
    }

    variant http-method {
        get, put, post, delete, options, head, patch, trace, query, connect,
        other(string),
    }

    variant location {
        path,
        /// Whether the parameter is exploded.
        query(bool),
    }

    record content-info {
        media-type: string,
        ty: type-id,
        /// The description of the content's schema.
        description: string,
    }

    record body-info {
        required: bool,
        description: string,
        contents: list<content-info>,
        /// The index in `contents` of the JSON content.
        json: option<u32>,
    }

    record response-info {
        status: string,
        description: string,
        contents: list<content-info>,
        /// The index in `contents` of the JSON content.
        json: option<u32>,
    }

    /// The stage of the API a method is in, from `x-forge-availability`.
    enum availability {
        alpha, beta, preview, generally-available, deprecated,
    }

    record method-info {
        name: name,
        group: group-id,
        http-method: http-method,
        path: string,
        summary: string,
        description: string,
        deprecated: bool,
        availability: option<availability>,
        /// Whether to leave the method out of listings, from `x-forge-hidden`.
        hidden: bool,
        /// The sentence to show before calling the method, from
        /// `x-forge-require-confirmation`, or none if it needs no
        /// confirmation.
        confirmation: option<string>,
        request: option<type-id>,
        /// The header parameters: an object type, with a field for each.
        /// Its fields have no location.
        headers: option<type-id>,
        body: option<body-info>,
        responses: list<response-info>,
        errors: list<response-info>,
        /// The extensions of the operation, or alias, that forge does not
        /// read itself, in the order they are written.
        extensions: list<tuple<string, json>>,
    }

    record model-info {
        schema-name: string,
        name: name,
        group: option<group-id>,
        description: string,
        deprecated: bool,
        ty: type-id,
    }

    enum number {
        int, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float, double,
    }

    variant scalar {
        unknown, null, boolean, %string, number(number), date-time, date, bytes, binary, uuid,
    }

    variant enum-value {
        %string(string),
        number(f64),
        boolean(bool),
    }

    record field-info {
        wire-name: string,
        name: name,
        required: bool,
        ty: type-id,
        description: string,
        deprecated: bool,
        /// Whether the server sets the property, so a client doesn't send it.
        read-only: bool,
        /// Whether the value is a secret, such as a password or a token.
        sensitive: bool,
        /// The `default` of the property's schema.
        default: option<json>,
    }

    record array-info {
        elem: type-id,
        /// The `minItems`, or none if it is absent; zero is kept.
        min-items: option<u64>,
        /// The `maxItems`, or none if the array has no limit.
        max-items: option<u64>,
    }

    record object-info {
        fields: list<field-info>,
        extra: option<type-id>,
    }

    record discriminator-info {
        wire-name: string,
        name: name,
        cases: list<tuple<string, type-id>>,
        default: option<model-id>,
    }

    record union-info {
        members: list<type-id>,
        /// Whether a value is at most one of the members.
        exclusive: bool,
        discriminator: option<discriminator-info>,
    }

    variant type-info {
        scalar(scalar),
        %enum(list<enum-value>),
        array(array-info),
        object(object-info),
        union(union-info),
        intersection(list<type-id>),
        model(model-id),
    }

    info: func() -> forge-info;
    counts: func() -> forge-counts;
    /// Every group, depth first.
    groups: func() -> list<group-id>;
    /// The models at the top level, in no group.
    models: func() -> list<model-id>;
    get-group: func(id: group-id) -> group-info;
    get-method: func(id: method-id) -> method-info;
    get-model: func(id: model-id) -> model-info;
    get-type: func(id: type-id) -> type-info;
    /// Where method `id` sends field `index` of the object type `object`,
    /// or none if it is not one of its parameters.
    get-location: func(id: method-id, object: type-id, index: u32) -> option<location>;
}

world plugin {
    import forge;
    use forge.{group-id};

    /// A generated file: its path relative to the output directory, using
    /// `/` as a separator, and its content. A file with no content is not
    /// written.
    record file {
        path: string,
        content: list<u8>,
    }

    /// Generates files for the forge. Called exactly once.
    export generate: func() -> result<list<file>, string>;
    /// Generates files for a group. Called exactly once for each group, in
    /// parallel with other groups, each in an instance of its own.
    export generate-group: func(group: group-id) -> result<list<file>, string>;
}
"#
);

use bindings::forge::plugin::forge as wit;

/// A plugin compiled to a WebAssembly component of the `plugin` world in
/// [`WIT`].
///
/// It compiles the component once, then keeps a pool of instances, so
/// groups run in parallel without compiling or instantiating it again. A
/// call takes an instance from the pool, or makes one if none is free, and
/// returns it unless the plugin trapped.
pub struct WasmPlugin {
    engine: Engine,
    pre: bindings::PluginPre<State>,
    pool: Mutex<Vec<Instance>>,
}

/// A file a [`WasmPlugin`] generated, with its content already rendered.
pub struct WasmFile {
    pub path: String,
    pub content: Vec<u8>,
}

impl WasmPlugin {
    /// Compiles the component in the file at `path`.
    pub fn from_file(path: impl AsRef<Path>) -> Result<WasmPlugin, Err> {
        let path = path.as_ref();
        let wasm = std::fs::read(path).map_err(|err| format!("{}: {err}", path.display()))?;
        WasmPlugin::new(&wasm).map_err(|err| format!("{}: {err}", path.display()).into())
    }

    /// Compiles the component `wasm`, in the binary format.
    pub fn new(wasm: &[u8]) -> Result<WasmPlugin, Err> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        let engine = Engine::new(&config).map_err(error)?;
        let component = Component::new(&engine, wasm).map_err(error)?;

        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(error)?;
        bindings::Plugin::add_to_linker::<State, HasSelf<State>>(&mut linker, |state| state).map_err(error)?;
        let pre = linker.instantiate_pre(&component).map_err(error)?;
        let pre = bindings::PluginPre::new(pre).map_err(error)?;

        Ok(WasmPlugin {
            engine,
            pre,
            pool: Mutex::new(Vec::new()),
        })
    }

    /// Calls `f` with an instance that reads `forge`.
    fn call(
        &self,
        forge: &Forge,
        f: impl FnOnce(&bindings::Plugin, &mut Store<State>) -> wasmtime::Result<Result<Vec<bindings::File>, String>>,
    ) -> Result<std::vec::IntoIter<WasmFile>, Err> {
        let pooled = self.pool.lock().unwrap_or_else(|err| err.into_inner()).pop();
        let mut instance = match pooled {
            Some(instance) => instance,
            None => self.instantiate()?,
        };

        instance.store.data_mut().forge = forge;
        let result = f(&instance.plugin, &mut instance.store);
        instance.store.data_mut().forge = ptr::null();

        // A trap can leave the instance broken, so it is dropped instead.
        let files = result.map_err(error)?;
        self.pool.lock().unwrap_or_else(|err| err.into_inner()).push(instance);

        let files = files?.into_iter().map(|file| WasmFile {
            path: file.path,
            content: file.content,
        });
        Ok(files.collect::<Vec<_>>().into_iter())
    }

    fn instantiate(&self) -> Result<Instance, Err> {
        let state = State {
            forge: ptr::null(),
            wasi: WasiCtx::builder().inherit_stderr().build(),
            table: ResourceTable::new(),
        };
        let mut store = Store::new(&self.engine, state);
        let plugin = self.pre.instantiate(&mut store).map_err(error)?;
        Ok(Instance { store, plugin })
    }
}

impl Plugin for WasmPlugin {
    type File = WasmFile;

    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = WasmFile>, Err> {
        self.call(forge, |plugin, store| plugin.call_generate(store))
    }

    fn generate_group(&self, group: Group<'_>) -> Result<impl Iterator<Item = WasmFile>, Err> {
        self.call(group.forge, |plugin, store| {
            plugin.call_generate_group(store, group.id.0)
        })
    }
}

impl File for WasmFile {
    fn path(&self) -> &str {
        &self.path
    }

    fn content(&self) -> Result<Cow<'_, [u8]>, Err> {
        Ok(Cow::Borrowed(&self.content))
    }
}

/// An instance of a plugin, and the store it lives in.
struct Instance {
    store: Store<State>,
    plugin: bindings::Plugin,
}

/// What an instance's host functions get.
struct State {
    /// The forge of the call running in the instance, or null between
    /// calls.
    forge: *const Forge,
    wasi: WasiCtx,
    table: ResourceTable,
}

// SAFETY: `forge` is only read through `&Forge`, which is `Send` since
// `Forge` is `Sync`. Everything else in `State` is `Send`.
unsafe impl Send for State {}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl State {
    /// Returns the forge of the call running in the instance.
    fn forge(&self) -> wasmtime::Result<&Forge> {
        // SAFETY: `WasmPlugin::call` sets `forge` from a `&Forge` that
        // outlives the call, and resets it to null before returning. Host
        // functions only run during the call, while the plugin runs.
        unsafe { self.forge.as_ref() }.ok_or_else(|| wasmtime::format_err!("no forge outside a call"))
    }
}

impl wit::Host for State {
    fn info(&mut self) -> wasmtime::Result<wit::ForgeInfo> {
        let forge = self.forge()?;
        Ok(wit::ForgeInfo {
            version: forge.version.clone(),
            description: forge.description.clone(),
            base_url: forge.base_url.clone(),
        })
    }

    fn counts(&mut self) -> wasmtime::Result<wit::ForgeCounts> {
        let forge = self.forge()?;
        Ok(wit::ForgeCounts {
            groups: forge.groups.len() as u32,
            methods: forge.methods.len() as u32,
            models: forge.models.len() as u32,
            types: forge.types.len() as u32,
        })
    }

    fn groups(&mut self) -> wasmtime::Result<Vec<u32>> {
        Ok(self.forge()?.groups().map(|group| group.id.0).collect())
    }

    fn models(&mut self) -> wasmtime::Result<Vec<u32>> {
        Ok(self.forge()?.top_models.iter().map(|id| id.0).collect())
    }

    fn get_group(&mut self, id: u32) -> wasmtime::Result<wit::GroupInfo> {
        let forge = self.forge()?;
        let data = get(&forge.groups, id, "group")?;
        Ok(wit::GroupInfo {
            name: words(&data.name),
            description: data.description.clone(),
            path: data.path.iter().map(|id| id.0).collect(),
            children: data.groups.iter().map(|id| id.0).collect(),
            methods: data.methods.iter().map(|id| id.0).collect(),
            models: data.models.iter().map(|id| id.0).collect(),
        })
    }

    fn get_method(&mut self, id: u32) -> wasmtime::Result<wit::MethodInfo> {
        let forge = self.forge()?;
        let data = get(&forge.methods, id, "method")?;
        let s = |s: Str| forge.strings.get(s).to_owned();
        Ok(wit::MethodInfo {
            name: words(&data.name),
            group: data.group.0,
            http_method: match &data.http_method {
                HttpMethod::Get => wit::HttpMethod::Get,
                HttpMethod::Put => wit::HttpMethod::Put,
                HttpMethod::Post => wit::HttpMethod::Post,
                HttpMethod::Delete => wit::HttpMethod::Delete,
                HttpMethod::Options => wit::HttpMethod::Options,
                HttpMethod::Head => wit::HttpMethod::Head,
                HttpMethod::Patch => wit::HttpMethod::Patch,
                HttpMethod::Trace => wit::HttpMethod::Trace,
                HttpMethod::Query => wit::HttpMethod::Query,
                HttpMethod::Connect => wit::HttpMethod::Connect,
                HttpMethod::Other(method) => wit::HttpMethod::Other(method.clone()),
            },
            path: s(data.path),
            summary: s(data.summary),
            description: s(data.description),
            deprecated: data.deprecated,
            availability: data.availability.map(|availability| match availability {
                Availability::Alpha => wit::Availability::Alpha,
                Availability::Beta => wit::Availability::Beta,
                Availability::Preview => wit::Availability::Preview,
                Availability::GenerallyAvailable => wit::Availability::GenerallyAvailable,
                Availability::Deprecated => wit::Availability::Deprecated,
            }),
            hidden: data.hidden,
            confirmation: data.confirmation.map(s),
            request: data.request.map(|id| id.0),
            headers: data.headers.map(|id| id.0),
            body: data.body.as_ref().map(|body| wit::BodyInfo {
                required: body.required,
                description: s(body.description),
                contents: contents(forge, &body.contents),
                json: body.json,
            }),
            responses: data.responses.iter().map(|data| response(forge, data)).collect(),
            errors: data.errors.iter().map(|data| response(forge, data)).collect(),
            extensions: forge
                .extensions
                .get(data.extensions)
                .iter()
                .map(|(name, value)| (name.clone(), json(value)))
                .collect(),
        })
    }

    fn get_model(&mut self, id: u32) -> wasmtime::Result<wit::ModelInfo> {
        let forge = self.forge()?;
        let data = get(&forge.models, id, "model")?;
        Ok(wit::ModelInfo {
            schema_name: forge.strings.get(data.schema_name).to_owned(),
            name: words(&data.name),
            group: data.group.map(|id| id.0),
            description: forge.strings.get(data.description).to_owned(),
            deprecated: data.deprecated,
            ty: data.ty.0,
        })
    }

    fn get_type(&mut self, id: u32) -> wasmtime::Result<wit::TypeInfo> {
        let forge = self.forge()?;
        let s = |s: Str| forge.strings.get(s).to_owned();
        Ok(match get(&forge.types, id, "type")? {
            TypeData::Scalar(scalar) => wit::TypeInfo::Scalar(match *scalar {
                Scalar::Unknown => wit::Scalar::Unknown,
                Scalar::Null => wit::Scalar::Null,
                Scalar::Boolean => wit::Scalar::Boolean,
                Scalar::String => wit::Scalar::String,
                Scalar::Uuid => wit::Scalar::Uuid,
                Scalar::Number(number) => wit::Scalar::Number(match number {
                    Number::Int => wit::Number::Int,
                    Number::Int8 => wit::Number::Int8,
                    Number::Int16 => wit::Number::Int16,
                    Number::Int32 => wit::Number::Int32,
                    Number::Int64 => wit::Number::Int64,
                    Number::Uint8 => wit::Number::Uint8,
                    Number::Uint16 => wit::Number::Uint16,
                    Number::Uint32 => wit::Number::Uint32,
                    Number::Uint64 => wit::Number::Uint64,
                    Number::Float => wit::Number::Float,
                    Number::Double => wit::Number::Double,
                }),
                Scalar::DateTime => wit::Scalar::DateTime,
                Scalar::Date => wit::Scalar::Date,
                Scalar::Bytes => wit::Scalar::Bytes,
                Scalar::Binary => wit::Scalar::Binary,
            }),
            TypeData::Enum(values) => wit::TypeInfo::Enum(
                forge
                    .values
                    .get(*values)
                    .iter()
                    .map(|value| match *value {
                        EnumData::String(value) => wit::EnumValue::String(s(value)),
                        EnumData::Number(value) => wit::EnumValue::Number(value),
                        EnumData::Boolean(value) => wit::EnumValue::Boolean(value),
                    })
                    .collect(),
            ),
            TypeData::Array(array) => wit::TypeInfo::Array(wit::ArrayInfo {
                elem: array.elem.0,
                min_items: array.min_items,
                max_items: array.max_items,
            }),
            TypeData::Object(object) => wit::TypeInfo::Object(wit::ObjectInfo {
                fields: forge
                    .fields
                    .get(object.fields)
                    .iter()
                    .map(|field| wit::FieldInfo {
                        wire_name: s(field.wire_name),
                        name: words(&forge.names[field.name.index()]),
                        required: field.required,
                        ty: field.ty.0,
                        description: s(field.description),
                        deprecated: field.deprecated,
                        read_only: field.read_only,
                        sensitive: field.sensitive,
                        default: field.default.map(|id| json(&forge.defaults[id.index()])),
                    })
                    .collect(),
                extra: object.extra.map(|id| id.0),
            }),
            TypeData::Union(union) => wit::TypeInfo::Union(wit::UnionInfo {
                members: forge.members.get(union.members).iter().map(|id| id.0).collect(),
                exclusive: union.exclusive,
                discriminator: union.discriminator.as_ref().map(|data| wit::DiscriminatorInfo {
                    wire_name: s(data.wire_name),
                    name: words(&data.name),
                    cases: data.cases.iter().map(|&(value, id)| (s(value), id.0)).collect(),
                    default: data.default.map(|id| id.0),
                }),
            }),
            TypeData::Intersection(members) => {
                wit::TypeInfo::Intersection(forge.members.get(*members).iter().map(|id| id.0).collect())
            }
            TypeData::Model(id) => wit::TypeInfo::Model(id.0),
        })
    }

    fn get_location(&mut self, id: u32, object: u32, index: u32) -> wasmtime::Result<Option<wit::Location>> {
        let forge = self.forge()?;
        let data = get(&forge.methods, id, "method")?;
        let TypeData::Object(object) = get(&forge.types, object, "type")? else {
            wasmtime::bail!("type {object} is not an object");
        };
        let field = get(forge.fields.get(object.fields), index, "field")?;

        // As in `Method::location`: the field must be one of the parameters
        // themselves, not a field like them.
        let Some(TypeData::Object(params)) = data.params.map(|id| &forge.types[id.index()]) else {
            return Ok(None);
        };
        let params: &[FieldData] = forge.fields.get(params.fields);
        let Some(i) = params.iter().position(|param| ptr::eq(param, field)) else {
            return Ok(None);
        };
        Ok(data.locations.get(i).map(|location| match *location {
            Location::Path => wit::Location::Path,
            Location::Query { exploded } => wit::Location::Query(exploded),
        }))
    }
}

/// Returns item `id` of `items`, or an error naming it as a `what`.
fn get<'a, T>(items: &'a [T], id: u32, what: &str) -> wasmtime::Result<&'a T> {
    items
        .get(id as usize)
        .ok_or_else(|| wasmtime::format_err!("no {what} with id {id}"))
}

fn words(name: &Name) -> Vec<String> {
    name.words().to_vec()
}

fn response(forge: &Forge, data: &ResponseData) -> wit::ResponseInfo {
    wit::ResponseInfo {
        status: forge.strings.get(data.status).to_owned(),
        description: forge.strings.get(data.description).to_owned(),
        contents: contents(forge, &data.contents),
        json: data.json,
    }
}

fn contents(forge: &Forge, contents: &[ContentData]) -> Vec<wit::ContentInfo> {
    contents
        .iter()
        .map(|data| wit::ContentInfo {
            media_type: forge.strings.get(data.media_type).to_owned(),
            ty: data.ty.0,
            description: forge.strings.get(data.description).to_owned(),
        })
        .collect()
}

/// Returns `value` as JSON text, which `JSON.parse` reads back as the same
/// value: an object's members in order, and a number as JavaScript writes
/// it when it is an integer it can hold exactly.
fn json(value: &Json) -> String {
    fn write(out: &mut String, value: &Json) {
        match value {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            // JSON can't write these, and reading JSON never makes them.
            Json::Number(n) if !n.is_finite() => out.push_str("null"),
            Json::Number(n) => {
                use std::fmt::Write;
                let _ = write!(out, "{n}");
            }
            Json::String(s) => string(out, s),
            Json::Array(elements) => {
                out.push('[');
                for (i, element) in elements.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(out, element);
                }
                out.push(']');
            }
            Json::Object(members) => {
                out.push('{');
                for (i, (key, value)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    string(out, key);
                    out.push(':');
                    write(out, value);
                }
                out.push('}');
            }
        }
    }
    fn string(out: &mut String, s: &str) {
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    use std::fmt::Write;
                    let _ = write!(out, "\\u{:04x}", c as u32);
                }
                c => out.push(c),
            }
        }
        out.push('"');
    }
    let mut out = String::new();
    write(&mut out, value);
    out
}

/// Turns a wasmtime error into an [`Err`], keeping its causes and any
/// backtrace of the plugin.
fn error(err: wasmtime::Error) -> Err {
    format!("{err:?}").into()
}

#[cfg(test)]
mod tests {
    use super::json;
    use crate::Json;

    /// Reads `text` as forge reads JSON.
    fn read(text: &str) -> Json {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn json_is_text_that_reads_back_as_the_value() {
        for text in [
            "null",
            "true",
            "false",
            "0",
            "-0",
            "1",
            "-12.5",
            "1e21",
            "0.0000001",
            "9007199254740993",
            r#""""#,
            r#""a \"quoted\" \\ line\nand\ttab\u0001 é 😀""#,
            "[]",
            "{}",
            r#"[1, [2, {"a": null}], "x"]"#,
            // Members keep their order, and a repeated key its last value
            // in the place of the first, as forge reads them.
            r#"{"b": 1, "a": {"z": [], "y": false}, "b": 2}"#,
        ] {
            let value = read(text);
            assert_eq!(read(&json(&value)), value, "{text} wrote {}", json(&value));
        }
    }

    #[test]
    fn json_is_compact_and_ordered() {
        assert_eq!(
            json(&read(r#"{ "b" : [1, 2.5], "a": "x" }"#)),
            r#"{"b":[1,2.5],"a":"x"}"#
        );
        assert_eq!(json(&read("1.0")), "1");
        assert_eq!(json(&read(r#""\u0001""#)), r#""\u0001""#);
    }
}
