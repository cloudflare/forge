//! Runs the TypeScript generator compiled to a wasm plugin, from
//! tests/wasm/ts, and checks that it generates the same files as the
//! native generator.
//!
//! `bench` compares their speed on the documents in `FORGE_SPEC`, one path
//! or several separated like `PATH`:
//!
//! ```sh
//! FORGE_SPEC=openapi.json cargo test --release --features wasm --test wasm -- --ignored --nocapture
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use forge::wasm::{WIT, WasmPlugin};
use forge::{Err, File, Forge, Plugin};
use rayon::prelude::*;

/// Writes out everything forge's public API gives, which the guest also
/// writes, with its `dump` feature, through the WIT.
#[path = "wasm/dump.rs"]
mod dump;

/// The native generator, from src/bin/forge/ts.rs.
#[path = "../src/bin/forge"]
mod bin {
    pub mod ts;
}

/// A document with nested groups, path and query parameters, bodies,
/// errors, and models that are enums, unions with a discriminator,
/// intersections, maps and nullable, and that refer to each other in a
/// cycle.
const SPEC: &str = r##"{
  "openapi": "3.1.0",
  "info": {"title": "Pets", "version": "2", "description": "A pet store."},
  "servers": [{"url": "https://api.example.com/v1"}],
  "paths": {
    "/pets": {
      "get": {
        "x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "list", "summary": "Lists pets.",
        "parameters": [
          {"name": "limit", "in": "query", "schema": {"type": "integer", "format": "int32"}},
          {"name": "tags", "in": "query", "explode": false, "schema": {"type": "array", "items": {"type": "string"}}}
        ],
        "responses": {
          "200": {"description": "ok", "content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}}}},
          "default": {"description": "error", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}
        }
      },
      "post": {
        "x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "create", "deprecated": true,
        "requestBody": {"required": true, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/NewPet"}}}},
        "responses": {"201": {"description": "created", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}}
      }
    },
    "/pets/{pet_id}": {
      "get": {
        "x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "get",
        "parameters": [{"name": "pet_id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
        "responses": {
          "200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
          "404": {"description": "missing", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}
        }
      }
    },
    "/pets/{pet_id}/photos": {
      "put": {
        "x-fern-sdk-group-name": "pets.photos", "x-fern-sdk-method-name": "upload",
        "parameters": [{"name": "pet_id", "in": "path", "required": true, "schema": {"type": "string"}}],
        "requestBody": {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
        "responses": {"204": {"description": "done"}}
      }
    },
    "/owners": {
      "get": {
        "x-fern-sdk-group-name": "owners", "x-fern-sdk-method-name": "list",
        "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
          "type": "object",
          "properties": {
            "owners": {"type": "array", "items": {"$ref": "#/components/schemas/Owner"}},
            "next": {"type": ["string", "null"]}
          },
          "required": ["owners"]
        }}}}}
      }
    }
  },
  "components": {"schemas": {
    "Pet": {"description": "A pet.", "allOf": [
      {"$ref": "#/components/schemas/NewPet"},
      {"type": "object", "properties": {
        "id": {"type": "string", "format": "uuid"},
        "created_at": {"type": "string", "format": "date-time"},
        "owner": {"$ref": "#/components/schemas/Owner"}
      }, "required": ["id"]}
    ]},
    "NewPet": {"type": "object", "properties": {
      "name": {"type": "string", "description": "The name."},
      "kind": {"$ref": "#/components/schemas/Kind"},
      "tags": {"type": "object", "additionalProperties": {"type": "string"}},
      "weight": {"type": "number", "format": "float", "deprecated": true}
    }, "required": ["name", "kind"]},
    "Kind": {
      "oneOf": [{"$ref": "#/components/schemas/Cat"}, {"$ref": "#/components/schemas/Dog"}],
      "discriminator": {"propertyName": "type", "mapping": {"cat": "#/components/schemas/Cat", "dog": "#/components/schemas/Dog"}}
    },
    "Cat": {"type": "object", "properties": {"type": {"type": "string", "enum": ["cat"]}, "lives": {"type": "integer"}}, "required": ["type"]},
    "Dog": {"type": "object", "properties": {"type": {"type": "string", "enum": ["dog"]}, "good": {"type": "boolean"}}, "required": ["type"]},
    "Owner": {"type": "object", "properties": {
      "name": {"type": "string"},
      "status": {"type": "string", "enum": ["active", "away"]},
      "pets": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}},
      "birthday": {"type": "string", "format": "date"},
      "avatar": {"type": "string", "format": "byte"}
    }},
    "Error": {"type": "object", "properties": {
      "code": {"type": "integer", "format": "int64"},
      "message": {"type": "string"}
    }, "required": ["message"]}
  }}
}"##;

