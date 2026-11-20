//! Generates TypeScript files. You print lines of text and identifiers to
//! a [`File`], and it works out their imports when it renders.
//!
//! ```
//! use forge::ts::{self, p};
//!
//! let models = ts::Module::new("pets/models.ts");
//! let mut f = ts::File::new(ts::Module::new("pets/client.ts"));
//! f.doc("A client of pets.");
//! p!(f, "export interface ", f.ident("Client"), " {");
//! f.indent(|f| {
//!     p!(f, "get(): Promise<", models.ident("Pet").ty(), ">;");
//! });
//! p!(f, "}");
//! ```

use std::borrow::Cow;
use std::fmt;

use crate::{Group, Model};

mod file;
mod print;
#[cfg(test)]
mod tests;

pub use file::{File, PREAMBLE};
pub use print::{Fragment, Print, join};

/// Collects the parts, in order, into a [`Fragment`] to print as part of a
/// line later. Each part must implement [`Print`].
///
/// ```
/// # use forge::ts::{self, frag, p};
/// let pet = ts::Module::new("models.ts").ident("Pet").ty();
/// let list = frag!("Promise<", pet, "[]>");
/// let mut f = ts::File::new(ts::Module::new("a.ts"));
/// p!(f, "list(): ", list, ";");
/// ```
#[doc(inline)]
pub use crate::__ts_frag as frag;

/// Returns the parts with `sep` between each two of them, leaving out the
/// parts that print nothing, as [`join()`] does. The parts can be of
/// different types, as long as each implements [`Print`].
///
/// ```
/// # use forge::ts::{self, frag, join, p};
/// let codec = frag!(); // nothing to print
/// let entry = frag!("[", join!(", ", "\"a\"", 1, codec), "]"); // ["a", 1]
/// let mut f = ts::File::new(ts::Module::new("a.ts"));
/// p!(f, entry, ",");
/// ```
#[doc(inline)]
pub use crate::__ts_join as join;

/// Prints a line to a [`File`]: the file's indentation, each part, then a
/// line break.
///
/// ```
/// # use forge::ts::{self, p};
/// let mut f = ts::File::new(ts::Module::new("a.ts"));
/// let pet = ts::Module::new("models.ts").ident("Pet").ty();
/// p!(f, "let pet: ", pet, ";");
/// p!(f); // a blank line
/// ```
///
/// Each part must implement [`Print`]. The file prints an [`Ident`] under
/// the name it uses for it, and imports it if it comes from another
/// module. A [`Model`] prints as its identifier, [`Ident::model`]. Anything
/// else prints as its [`Display`](fmt::Display) writes it.
/// If the parts print nothing but empty text, the line is blank, with no
/// indentation.
#[doc(inline)]
pub use crate::__ts_p as p;

#[doc(hidden)]
#[macro_export]
macro_rules! __ts_p {
    ($file:expr $(, $part:expr)* $(,)?) => {
        $file.line(&[$(&$part as &dyn $crate::ts::Print),*])
    };
}

/// A TypeScript module that files can import: a generated file or a
/// package.
///
/// A module ending in `.ts` is a generated file, named by its path from the
/// generation root, such as `pets/models.ts`. Other generated files import
/// it by a relative specifier ending in `.js`, such as `./models.js`, which
/// is how TypeScript resolves it. Any other module is a package, such as
/// `zod` or `node:fs`, and files import it by that specifier unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Module(Cow<'static, str>);

impl Module {
    /// The generation root. Its [`sub`](Module::sub) modules are the
    /// top-level files.
    pub const ROOT: Module = Module::new("");

    /// Returns the module at `path`.
    pub const fn new(path: &'static str) -> Module {
        Module(Cow::Borrowed(path))
    }

