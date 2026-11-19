//! Runs plugins compiled to WebAssembly components, in any language that
//! targets the component model.
//!
//! A plugin is a component of the `plugin` world in [`WIT`]. It exports
//! `generate`, which [`WasmPlugin`] calls where [`Plugin::generate`](crate::Plugin::generate) is,
//! and reads the [`Forge`](crate::Forge) the host runs it on through the `forge` resource
//! that `generate` takes.
//!
//! The forge is never copied into a plugin. It stays in the host, and the
//! plugin reads it a part at a time through ids. A group, method, model or
//! type is a `u32`, and the plugin calls `get-group`, `get-method`,
//! `get-model` or `get-type` on the resource for the part's data. Each call of `generate`
//! runs in an instance of its own, on one thread: unlike a native plugin,
//! a wasm plugin can't generate groups in parallel.
//!
//! A plugin gets no files, network, environment or clock, only standard
//! error, so it can print why it panicked.
//!
//! ```no_run
//! # use forge::Plugin;
//! # fn main() -> Result<(), forge::Err> {
//! # let forge = forge::Forge::default();
//! let plugin = forge::wasm::WasmPlugin::from_file("ts.wasm")?;
//! forge::write("sdk", plugin.generate(&forge)?)?;
//! # Ok(())
//! # }
//! ```

//!
//! The same WIT has a `library` world, which `@cloudflare/forge` builds from
//! this crate to parse documents in JavaScript. It exports the `forge`
//! resource plugins read, so plugins and the library share one model.

#[cfg(feature = "wasm")]
mod host;
#[cfg(feature = "library")]
mod library;
mod records;

#[cfg(feature = "wasm")]
pub use host::{WasmFile, WasmPlugin};

/// Holds the WIT package that plugins and the library are built against.
/// Plugins are components of its `plugin` world, and its `library` world
/// runs forge in the caller's process. Plugins in other languages generate
/// their bindings from it.
#[cfg(feature = "wasm")]
pub const WIT: &str = include_str!("wasm/forge.wit");