/// A document with everything forge reads that the TypeScript generator
/// doesn't use: header parameters, availability, hidden methods,
/// confirmations, aliases, extensions of every JSON type, read-only,
/// sensitive and defaulted fields, limits on arrays, binary content,
/// descriptions of content, unions that are not exclusive, and groups
/// described with dotted keys.
const FEATURES: &str = r##"{
  "openapi": "3.1.0",
  "info": {"title": "Features", "version": "3"},
  "x-forge-commands": {"pets": {"description": "Pets."}, "admin.pets": {"description": "Pets, for admins."}},
  "paths": {
    "/pets/{id}": {
      "parameters": [{"name": "X-Trace", "in": "header", "schema": {"type": "string"}}],
      "get": {
        "x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "get",
        "x-fern-availability": "beta", "x-forge-hidden": true,
        "x-custom": {"b": 1, "a": [1.5, "two \"quoted\"\n", null, true, {}], "b": 2},
        "x-flag": false, "x-count": 9007199254740993, "x-text": "é 😀",
        "parameters": [
          {"name": "id", "in": "path", "required": true, "schema": {"type": "string"}},
          {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 10}},
          {"name": "x-trace", "in": "header", "required": true, "description": "Traces the call.", "schema": {"type": "string"}},
          {"name": "Authorization", "in": "header", "schema": {"type": "string", "x-sensitive": true}}
        ],
        "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}}
      },
      "delete": {
        "x-forge-aliases": [
          {"x-fern-sdk-group-name": "pets", "x-fern-sdk-method-name": "remove", "x-fern-availability": "deprecated",
            "x-forge-require-confirmation": "This deletes the pet.", "x-alias": [1]},
          {"x-fern-sdk-group-name": "admin.pets", "x-fern-sdk-method-name": "delete", "x-forge-require-confirmation": ""}
        ],
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
        "responses": {"204": {"description": "gone"}}
      }
    },
    "/pets/{id}/photo": {
      "put": {
        "x-fern-sdk-group-name": "pets.photos", "x-fern-sdk-method-name": "upload",
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
        "requestBody": {"required": true, "content": {
          "application/octet-stream": {"schema": {"type": "string", "format": "binary", "description": "The photo."}},
          "multipart/form-data": {"schema": {"type": "object", "properties": {
            "file": {"type": "string", "format": "binary"},
            "caption": {"type": "string", "default": "A pet."}
          }, "required": ["file"]}}
        }},
        "responses": {"204": {"description": "done"}}
      }
    }
  },
  "components": {"schemas": {
    "Pet": {"type": "object", "properties": {
      "id": {"type": "string", "readOnly": true},
      "password": {"type": "string", "x-sensitive": true},
      "tags": {"type": "array", "items": {"type": "string"}, "minItems": 0, "maxItems": 3},
      "dataset_scope": {"oneOf": [
        {"type": "object", "properties": {"type": {"const": "default"}}, "required": ["type"], "additionalProperties": false},
        {"type": "object", "properties": {
          "type": {"const": "datasets"},
          "dataset_ids": {"$ref": "#/components/schemas/DatasetIDs"}
        }, "required": ["type", "dataset_ids"], "additionalProperties": false}
      ]},
      "empty_format": {"type": "string", "format": ""},
      "custom_format": {"type": "string", "format": "custom-ID"},
      "kind": {"type": "string", "enum": ["cat", "dog"], "default": "cat"},
      "meta": {"type": "object", "additionalProperties": true, "default": {"z": 1, "a": [true, null]}},
      "owner": {"$ref": "#/components/schemas/Owner", "description": "Who has the pet."},
      "nickname": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
      "age": {"oneOf": [{"type": "string"}, {"type": "integer"}]}
    }, "required": ["id"]},
    "DatasetIDs": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"$ref": "#/components/schemas/ID"}},
    "ID": {"type": "string", "format": "uuid"},
    "Owner": {"type": "object", "description": "A person.", "properties": {
      "pets": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}
    }}
  }}
}"##;

