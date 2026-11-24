//! Rewrites third-party OpenAPI metadata extensions into Forge's native
//! `x-forge-*` extensions.
//!
//! [`Forge`](crate::Forge) reads only native `x-forge-*` extensions. Call
//! [`normalize`] with one or more [`Adapter`]s to convert extensions from
//! tools such as Fern (`x-fern-sdk-group-name`, `x-fern-sdk-method-name`)
//! before parsing.
//!
//! Keys are rewritten only on the OpenAPI object kinds where Forge reads the
//! native replacement (for example, an operation group name is rewritten on an
//! operation, not on a schema). Native keys always take precedence; when both
//! a native key and a third-party key are present, the native key is kept and
//! the third-party key is removed.
//!
//! # Examples
//!
//! Normalize a Fern document before parsing it into a [`Forge`](crate::Forge):
//!
//! ```
//! use forge::Forge;
//! use forge::normalize::{normalize, Adapter, Options};
//!
//! let json = br#"{
//!   "openapi": "3.1.0",
//!   "info": {"title": "Pets", "version": "1"},
//!   "paths": {
//!     "/pets": {
//!       "get": {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "list", "responses": {}}
//!     }
//!   }
//! }"#;
//!
//! let options = Options {
//!     leave_old_extensions: false,
//!     adapters: &[Adapter::named("fern").unwrap()],
//! };
//! let normalized = normalize(json, &options)?;
//! let forge: Forge = serde_json::from_slice(normalized.json.as_deref().unwrap_or(json))?;
//!
//! let group = forge.groups().find(|group| group.name().kebab() == "pets").unwrap();
//! assert_eq!(group.methods().map(|method| method.name().kebab()).collect::<Vec<_>>(), ["list"]);
//! # Ok::<(), serde_json::Error>(())
//! ```
//!
//! Keep the original keys after their native replacements for tools that still
//! read them:
//!
//! ```
//! use forge::normalize::{normalize, Adapter, Options};
//!
//! let options = Options {
//!     leave_old_extensions: true,
//!     adapters: &[Adapter::named("fern").unwrap()],
//! };
//! let json = br#"{"paths":{"/pets":{"get":{"x-fern-sdk-method-name":"list"}}}}"#;
//! let normalized = normalize(json, &options)?;
//! assert_eq!(
//!     String::from_utf8(normalized.json.unwrap()).unwrap(),
//!     r#"{"paths":{"/pets":{"get":{"x-forge-method-name":"list","x-fern-sdk-method-name":"list"}}}}"#,
//! );
//! # Ok::<(), serde_json::Error>(())
//! ```

mod json;
mod vendor;
mod walk;

use std::fmt;

pub use json::{Normalized, Options, Report, normalize};

/// A third-party extension adapter for [`normalize`].
///
/// Built-in adapters are `cloudflare`, `fern`, and `stainless`, matching the
/// names accepted by `forge normalize --from`.
///
/// ```
/// use forge::normalize::Adapter;
///
/// let names: Vec<_> = Adapter::all().map(Adapter::name).collect();
/// assert_eq!(names, ["cloudflare", "fern", "stainless"]);
///
/// assert_eq!(Adapter::named("fern").map(Adapter::name), Some("fern"));
/// assert!(Adapter::named("swagger").is_none());
/// ```
#[derive(Clone, Copy)]
pub struct Adapter(&'static dyn vendor::Source);

impl Adapter {
    /// Returns the adapter for `name` (lowercase, such as `"fern"`), or `None`
    /// if no adapter matches.
    pub fn named(name: &str) -> Option<Adapter> {
        vendor::named(name).map(Adapter)
    }

    /// Returns all built-in adapters, sorted by name.
    pub fn all() -> impl ExactSizeIterator<Item = Adapter> {
        vendor::ALL.iter().map(|&source| Adapter(source))
    }

    /// Returns the adapter's name, such as `"fern"`.
    pub fn name(self) -> &'static str {
        self.0.name()
    }

    fn source(self) -> &'static dyn vendor::Source {
        self.0
    }
}

impl PartialEq for Adapter {
    fn eq(&self, other: &Adapter) -> bool {
        self.name() == other.name()
    }
}

impl Eq for Adapter {}

impl fmt::Debug for Adapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}
