//! Forge as a library for other languages: the `library` world of the WIT,
//! in which an OpenAPI document is parsed in the caller's own process and
//! read as a plugin reads the forge its host runs it on.
//!
//! It is for a build of forge to WebAssembly, `packages/forge/library`, which
//! `@cloudflare/forge` turns into JavaScript. A part is fetched by id, as
//! through the `forge` interface, and an id the document never gave out
//! traps.

use super::records::records;
use crate::Forge;

/// The bindings of the `library` world. `export_library!` exports an
/// implementation of it from the crate that is built to WebAssembly.
#[doc(hidden)]
#[expect(
    clippy::mem_forget,
    reason = "wit-bindgen's generated code hands resources over with mem::forget"
)]
pub mod bindings {
    wit_bindgen::generate!({
        path: "src/plugin/forge.wit",
        world: "library",
        pub_export_macro: true,
        export_macro_name: "export_library",
        default_bindings_module: "forge::library::bindings",
    });
}

use bindings::exports::forge::plugin::document::{self as exports, GuestDocument};
use bindings::forge::plugin::forge as wit;

/// The implementation of the `library` world. Export it with
/// `forge::library::bindings::export_library!(Library);`, with `Library` in scope.
pub struct Library;

impl exports::Guest for Library {
    type Document = Document;
}

/// A parsed document.
pub struct Document {
    forge: Forge,
}

/// Returns item `id` of `items`, and traps if there is none, as an id the
/// document never gave out does.
fn get<'a, T>(items: &'a [T], id: u32, what: &str) -> &'a T {
    match items.get(id as usize) {
        Some(item) => item,
        None => panic!("no {what} with id {id}"),
    }
}

impl GuestDocument for Document {
    fn parse(json: String) -> Result<exports::Document, String> {
        let forge: Forge = serde_json::from_str(&json).map_err(|err| err.to_string())?;
        Ok(exports::Document::new(Document { forge }))
    }

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
