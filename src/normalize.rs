//! Rewrites the metadata extensions other tools write, such as Fern's
//! `x-fern-sdk-group-name`, into Forge's native `x-forge-*` vocabulary,
//! which is all a [`Forge`](crate::Forge) reads. `forge normalize` rewrites
//! files with it, and the library world parses documents after it.
//!
//! Each tool is an adapter, a [`Source`] of compatibility extensions:
//! `cloudflare`, `fern` and `stainless`, in [`ALL`]. A key is rewritten only
//! at the kind of OpenAPI object where Forge reads its native replacement,
//! and a native key is never replaced. How one document is rewritten is in
//! [`normalize`].

mod json;
mod vendor;
mod walk;

pub use json::{Normalized, Options, Report, normalize};
pub use vendor::{ALL, Source, named};
