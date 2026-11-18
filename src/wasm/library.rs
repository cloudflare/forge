//! Implements the WIT's `library` world, which parses documents in the
//! caller's own process.
//!
//! `packages/forge/library` builds this crate to WebAssembly, and
//! `@cloudflare/forge` turns the build into JavaScript. `parse` returns the
//! same `forge` resource plugins read, so callers read a parsed document a
//! part at a time, by id. An id the document never gave out traps.

use super::records::records;
use crate::{Forge, normalize};

/// Holds the bindings of the `library` world, which only this module uses.
#[expect(
    clippy::mem_forget,
    reason = "wit-bindgen's generated code hands resources over with mem::forget"
)]
mod bindings {
    wit_bindgen::generate!({
        path: "src/wasm/forge.wit",
        world: "library",
    });
}

use bindings::exports::forge::plugin::forge::{self as wit, GuestForge};
use bindings::exports::forge::plugin::parser as exports;

// The crate built to WebAssembly links this crate, and so exports the world
// these functions implement. Only a WebAssembly build has anything to
// export them to.
#[cfg(target_arch = "wasm32")]
bindings::export!(Library with_types_in bindings);

/// Implements the `library` world.
struct Library;

impl wit::Guest for Library {
    type Forge = Document;
}

impl exports::Guest for Library {
    fn parse(json: String, adapters: Vec<String>) -> Result<wit::Forge, String> {
        let sources = adapters
            .iter()
            .map(|name| {
                normalize::named(name)
                    .ok_or_else(|| format!("unknown adapter {name:?}; expected cloudflare, fern, or stainless"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Without adapters, there is nothing to rewrite, so the document is
        // parsed as given.
        let normalized: Option<Vec<u8>> = if sources.is_empty() {
            None
        } else {
            let options = normalize::Options {
                leave_old_extensions: false,
                sources: &sources,
            };
            normalize::normalize(json.as_bytes(), &options)
                .map_err(|err| err.to_string())?
                .json
        };
        let forge: Forge = match &normalized {
            Some(normalized) => serde_json::from_slice(normalized),
            None => serde_json::from_str(&json),
        }
        .map_err(|err| err.to_string())?;
        Ok(wit::Forge::new(Document { forge }))
    }
}

/// Holds one parsed document, behind the `forge` resource.
struct Document {
    forge: Forge,
}

/// Returns item `id` of `items`. Panics, and so traps, when the document
/// never gave out `id`.
fn get<'a, T>(items: &'a [T], id: u32, what: &str) -> &'a T {
    match items.get(id as usize) {
        Some(item) => item,
        None => panic!("no {what} with id {id}"),
    }
}

impl GuestForge for Document {
    fn info(&self) -> wit::ForgeInfo {
        forge_info(&self.forge)
    }

    fn counts(&self) -> wit::ForgeCounts {
        forge_counts(&self.forge)
    }

    fn groups(&self) -> Vec<u32> {
        group_ids(&self.forge)
    }

    fn get_group(&self, id: u32) -> wit::GroupInfo {
        group_info(get(&self.forge.groups, id, "group"))
    }

    fn get_method(&self, id: u32) -> wit::MethodInfo {
        method_info(&self.forge, get(&self.forge.methods, id, "method"))
    }

    fn get_model(&self, id: u32) -> wit::ModelInfo {
        model_info(&self.forge, get(&self.forge.models, id, "model"))
    }

    fn get_type(&self, id: u32) -> wit::TypeInfo {
        type_info(&self.forge, get(&self.forge.types, id, "type"))
    }

    fn get_location(&self, id: u32, object: u32, index: u32) -> Option<wit::Location> {
        let forge = &self.forge;
        let method = get(&forge.methods, id, "method");
        let crate::types::TypeData::Object(object) = get(&forge.types, object, "type") else {
            panic!("type {object} is not an object");
        };
        let field = get(forge.fields.get(object.fields), index, "field");
        location(forge, method, field)
    }
}

records!();