/// The plugin reads, through the WIT, everything forge's API gives: the
/// guest's copy of the API, run on what the host sends, writes the same
/// dump as forge itself.
#[test]
fn reads_all_of_the_forge() {
    let plugin = WasmPlugin::from_file(dump_guest()).unwrap();
    for spec in [FEATURES, SPEC] {
        let forge = parse(spec.as_bytes());
        let native = dump::dump(&forge);
        // Every feature is in the dump, so the comparison covers it.
        if spec == FEATURES {
            for seen in [
                "availability Some(\"beta\") hidden true",
                "confirmation Some(\"This deletes the pet.\")",
                "confirmation Some(\"\")",
                "extension \"x-custom\"",
                "extension \"x-alias\"",
                "headers",
                "read only true",
                "sensitive true",
                "default Some(",
                "min items Some(0) max items Some(3)",
                "min items Some(1) max items Some(50)",
                "min items None max items None",
                "Uuid",
                "Binary",
                "description \"The photo.\"",
                "union exclusive false",
                "union exclusive true",
                "Pets, for admins.",
            ] {
                assert!(native.contains(seen), "the dump has no {seen:?}:\n{native}");
            }
        }
        let files = wasm(&forge, &plugin).unwrap();
        let wasm = String::from_utf8(files["dump.txt"].clone()).unwrap();
        assert_eq!(wasm, native);
    }
}

#[test]
fn generates_what_the_native_generator_does() {
    let forge = parse(SPEC.as_bytes());
    let native = native(&forge).unwrap();
    assert!(native.len() > 10, "only {} files", native.len());
    same(&native, &wasm(&forge, plugin()).unwrap());
}

/// An error of the generator comes back from the plugin as it is.
#[test]
fn returns_errors() {
    let spec = SPEC.replace("\"Error\"", "\"-\"").replace("schemas/Error", "schemas/-");
    let forge = parse(spec.as_bytes());
    let native = native(&forge).expect_err("the native generator succeeded").to_string();
    let wasm = wasm(&forge, plugin()).expect_err("the plugin succeeded").to_string();
    assert_eq!(wasm, native);
}

/// `forge --target wasm://PATH` runs the plugin at PATH, and writes what
/// `--target ts` does.
#[test]
fn cli() {
    let out = std::env::temp_dir().join(format!("forge-cli-wasm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let target = format!("wasm://{}", guest().display());
    let result = forge_cli(&["-", "--target", &target, "--out", out.to_str().unwrap()]);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));

    let mut written = Files::new();
    read_dir(&out, &out, &mut written);
    same(&native(&parse(SPEC.as_bytes())).unwrap(), &written);
    std::fs::remove_dir_all(&out).unwrap();
}

#[test]
fn cli_needs_a_path() {
    let result = forge_cli(&["-", "--target", "wasm://", "--out", "sdk"]);
    assert!(!result.status.success());
    let err = String::from_utf8_lossy(&result.stderr);
    assert!(err.contains("wasm:// needs the path of a plugin"), "{err}");
}

