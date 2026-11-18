//! Rewrites the metadata extensions other tools write into Forge's native
//! `x-forge-*` vocabulary, which is all a [`Forge`](crate::Forge) reads.
//!
//! A document written for another tool, such as Fern, names its groups and
//! methods with that tool's extensions, `x-fern-sdk-group-name` and
//! `x-fern-sdk-method-name`. Forge gives those keys no meaning until they are
//! rewritten into the native ones, `x-forge-group-name` and
//! `x-forge-method-name`. Each tool is an [`Adapter`], and [`normalize`]
//! rewrites the keys of the adapters it is given. `forge normalize` rewrites
//! files with it, and `@cloudflare/forge`'s `parse` reads documents through
//! it.
//!
//! A key is rewritten only at the kind of OpenAPI object where Forge reads
//! its native replacement: an operation's group name on an operation, not on
//! a schema. A native key is never replaced: when a document says the same
//! thing with a native key and another, the native one is kept and the other
//! removed. Adapters introduce no meaning of their own; each key they rewrite
//! has a native key that already says the same.
//!
//! # Examples
//!
//! Read a document written for Fern:
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
//! Keep the old keys beside the native ones, for tools that still read them.
//! Each native key is written in the place of the key it replaces, and the
//! old key after it:
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

/// A tool whose metadata extensions [`normalize`] rewrites into Forge's
/// native ones: `cloudflare`, `fern` or `stainless`, as `forge normalize
/// --from` names them.
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
    /// Returns the adapter called `name`, or `None` if Forge has none by
    /// that name. Names are lower case, as [`Adapter::name`] gives them.
    pub fn named(name: &str) -> Option<Adapter> {
        vendor::named(name).map(Adapter)
    }

    /// Returns every adapter, in the order of their names.
    pub fn all() -> impl ExactSizeIterator<Item = Adapter> {
        vendor::ALL.iter().map(|&source| Adapter(source))
    }

    /// Returns the adapter's name, such as `fern`.
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

/// Writes the adapter's name.
impl fmt::Debug for Adapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}
