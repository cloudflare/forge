//! Implements the WIT's `library` world, which parses and normalizes
//! documents in the caller's own process.
//!
//! `packages/forge/library` builds this crate to WebAssembly, and
//! `@cloudflare/forge` turns the build into JavaScript. `parse` returns the
//! same `forge` record plugins receive, backed by [`ForgeWasm`].

use super::types::ForgeWasm;
use crate::Forge;
use crate::normalize::{Adapter, Options, normalize};

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

use bindings::exports::forge::plugin::{normalizer, parser};

// The crate built to WebAssembly links this crate, and so exports the world
// these functions implement. Only a WebAssembly build has anything to
// export them to.
#[cfg(target_arch = "wasm32")]
bindings::export!(Library with_types_in bindings);

/// Implements the `library` world.
struct Library;

impl parser::Guest for Library {
    fn parse(json: String) -> Result<ForgeWasm, String> {
        let forge: Forge = serde_json::from_str(&json).map_err(|err| err.to_string())?;
        Ok(ForgeWasm::from(&forge))
    }
}

impl normalizer::Guest for Library {
    fn normalize(json: String, options: normalizer::Options) -> Result<String, String> {
        let adapters: Vec<Adapter> = match options.adapters {
            Some(list) => list
                .into_iter()
                .map(|adapter| {
                    let name = match adapter {
                        normalizer::Adapter::Cloudflare => "cloudflare",
                        normalizer::Adapter::Fern => "fern",
                        normalizer::Adapter::Stainless => "stainless",
                    };
                    Adapter::named(name).expect("built-in adapter")
                })
                .collect(),
            None => Adapter::all().collect(),
        };
        let normalized = normalize(
            json.as_bytes(),
            &Options {
                leave_old_extensions: options.leave_old_extensions,
                adapters: &adapters,
            },
        )
        .map_err(|err| err.to_string())?;
        match normalized.json {
            Some(bytes) => String::from_utf8(bytes).map_err(|err| err.to_string()),
            None => Ok(json),
        }
    }
}