#[test]
fn cli_missing_plugin() {
    let result = forge_cli(&["-", "--target", "wasm://missing.wasm", "--out", "sdk"]);
    assert!(!result.status.success());
    let err = String::from_utf8_lossy(&result.stderr);
    assert!(err.starts_with("forge: missing.wasm: "), "{err}");
}

/// Runs `forge` with `args`, writing [`SPEC`] to it.
fn forge_cli(args: &[&str]) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(SPEC.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

/// Adds every file under `dir` to `files`, by its path from `root`.
fn read_dir(root: &Path, dir: &Path, files: &mut Files) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            read_dir(root, &path, files);
        } else {
            let rel = path.strip_prefix(root).unwrap();
            let rel: Vec<_> = rel.iter().map(|part| part.to_str().unwrap()).collect();
            files.insert(rel.join("/"), std::fs::read(&path).unwrap());
        }
    }
}

/// The guest's copy of the WIT is the one `forge::wasm` has.
#[test]
fn wit_is_current() {
    plugin();
    assert_eq!(std::fs::read_to_string(guest_dir().join("wit/forge.wit")).unwrap(), WIT);
}

#[test]
#[ignore = "set FORGE_SPEC to the documents to benchmark, and build with --release"]
fn bench() {
    let paths = std::env::var_os("FORGE_SPEC").expect("missing FORGE_SPEC");
    let wasm_path = guest();
    println!(
        "\nplugin: {} ({} KB)",
        wasm_path.display(),
        std::fs::metadata(wasm_path).unwrap().len() / 1024
    );

    let start = Instant::now();
    let plugin = WasmPlugin::from_file(wasm_path).unwrap();
    println!("compile: {:?} (once per plugin; cacheable)", start.elapsed());

    let threads = rayon::current_num_threads();
    let single = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();

    for path in std::env::split_paths(&paths).filter(|path| !path.as_os_str().is_empty()) {
        let json = std::fs::read(&path).unwrap();
        let forge = parse(&json);
        let groups = forge.groups().count();

        let start = Instant::now();
        let files = wasm(&forge, &plugin).unwrap();
        let cold = start.elapsed();
        same(&native(&forge).unwrap(), &files);
        let dumped = wasm(&forge, &WasmPlugin::from_file(dump_guest()).unwrap()).unwrap();
        assert!(
            dumped["dump.txt"] == dump::dump(&forge).into_bytes(),
            "the dumps of {} differ",
            path.display()
        );

        println!(
            "\n{} ({} MB, {groups} groups, {} files, identical output and dump)",
            path.display(),
            json.len() / 1_000_000,
            files.len(),
        );
        println!("  first wasm run, instantiating: {cold:?}");
        println!("  {:<22} {:>10} {:>10} {:>8}", "", "native", "wasm", "ratio");
        for (name, pool) in [
            (format!("{threads} threads"), None),
            ("1 thread".to_owned(), Some(&single)),
        ] {
            let run = |f: &(dyn Fn() + Sync)| match pool {
                Some(pool) => pool.install(f),
                None => f(),
            };
            let native = median(|| run(&|| drop(native(&forge).unwrap())));
            let wasm = median(|| run(&|| drop(wasm(&forge, &plugin).unwrap())));
            row(&name, native, wasm);
        }

        // `run` calls `generate` alone before the groups, so it bounds
        // how much the threads can help.
        let native = median(|| {
            let files = bin::ts::Generator.generate(&forge).unwrap();
            files.for_each(|file| drop(file.content().unwrap()));
        });
        let wasm = median(|| plugin.generate(&forge).unwrap().for_each(drop));
        row("serial `generate` only", native, wasm);

        // A group runs on one thread, so the slowest one bounds it too.
        let (native, wasm) = forge
            .groups()
            .map(|group| {
                let native = median(|| {
                    let files = bin::ts::Generator.generate_group(group).unwrap();
                    files.for_each(|file| drop(file.content().unwrap()));
                });
                let wasm = median(|| plugin.generate_group(group).unwrap().for_each(drop));
                (native, wasm)
            })
            .max()
            .unwrap();
        row("slowest group", native, wasm);
    }
}

