use super::*;
use crate::{Forge, Name};

/// `ts::File` implements `forge::File`.
const _: fn() = || {
    fn is_file<F: crate::File>() {}
    is_file::<File>();
};

/// Returns the content of `f` without the preamble, and panics if the
/// preamble is missing.
#[track_caller]
fn content(f: &File) -> String {
    let rendered = f.render();
    match rendered.strip_prefix(PREAMBLE) {
        Some(rest) => rest.to_owned(),
        None => panic!("{} does not start with the preamble:\n{rendered}", f.module()),
    }
}

fn lines(lines: &[&str]) -> String {
    lines.join("\n") + "\n"
}

#[test]
fn file() {
    let models = Module::new("pets/models.ts");
    let runtime = Module::new("_/index.ts");
    let mut f = File::new(Module::new("pets/client.ts"));
    assert_eq!(crate::File::path(&f), "pets/client.ts");

    f.doc("A client of pets.");
    p!(f, "export interface ", f.ident("Client"), " {");
    p!(f, "  get(): Promise<", models.ident("Pet").ty(), ">;");
    p!(f, "  list(): ", frag!("Promise<", models.ident("Pet").ty(), "[]>"), ";");
    p!(f, "}");
    p!(f);
    p!(f, "const codec = ", models.ident("PetCodec"), ";");
    p!(f, "const transport = new ", runtime.ident("Transport"), "();");
    p!(
        f,
        "const read = ",
        Module::new("node:fs/promises").ident("readFile"),
        ";"
    );
    p!(f, "type S = ", Module::new("@scope/schema").ident("Schema").ty(), ";");
    // A name used as both a value and a type is imported as a value.
    p!(f, "type T = ", runtime.ident("Transport").ty(), ";");
    p!(
        f,
        "let now: ",
        Module::new("temporal").ident("Temporal.Instant").ty(),
        ";"
    );

    assert_eq!(
        content(&f),
        lines(&[
            r#"import type { Schema } from "@scope/schema";"#,
            r#"import { readFile } from "node:fs/promises";"#,
            r#"import type { Temporal } from "temporal";"#,
            "",
            // Generated files are imported with .js.
            r#"import { Transport } from "../_/index.js";"#,
            r#"import { type Pet, PetCodec } from "./models.js";"#,
            "",
            "/**",
            " * A client of pets.",
            " */",
            "export interface Client {",
            "  get(): Promise<Pet>;",
            "  list(): Promise<Pet[]>;",
            "}",
            "",
            "const codec = PetCodec;",
            "const transport = new Transport();",
            "const read = readFile;",
            "type S = Schema;",
            "type T = Transport;",
            "let now: Temporal.Instant;",
        ])
    );
}

#[test]
fn aliases() {
    let mut f = File::new(Module::new("a/b.ts"));
    // The file's own `Pet` keeps the name, and each later `Pet` gets another
    // `$`.
    p!(f, "interface ", f.ident("Pet"), " {}");
    p!(f, "let x: ", Module::new("c.ts").ident("Pet").ty(), ";");
    p!(f, "let y: ", Module::new("d.ts").ident("Pet").ty(), ";");
    p!(f, "let z: ", Module::new("d.ts").ident("Owner").ty(), ";");
    assert_eq!(
        content(&f),
        lines(&[
            r#"import type { Pet as Pet$ } from "../c.js";"#,
            r#"import type { Owner, Pet as Pet$$ } from "../d.js";"#,
            "",
            "interface Pet {}",
            "let x: Pet$;",
            "let y: Pet$$;",
            "let z: Owner;",
        ])
    );
}

