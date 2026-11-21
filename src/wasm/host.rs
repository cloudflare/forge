//! Runs plugins compiled to WebAssembly components: the host side of the
//! WIT's `plugin` world.

use std::borrow::Cow;
use std::path::Path;

use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use super::types::ForgeWasm;
use crate::{Err, File, Forge, Plugin};

/// Private bindgen shim mapping `forge:plugin/forge` to [`ForgeWasm`].
/// `wasmtime::component::bindgen!` expects any remapped interface module to
/// expose `Host`, `HostWithStore`, and `add_to_linker` even for type-only
/// interfaces; keeping them inside private `host` keeps them out of `forge`'s
/// public API.
pub mod wit_forge {
    pub use crate::wasm::types::ForgeWasm as Forge;

    #[expect(dead_code, reason = "referenced by wasmtime::component::bindgen!")]
    pub trait Host {}

    #[expect(dead_code, reason = "referenced by wasmtime::component::bindgen!")]
    pub trait HostWithStore<T>: wasmtime::component::HasData {}

    impl<T, D: wasmtime::component::HasData> HostWithStore<T> for D {}

    #[expect(dead_code, reason = "referenced by wasmtime::component::bindgen!")]
    pub fn add_to_linker<T, D>(
        _linker: &mut wasmtime::component::Linker<T>,
        _host_getter: fn(&mut T) -> D::Data<'_>,
    ) -> wasmtime::Result<()>
    where
        D: HostWithStore<T>,
        for<'a> D::Data<'a>: Host,
        T: 'static,
    {
        Ok(())
    }
}

mod bindings {
    wasmtime::component::bindgen!({
        path: "src/wasm/forge.wit",
        world: "plugin",
        with: { "forge:plugin/forge": super::wit_forge },
    });
}

/// A plugin compiled to a WebAssembly component of the `plugin` world in
/// [`WIT`](super::WIT).
///
/// It compiles the component once, and makes a new instance for each call
/// of [`generate`](Plugin::generate).
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
        let pre = linker.instantiate_pre(&component).map_err(error)?;
        let pre = bindings::PluginPre::new(pre).map_err(error)?;

        Ok(WasmPlugin { engine, pre })
    }
}

impl Plugin for WasmPlugin {
    type File = WasmFile;

    /// Calls the plugin's `generate` in a new instance with `forge`.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = WasmFile>, Err> {
        let state = State {
            wasi: WasiCtx::builder().inherit_stderr().build(),
            table: ResourceTable::new(),
        };
        let mut store = Store::new(&self.engine, state);
        let plugin = self.pre.instantiate(&mut store).map_err(error)?;
        let wasm_forge = ForgeWasm::from(forge);
        let files = plugin.call_generate(&mut store, &wasm_forge).map_err(error)??;
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

/// WASI state for a plugin instance.
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