fn row(name: &str, native: Duration, wasm: Duration) {
    println!(
        "  {name:<22} {:>10} {:>10} {:>7.2}x",
        format!("{native:.1?}"),
        format!("{wasm:.1?}"),
        wasm.as_secs_f64() / native.as_secs_f64(),
    );
}

/// Returns the median time `f` takes, of several runs.
fn median(f: impl Fn()) -> Duration {
    let mut times: Vec<Duration> = (0..7)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed()
        })
        .collect();
    times.sort();
    times[times.len() / 2]
}

fn parse(json: &[u8]) -> Forge {
    serde_json::from_slice(json).unwrap()
}

/// The files of an SDK, by path.
type Files = BTreeMap<String, Vec<u8>>;

/// Runs `plugin` and renders its files as `forge::write` does, in
/// parallel, without writing them.
fn render<P: Plugin>(forge: &Forge, plugin: &P) -> Result<Files, Err> {
    let files = forge::run(forge, plugin)?;
    files
        .into_par_iter()
        .map(|file| Ok((file.path().to_owned(), file.content()?.into_owned())))
        .filter(|file| !matches!(file, Ok((_, content)) if content.is_empty()))
        .collect()
}

fn native(forge: &Forge) -> Result<Files, Err> {
    render(forge, &bin::ts::Generator)
}

fn wasm(forge: &Forge, plugin: &WasmPlugin) -> Result<Files, Err> {
    render(forge, plugin)
}

#[track_caller]
fn same(native: &Files, wasm: &Files) {
    let paths = |files: &Files| files.keys().cloned().collect::<Vec<_>>();
    assert_eq!(paths(wasm), paths(native), "the plugin generated other files");
    for (path, content) in native {
        assert!(
            wasm[path] == *content,
            "{path} differs:\n--- native\n{}\n--- wasm\n{}",
            String::from_utf8_lossy(content),
            String::from_utf8_lossy(&wasm[path]),
        );
    }
}

fn plugin() -> &'static WasmPlugin {
    static PLUGIN: OnceLock<WasmPlugin> = OnceLock::new();
    PLUGIN.get_or_init(|| WasmPlugin::from_file(guest()).unwrap())
}

fn guest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/wasm/ts")
}

/// Builds the guest, after giving it the current WIT, and returns the
/// path of its component.
fn guest() -> &'static Path {
    static GUEST: OnceLock<PathBuf> = OnceLock::new();
    GUEST.get_or_init(|| build_guest("wasm-guest", &[]))
}

/// Builds the guest with the `dump` feature, whose `generate` returns
/// tests/wasm/dump.rs's dump, and returns the path of its component.
fn dump_guest() -> &'static Path {
    static GUEST: OnceLock<PathBuf> = OnceLock::new();
    GUEST.get_or_init(|| build_guest("wasm-guest-dump", &["--features", "dump"]))
}

/// Builds the guest into `target/<dir>`, with `args`, after giving it the
/// current WIT. Builds run one at a time, since they share the guest's
/// sources.
fn build_guest(dir: &str, args: &[&str]) -> PathBuf {
    static BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _build = BUILD.lock().unwrap_or_else(|err| err.into_inner());

    let source = guest_dir();
    let wit = source.join("wit/forge.wit");
    if std::fs::read_to_string(&wit).ok().as_deref() != Some(WIT) {
        std::fs::write(&wit, WIT).unwrap();
    }

    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(dir);
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args(["build", "--release", "--target", "wasm32-wasip2"])
        .args(args)
        .arg("--target-dir")
        .arg(&target)
        .current_dir(&source)
        .status()
        .expect("run cargo");
    assert!(
        status.success(),
        "building the guest failed; is the wasm32-wasip2 target installed?"
    );
    target.join("wasm32-wasip2/release/forge_ts_wasm.wasm")
}
