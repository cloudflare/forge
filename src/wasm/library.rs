//! Implements the WIT's `library` world, which parses documents in the
//! caller's own process.
//!
//! `packages/forge/library` builds this crate to WebAssembly, and
//! `@cloudflare/forge` turns the build into JavaScript. `parse` returns the
//! same `forge` record plugins receive, backed by [`ForgeWasm`].

use super::types::ForgeWasm;
use crate::Forge;

/// Private bindgen shim mapping WIT `forge` to [`ForgeWasm`].
mod wit_forge {
    pub use crate::wasm::types::{ForgeWasm as Forge, *};
}

/// Holds the bindings of the `library` world, which only this module uses.
#[expect(
    clippy::mem_forget,
    reason = "wit-bindgen's generated code hands lowered buffers over with mem::forget"
)]
mod bindings {
    wit_bindgen::generate!({
        path: "src/wasm/forge.wit",
        world: "library",
        with: { "forge:plugin/forge@0.5.0": super::wit_forge },
    });
}

use bindings::exports::forge::plugin::parser as exports;

// The crate built to WebAssembly links this crate, and so exports the world
// these functions implement. Only a WebAssembly build has anything to
// export them to.
#[cfg(target_arch = "wasm32")]
bindings::export!(Library with_types_in bindings);

/// Implements the `library` world.
struct Library;

impl exports::Guest for Library {
    fn parse(json: String) -> Result<ForgeWasm, String> {
        let forge: Forge = serde_json::from_str(&json).map_err(|err| err.to_string())?;
        Ok(ForgeWasm::from(&forge))
    }

    fn parse_with_conditions(json: String, conditions: Vec<String>) -> Result<ForgeWasm, String> {
        let forge = crate::parse_json(json.as_bytes(), &conditions)?;
        Ok(ForgeWasm::from(&forge))
    }
}