#[test]
fn ident_helpers() {
    let pet = Module::new("pets/models.ts").ident("Pet");
    let plain = Ident {
        name: "Pet".into(),
        module: "pets/models.ts".into(),
        type_only: false,
        alias: None,
    };
    assert_eq!(
        pet.clone().alias("PetModel"),
        Ident {
            alias: Some("PetModel".into()),
            ..plain.clone()
        }
    );
    assert_eq!(
        pet.clone().ty(),
        Ident {
            type_only: true,
            ..plain.clone()
        }
    );
    assert_eq!(
        pet.clone().ty().alias("PetModel"),
        Ident {
            type_only: true,
            alias: Some("PetModel".into()),
            ..plain.clone()
        }
    );
    assert_eq!(pet, plain);

    let mut f = File::new(Module::new("pets/client.ts"));
    p!(f, "let a: ", pet.ty(), ";");
    assert_eq!(
        content(&f),
        lines(&[r#"import type { Pet } from "./models.js";"#, "", "let a: Pet;"])
    );
}

#[test]
fn custom_aliases() {
    let mut f = File::new(Module::new("pets/client.ts"));
    let models = Module::new("pets/models.ts");
    p!(f, "interface ", f.ident("Client").alias("Ignored"), " {}");
    p!(f, "let a: ", models.ident("Pet").ty().alias("PetModel"), ";");
    // The same name can be imported under several aliases.
    p!(f, "let b: ", models.ident("Pet").ty().alias("Animal"), ";");
    p!(f, "let c: ", models.ident("Pet").ty(), ";");
    // An alias that is taken still gets "$" added.
    p!(
        f,
        "let d: ",
        Module::new("zod").ident("z").alias("Client"),
        ".string();"
    );
    p!(
        f,
        "let e: ",
        Module::new("temporal").ident("Temporal.Instant").ty().alias("T"),
        ";"
    );
    assert_eq!(
        content(&f),
        lines(&[
            r#"import type { Temporal as T } from "temporal";"#,
            r#"import { z as Client$ } from "zod";"#,
            "",
            r#"import type { Pet, Pet as Animal, Pet as PetModel } from "./models.js";"#,
            "",
            "interface Client {}",
            "let a: PetModel;",
            "let b: Animal;",
            "let c: Pet;",
            "let d: Client$.string();",
            "let e: T.Instant;",
        ])
    );
}

#[test]
fn doc() {
    let mut f = File::new(Module::new("a.ts"));
    f.doc("Returns a pet.\n\nIt is looked up by its ID, and */ is escaped.\n  - an indented item\n");
    p!(f, "function get(): void {}");
    p!(f, "interface Client {");
    f.indent(|f| {
        f.doc("  Only one line.  ");
        p!(f, "list(): void;");
        f.doc("Is the second.");
        p!(f, "get(): void;");
    });
    p!(f, "}");
    // A comment with nothing in it is not printed.
    f.indent(|f| f.indent(|f| f.doc(" \n ")));
    assert_eq!(
        content(&f),
        lines(&[
            "/**",
            " * Returns a pet.",
            " *",
            r" * It is looked up by its ID, and *\/ is escaped.",
            " *   - an indented item",
            " */",
            "function get(): void {}",
            "interface Client {",
            "  /**",
            "   * Only one line.",
            "   */",
            "  list(): void;",
            "  /**",
            "   * Is the second.",
            "   */",
            "  get(): void;",
            "}",
        ])
    );
}

#[test]
fn doc_wraps() {
    let mut f = File::new(Module::new("a.ts"));
    f.indent(|f| {
        f.indent(|f| {
            f.doc(concat!(
                "The URL the paths of the API are relative to, which defaults to the first server of the description.\n",
                "  - an item of a list whose words are wrapped under it when they do not fit on the line\n",
                "See https://developers.cloudflare.com/fundamentals/api/reference/a-very-long-path-that-does-not-fit/ for more.",
            ))
        })
    });
    let got = content(&f);
    assert_eq!(
        got,
        lines(&[
            "    /**",
            "     * The URL the paths of the API are relative to, which defaults to the first",
            "     * server of the description.",
            "     *   - an item of a list whose words are wrapped under it when they do not",
            "     *   fit on the line",
            "     * See",
            "     * https://developers.cloudflare.com/fundamentals/api/reference/a-very-long-path-that-does-not-fit/",
            "     * for more.",
            "     */",
        ])
    );
    for line in got.lines().filter(|line| !line.contains("https://")) {
        assert!(line.len() <= 80, "{line:?} is longer than 80 columns");
    }
}

#[test]
fn indent() {
    let mut f = File::new(Module::new("a.ts"));
    p!(f, "a {");
    f.indent(|f| {
        p!(f, "b {");
        f.indent(|f| {
            p!(f, "c;");
            // A blank line has no indentation.
            p!(f);
            p!(f, "", "");
        });
        p!(f, "}");
    });
    p!(f, "}");
    assert_eq!(content(&f), lines(&["a {", "  b {", "    c;", "", "", "  }", "}"]));
}

#[test]
fn imports_break() {
    let mut f = File::new(Module::new("a.ts"));
    let m = Module::new("some/long/module/path.ts");
    for name in ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"] {
        p!(f, "let ", name.to_lowercase(), " = ", m.ident(name), ";");
    }
    assert!(content(&f).starts_with(&lines(&[
        "import {",
        "  Alpha,",
        "  Bravo,",
        "  Charlie,",
        "  Delta,",
        "  Echo,",
        "  Foxtrot,",
        "  Golf,",
        r#"} from "./some/long/module/path.js";"#,
    ])));

    let empty = File::new(Module::new("empty.ts"));
    assert_eq!(empty.render(), "");
}

/// A type a generator prints by its `Display`, with an empty impl.
struct Version(u32);

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}", self.0)
    }
}

impl Print for Version {}