    /// Returns the directory that holds `group`'s files, its
    /// [`sub`](Module::sub) modules: the group's path, with each name in
    /// camelCase and prefixed with `_` if it starts with a digit. The root
    /// group's path is empty, so its directory is [`Module::ROOT`].
    ///
    /// A group `list_all` inside `pet-store` gets `petStore/listAll`.
    pub fn group(group: Group<'_>) -> Module {
        let dirs: Vec<String> = group.path().map(|name| identifier(name.camel())).collect();
        Module::from(dirs.join("/"))
    }

    /// Returns the path or specifier of the module.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the identifier called `name` declared in this module.
    pub fn ident(&self, name: impl Into<Cow<'static, str>>) -> Ident {
        Ident {
            name: name.into(),
            module: self.clone(),
            type_only: false,
            alias: None,
        }
    }

    /// Returns the module `name` inside the directory `self`.
    ///
    /// ```
    /// # use forge::ts::Module;
    /// assert_eq!(Module::new("pets").sub("models.ts"), Module::new("pets/models.ts"));
    /// assert_eq!(Module::ROOT.sub("models.ts"), Module::new("models.ts"));
    /// ```
    pub fn sub(&self, name: &str) -> Module {
        if self.0.is_empty() {
            Module::from(name.to_owned())
        } else {
            Module::from(format!("{}/{name}", self.0))
        }
    }

    /// Reports whether the module is a generated file.
    fn generated(&self) -> bool {
        self.0.ends_with(".ts")
    }
}

impl From<&'static str> for Module {
    fn from(path: &'static str) -> Module {
        Module::new(path)
    }
}

impl From<String> for Module {
    fn from(path: String) -> Module {
        Module(Cow::Owned(path))
    }
}

impl fmt::Display for Module {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A TypeScript identifier: a name and the module that declares it.
///
/// A file that prints an identifier from another module imports it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Ident {
    pub name: Cow<'static, str>,
    pub module: Module,
    /// Whether the identifier is only a type. Files import types with
    /// `import type`, or with `type` in front of the name when the same
    /// declaration also imports values.
    pub type_only: bool,
    /// The name a file imports the identifier under, as in
    /// `import { Name as Alias }`, and uses for it. If the alias is already
    /// taken in the file, it still gets `$` appended. A file ignores the
    /// alias of its own identifiers, since it doesn't import them.
    pub alias: Option<Cow<'static, str>>,
}

impl Ident {
    /// Returns the identifier of `model`: its name in PascalCase, prefixed
    /// with `_` if it starts with a digit, declared in the `models.ts` of
    /// its group's directory ([`Module::group`]). Call [`ty`](Ident::ty) on
    /// it to import it with `import type`.
    ///
    /// A generator that names models differently, such as with a prefix,
    /// changes the identifier and prints that one everywhere it refers to
    /// the model.
    pub fn model(model: Model<'_>) -> Ident {
        Module::group(model.group())
            .sub("models.ts")
            .ident(identifier(model.name().pascal()))
    }

    /// Returns the identifier marked as only a type, so files import it
    /// with `import type`.
    pub fn ty(mut self) -> Ident {
        self.type_only = true;
        self
    }

    /// Returns the identifier imported under `alias`.
    pub fn alias(mut self, alias: impl Into<Cow<'static, str>>) -> Ident {
        self.alias = Some(alias.into());
        self
    }
}

/// Writes the name unchanged, such as `Temporal.Instant`. A file can print
/// the identifier under an alias instead.
impl fmt::Display for Ident {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name)
    }
}

/// Appends the identifier itself, which the file resolves when it renders.
impl Print for Ident {
    fn print(&self, out: &mut Fragment) {
        out.ident(self.clone());
    }
}

/// Appends the model's identifier, as [`Ident::model`] returns it.
impl Print for Model<'_> {
    fn print(&self, out: &mut Fragment) {
        out.ident(Ident::model(*self));
    }
}

/// Prefixes `s` with `_` if it starts with a digit, so it's a valid
/// identifier.
fn identifier(s: String) -> String {
    if s.starts_with(|c: char| c.is_ascii_digit()) {
        format!("_{s}")
    } else {
        s
    }
}
