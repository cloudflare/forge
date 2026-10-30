//! The adapter for deprecated Forge extensions that have a current name.
//!
//! It starts empty. A rename adds the old key to the table for its kind of
//! object and maps it to the current native key.

use super::Key;

/// Deprecated keys of an operation or alias.
pub(super) const DEFINITION: [(&str, Key); 0] = [];

/// Deprecated keys of a Parameter Object.
pub(super) const PARAMETER: [(&str, Key); 0] = [];

/// Deprecated keys of a Schema Object.
pub(super) const SCHEMA: [(&str, Key); 0] = [];