#[test]
fn parts() {
    let models = Module::new("models.ts");
    let pet = models.ident("Pet").ty();
    let mut f = File::new(Module::new("a.ts"));
    // A reference to a part prints the part.
    p!(f, "let a: ", &pet, ";");
    // Numbers, characters, booleans and joins print by their Display.
    p!(f, "let b = [", join(", ", [1, 2, 3]), "]", ';');
    p!(f, "let c = ", 1.5, ", d = ", true, ";");
    // So does a generator's own type that implements Print with no body.
    p!(f, "const version = \"", Version(2), "\";");
    // A fragment made before the file carries its imports.
    let owner = frag!(models.ident("Owner"), " | null");
    p!(f, "let e: ", owner, ";");
    // A join of identifiers imports each.
    let ids = join(" | ", [models.ident("A"), models.ident("B").ty()]);
    p!(f, "type F = ", ids, ";");
    assert_eq!(
        content(&f),
        lines(&[
            r#"import { A, type B, Owner, type Pet } from "./models.js";"#,
            "",
            "let a: Pet;",
            "let b = [1, 2, 3];",
            "let c = 1.5, d = true;",
            r#"const version = "v2";"#,
            "let e: Owner | null;",
            "type F = A | B;",
        ])
    );
}

#[test]
fn joins_leave_out_empty_parts() {
    assert_eq!(join(", ", ["a", "", "b", ""]).to_string(), "a, b");
    assert_eq!(join(", ", ["", ""]).to_string(), "");
    // join! takes parts of different types.
    let pet = Module::new("models.ts").ident("Pet");
    assert_eq!(
        frag!("[", join!(", ", 1, "", pet, frag!()), "]").to_string(),
        "[1, Pet]"
    );
    assert!(join!(", ").is_empty());
}

#[test]
fn display() {
    // Display writes names unchanged, ignoring aliases.
    let pet = Module::new("models.ts").ident("Temporal.Instant").alias("T");
    assert_eq!(pet.to_string(), "Temporal.Instant");
    let list: Fragment = frag!("Promise<", pet, "[]>");
    assert_eq!(list.to_string(), "Promise<Temporal.Instant[]>");
}

#[test]
fn models() {
    let forge: Forge = serde_json::from_str(
        r##"{
          "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
          "paths": {
            "/a": {"get": {"x-forge-group-name": ["pet-store", "list_all"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/pet_owner"}}}}}}},
            "/b": {"get": {"x-forge-group-name": ["pet-store"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/2fa"}}}}}}},
            "/c": {"get": {"x-forge-group-name": ["other"], "x-forge-method-name": "get",
              "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/2fa"}}}}}}}
          },
          "components": {"schemas": {"pet_owner": {"type": "string"}, "2fa": {"type": "string"}}}
        }"##,
    )
    .unwrap();
    let group = |path: &[&str]| {
        let names: Vec<Name> = path.iter().map(|name| Name::new(name)).collect();
        forge.groups().find(|group| group.path().eq(names.iter())).unwrap()
    };
    let model = |schema_name: &str| {
        forge
            .groups()
            .flat_map(|group| group.models())
            .chain(forge.models())
            .find(|model| model.schema_name() == schema_name)
            .unwrap()
    };
    let (owner, two_fa) = (model("pet_owner"), model("2fa"));

    assert_eq!(Module::ROOT.sub("models.ts"), Module::new("models.ts"));
    assert_eq!(Module::group(group(&["pet-store"])), Module::new("petStore"));
    assert_eq!(
        Module::group(group(&["pet-store", "list_all"])).sub("client.ts"),
        Module::new("petStore/listAll/client.ts")
    );
    assert_eq!(
        Ident::model(owner),
        Module::new("petStore/listAll/models.ts").ident("PetOwner")
    );
    assert_eq!(Ident::model(two_fa), Module::new("models.ts").ident("_2fa"));

    let mut f = File::new(Module::new("petStore/client.ts"));
    // A model prints as its identifier. Display writes its schema name.
    assert_eq!(two_fa.to_string(), "2fa");
    p!(f, "let owner: ", owner, ";");
    p!(f, "let factor: ", Ident::model(two_fa).ty(), ";");
    // A generator that names a model differently prints its own identifier.
    let mut err_owner = Ident::model(owner).ty();
    err_owner.name = format!("Err{}", err_owner.name).into();
    p!(f, "let failure: ", err_owner, ";");
    assert_eq!(
        content(&f),
        lines(&[
            r#"import type { _2fa } from "../models.js";"#,
            r#"import { type ErrPetOwner, PetOwner } from "./listAll/models.js";"#,
            "",
            "let owner: PetOwner;",
            "let factor: _2fa;",
            "let failure: ErrPetOwner;",
        ])
    );
}
