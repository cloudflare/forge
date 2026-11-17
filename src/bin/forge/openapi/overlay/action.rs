//! Action types: parsed representation of an overlay Action Object.

use super::path::Path as JPath;

pub struct Action {
    pub target_path: JPath,
    pub body: ActionBody,
}

pub enum ActionBody {
    Direct(Fields),
    Ref { name: String },
}

/// The `update`/`copy`/`remove` fields of an Action Object, or of the
/// `fields` object inside a reusable action.
pub struct Fields {
    pub update: Option<serde_json::Value>,
    pub copy: Option<JPath>,
    pub remove: bool,
}
