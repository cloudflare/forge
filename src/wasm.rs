//! Runs plugins compiled to WebAssembly components, in any language that
//! targets the component model.
//!
//! A plugin is a component of the `plugin` world in [`WIT`]. It exports
//! `generate`, which [`WasmPlugin`] calls where [`Plugin::generate`](crate::Plugin::generate) is,
//! receiving a `forge` record built from [`Forge`](crate::Forge).
//!
//! Each call of `generate` runs in an instance of its own, on one thread:
//! unlike a native plugin, a wasm plugin can't generate groups in parallel.
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
//! this crate to parse documents in JavaScript. Both worlds exchange the same
//! `forge` record.

#[cfg(feature = "wasm")]
mod host;
#[cfg(feature = "library")]
mod library;
mod types;

#[cfg(feature = "wasm")]
pub use host::{WasmFile, WasmPlugin};

/// Holds the WIT package that plugins and the library are built against.
/// Plugins are components of its `plugin` world, and its `library` world
/// runs forge in the caller's process. Plugins in other languages generate
/// their bindings from it.
#[cfg(feature = "wasm")]
pub const WIT: &str = include_str!("wasm/forge.wit");
