//! Runs plugins compiled to WebAssembly components: the host side of the
//! WIT's `plugin` world, passing a single `capnstruct`-encoded [`Forge`]
//! buffer with zero host callbacks and zero `unsafe` code.

use std::borrow::Cow;
use std::path::Path;

use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use super::records::pack_forge;
use crate::{Err, File, Forge, Plugin};

mod bindings {
    wasmtime::component::bindgen!({
        path: "src/wasm/forge.wit",
        world: "plugin",
    });
}

/// A plugin compiled to a WebAssembly component of the `plugin` world in
/// [`WIT`](super::WIT).
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
    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, Err> {
        let path = path.as_ref();
        let wasm = std::fs::read(path).map_err(|err| format!("{}: {err}", path.display()))?;
        Self::new(&wasm).map_err(|err| format!("{}: {err}", path.display()).into())
    }

    /// Compiles the component `wasm`, in the binary format.
    pub fn new(wasm: &[u8]) -> Result<Self, Err> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        let engine = Engine::new(&config).map_err(error)?;
        let component = Component::new(&engine, wasm).map_err(error)?;

        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(error)?;
        let pre = linker.instantiate_pre(&component).map_err(error)?;
        let pre = bindings::PluginPre::new(pre).map_err(error)?;
        Ok(Self { engine, pre })
    }
}

impl Plugin for WasmPlugin {
    type File = WasmFile;

    /// Packs `forge` into a single `capnstruct` buffer and runs `generate` in
    /// a fresh component instance.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = Self::File>, Err> {
        let bytes = pack_forge(forge);
        let state = State {
            wasi: WasiCtx::builder().inherit_stderr().build(),
            table: ResourceTable::new(),
        };
        let mut store = Store::new(&self.engine, state);
        let plugin = self.pre.instantiate(&mut store).map_err(error)?;
        let files = plugin
            .call_generate(&mut store, &bytes)
            .map_err(error)?
            .map_err(Err::from)?;
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

struct State {
    wasi: WasiCtx,
    table: ResourceTable,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// Turns a wasmtime error into an [`Err`], keeping its causes and any
/// backtrace of the plugin.
fn error(err: wasmtime::Error) -> Err {
    format!("{err:?}").into()
}
