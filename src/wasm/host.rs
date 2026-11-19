//! Runs plugins compiled to WebAssembly components: the host side of the
//! WIT's `plugin` world.

use std::borrow::Cow;
use std::path::Path;

use wasmtime::component::{Component, HasSelf, Linker, Resource, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use super::records::records;
use crate::types::TypeData;
use crate::{Err, File, Forge, Plugin};

mod bindings {
    wasmtime::component::bindgen!({
        path: "src/wasm/forge.wit",
        world: "plugin",
        // The host keeps the forge, so the resource a plugin reads holds
        // nothing of its own.
        with: { "forge:plugin/forge.forge": super::ForgeHandle },
        // A plugin that passes an id the host never gave out traps,
        // rather than panicking the host.
        imports: { default: trappable },
    });
}

use bindings::forge::plugin::forge as wit;

/// A plugin compiled to a WebAssembly component of the `plugin` world in
/// [`WIT`](super::WIT).
///
/// It compiles the component once, and makes a new instance for each call
/// of [`generate`](Plugin::generate), so an instance only ever reads one
/// [`Forge`].
pub struct WasmPlugin {
    engine: Engine,
    pre: bindings::PluginPre<State>,
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

        Ok(WasmPlugin { engine, pre })
    }
}

impl Plugin for WasmPlugin {
    type File = WasmFile;

    /// Calls the plugin's `generate` in a new instance that reads `forge`.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = WasmFile>, Err> {
        let state = State {
            forge,
            wasi: WasiCtx::builder().inherit_stderr().build(),
            table: ResourceTable::new(),
        };
        // The store, and the instance in it, are dropped before this
        // returns, so the plugin never reads `forge` after the call.
        let mut store = Store::new(&self.engine, state);
        let plugin = self.pre.instantiate(&mut store).map_err(error)?;
        let handle = store
            .data_mut()
            .table
            .push(ForgeHandle)
            .map_err(|err| err.to_string())?;
        let files = plugin.call_generate(&mut store, handle).map_err(error)??;
        Ok(files.into_iter().map(|file| WasmFile {
            path: file.path,
            content: file.content,
        }))
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

/// What an instance's host functions get.
struct State {
    /// The forge of the call the instance was made for. A store's data
    /// can't borrow, so it is a pointer.
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
    /// Returns the forge of the call the instance was made for.
    fn forge(&self) -> &Forge {
        // SAFETY: `WasmPlugin::generate` sets `forge` from a `&Forge` that
        // outlives the call, and drops the store before returning. Host
        // functions only run during the call, while the plugin runs.
        unsafe { &*self.forge }
    }
}

/// Holds the `forge` resource a plugin reads. The host keeps the forge in
/// the instance's [`State`], so the resource holds nothing of its own.
pub struct ForgeHandle;

impl wit::Host for State {}

impl wit::HostForge for State {
    fn info(&mut self, _: Resource<ForgeHandle>) -> wasmtime::Result<wit::ForgeInfo> {
        Ok(forge_info(self.forge()))
    }

    fn counts(&mut self, _: Resource<ForgeHandle>) -> wasmtime::Result<wit::ForgeCounts> {
        Ok(forge_counts(self.forge()))
    }

    fn groups(&mut self, _: Resource<ForgeHandle>) -> wasmtime::Result<Vec<u32>> {
        Ok(group_ids(self.forge()))
    }

    fn get_group(&mut self, _: Resource<ForgeHandle>, id: u32) -> wasmtime::Result<wit::GroupInfo> {
        Ok(group_info(get(&self.forge().groups, id, "group")?))
    }

    fn get_method(&mut self, _: Resource<ForgeHandle>, id: u32) -> wasmtime::Result<wit::MethodInfo> {
        let forge = self.forge();
        Ok(method_info(forge, get(&forge.methods, id, "method")?))
    }

    fn get_model(&mut self, _: Resource<ForgeHandle>, id: u32) -> wasmtime::Result<wit::ModelInfo> {
        let forge = self.forge();
        Ok(model_info(forge, get(&forge.models, id, "model")?))
    }

    fn get_type(&mut self, _: Resource<ForgeHandle>, id: u32) -> wasmtime::Result<wit::TypeInfo> {
        let forge = self.forge();
        Ok(type_info(forge, get(&forge.types, id, "type")?))
    }

    fn get_location(
        &mut self,
        _: Resource<ForgeHandle>,
        id: u32,
        object: u32,
        index: u32,
    ) -> wasmtime::Result<Option<wit::Location>> {
        let forge = self.forge();
        let method = get(&forge.methods, id, "method")?;
        let TypeData::Object(object) = get(&forge.types, object, "type")? else {
            wasmtime::bail!("type {object} is not an object");
        };
        let field = get(forge.fields.get(object.fields), index, "field")?;
        Ok(location(forge, method, field))
    }

    fn drop(&mut self, forge: Resource<ForgeHandle>) -> wasmtime::Result<()> {
        self.table.delete(forge)?;
        Ok(())
    }
}

records!();

/// Returns item `id` of `items`, or an error naming it as a `what`.
fn get<'a, T>(items: &'a [T], id: u32, what: &str) -> wasmtime::Result<&'a T> {
    items
        .get(id as usize)
        .ok_or_else(|| wasmtime::format_err!("no {what} with id {id}"))
}

/// Turns a wasmtime error into an [`Err`], keeping its causes and any
/// backtrace of the plugin.
fn error(err: wasmtime::Error) -> Err {
    format!("{err:?}").into()
}
