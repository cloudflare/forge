//! Runs the `forge` command.

use std::io::Write;
use std::process::{Command, Output, Stdio};

/// A document with one method, `a.get`.
const SPEC: &str = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {
        "x-forge-group-name": ["a"],
        "x-forge-method-name": "get",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}"#;

/// Runs `forge` with `args`, writing `stdin` to it.
fn forge(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

/// Returns the standard error of `out`, and panics if `forge` succeeded.
#[track_caller]
fn failure(out: Output) -> String {
    assert!(!out.status.success(), "forge succeeded");
    String::from_utf8(out.stderr).unwrap()
}

#[test]
fn flags_are_required() {
    let err = failure(forge(&["-"], SPEC));
    assert!(err.contains("--target <TARGET>"), "{err}");
    assert!(err.contains("--out <OUT>"), "{err}");
}

#[test]
fn unknown_target() {
    let err = failure(forge(&["-", "--target", "go", "--out", "sdk"], SPEC));
    assert!(err.contains("invalid value 'go'"), "{err}");
    assert!(err.contains("possible values: ts, capnweb"), "{err}");
}

#[test]
fn missing_spec() {
    let err = failure(forge(&["missing.json", "--target", "ts", "--out", "sdk"], ""));
    assert!(err.starts_with("forge: missing.json: "), "{err}");
}

#[test]
fn invalid_spec() {
    let err = failure(forge(&["-", "--target", "ts", "--out", "sdk"], "{"));
    assert!(err.starts_with("forge: -: "), "{err}");
}

#[test]
fn ts() {
    let out = std::env::temp_dir().join(format!("forge-cli-ts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "ts", "--out", out.to_str().unwrap()], SPEC);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for name in [
        "index.ts",
        "client.ts",
        "a/index.ts",
        "a/client.ts",
        "_/index.ts",
        "_/hooks/envelope.ts",
    ] {
        assert!(out.join(name).is_file(), "{name} is missing");
    }
    let client = std::fs::read_to_string(out.join("a/client.ts")).unwrap();
    assert!(
        client.contains("get(request?: GetRequest, options?: RequestOptions): Promise<GetResponse>;"),
        "{client}"
    );
    std::fs::remove_dir_all(&out).unwrap();
}

#[test]
fn capnweb() {
    let out = std::env::temp_dir().join(format!("forge-cli-capnweb-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "capnweb", "--out", out.to_str().unwrap()], SPEC);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for name in ["index.ts", "options.ts", "server.ts", "a/index.ts", "a/server.ts"] {
        assert!(out.join(name).is_file(), "{name} is missing");
    }
    let server = std::fs::read_to_string(out.join("a/server.ts")).unwrap();
    assert!(
        server.contains("get(request?: GetRequest, options?: Options): Promise<GetResponse> {"),
        "{server}"
    );
    std::fs::remove_dir_all(&out).unwrap();
}

/// A config that names the one operation of [`GATEKEEPER_SPEC`].
const GATEKEEPER_CONFIG: &str = r#"{"operations": {"a/get": {"group": "a", "name": "get"}}}"#;

/// A document with one operation, `a/get`, and one the config leaves out.
const GATEKEEPER_SPEC: &str = r#"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a": {
      "get": {"operationId": "a/get", "responses": {"200": {"description": "ok"}}},
      "delete": {"operationId": "a/delete", "responses": {"204": {"description": "ok"}}}
    }
  }
}"#;

#[test]
fn gatekeeper() {
    let dir = std::env::temp_dir().join(format!("forge-cli-gatekeeper-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("gatekeeper.json");
    std::fs::write(&config, GATEKEEPER_CONFIG).unwrap();
    let out = dir.join("api");
    let result = forge(
        &[
            "-",
            "--target",
            "gatekeeper",
            "--config",
            config.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ],
        GATEKEEPER_SPEC,
    );
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for name in [
        "index.ts",
        "read.ts",
        "write.ts",
        "a/client.ts",
        "a/read.ts",
        "_/index.ts",
        "operations.json",
        "GUIDE.md",
        "WORKSHEET.md",
    ] {
        assert!(out.join(name).is_file(), "{name} is missing");
    }
    let client = std::fs::read_to_string(out.join("a/client.ts")).unwrap();
    assert!(
        client.contains("get(request?: GetRequest, options?: RequestOptions): Promise<Result<GetResponse>>;"),
        "{client}"
    );
    assert!(!client.contains("delete("), "{client}");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A document with a read that has a path parameter, and a write.
const GATEKEEPER_CLIENTS_SPEC: &str = r##"{
  "openapi": "3.0.3",
  "info": {"title": "t", "version": "1"},
  "paths": {
    "/a/{id}": {
      "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
      "get": {
        "operationId": "a/get",
        "responses": {
          "200": {"description": "ok", "content": {"application/json": {"schema": {
            "type": "object",
            "properties": {"full_name": {"type": "string"}}
          }}}}
        }
      },
      "delete": {"operationId": "a/delete", "responses": {"204": {"description": "ok"}}}
    }
  }
}"##;

const GATEKEEPER_CLIENTS_CONFIG: &str = r#"{
  "operations": {
    "a/get": {"group": "a", "name": "get", "conditional": true},
    "a/delete": {"group": "a", "name": "remove"}
  }
}"#;

/// A program that uses the clients of [`GATEKEEPER_CLIENTS_SPEC`] over a
/// provider that answers from a list. It fails to compile if a client has a
/// method of the other, and throws if the clients do not behave.
const GATEKEEPER_CLIENTS_CHECK: &str = r#"
import { ApiError, type ProviderRequest, type ProviderResponse } from './api/index.js';
import { createReadClient } from './api/read.js';
import { createWriteClient } from './api/write.js';

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

const sent: ProviderRequest[] = [];
const answers: ProviderResponse[] = [];
const provider = {
  async send(request: ProviderRequest): Promise<ProviderResponse> {
    sent.push(request);
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer');
    return next;
  },
};
const reads = createReadClient({ provider });
const writes = createWriteClient({ provider });

// @ts-expect-error The client of reads has no method that writes.
reads.a.remove;
// @ts-expect-error The client of writes has no method that reads.
writes.a.get;
check(!('remove' in reads.a) && !('get' in writes.a), 'a client has a method of the other');

answers.push({ status: 200, headers: new Headers({ etag: '"e"' }), text: '{"full_name":"x"}' });
const first = await reads.a.get({ id: '1' });
if (first.notModified) throw new Error('a 200 is not modified');
check(first.data.fullName === 'x', 'the body is not decoded');
check(first.headers.get('etag') === '"e"', 'the headers are missing');
const request = sent[0];
check(request?.operationId === 'a/get' && request.kind === 'read', 'the request has no operation');
check(request?.path === '/a/1' && request.query.toString() === '', 'the path is wrong');

answers.push({ status: 304, headers: new Headers(), text: '' });
const again = await reads.a.get({ id: '1' }, { headers: { 'if-none-match': '"e"' } });
check(again.notModified === true, 'a 304 is not returned');
check(sent[1]?.headers.get('if-none-match') === '"e"', 'the header is not sent');

let refused = false;
try {
  await writes.a.remove({ id: '..' });
} catch (error) {
  refused = error instanceof TypeError;
}
check(refused && sent.length === 2, 'a dot segment is sent');

answers.push({ status: 404, headers: new Headers(), text: '{"message":"gone"}' });
let thrown: unknown;
try {
  await writes.a.remove({ id: '1' });
} catch (error) {
  thrown = error;
}
check(thrown instanceof ApiError && thrown.status === 404, 'an error response is not thrown');
check(sent[2]?.method === 'DELETE' && sent[2].kind === 'write', 'the write is not sent');
"#;

/// The generated clients compile under strict TypeScript, and behave over a
/// provider. It needs the dependencies of the runtime library, which
/// `pnpm install` gets, and Node, and is skipped without them.
#[test]
fn gatekeeper_clients_compile_and_run() {
    let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/forge/gatekeeper/lib");
    let tsc = lib.join("node_modules/.bin/tsc");
    if !tsc.is_file() {
        eprintln!("skipped: {} is missing, run pnpm install", tsc.display());
        return;
    }
    let dir = std::env::temp_dir().join(format!("forge-cli-gatekeeper-clients-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("gatekeeper.json");
    std::fs::write(&config, GATEKEEPER_CLIENTS_CONFIG).unwrap();
    let out = dir.join("api");
    let result = forge(
        &[
            "-",
            "--target",
            "gatekeeper",
            "--config",
            config.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ],
        GATEKEEPER_CLIENTS_SPEC,
    );
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    // The output is modules, so that the program can await.
    std::fs::write(dir.join("package.json"), r#"{"type": "module"}"#).unwrap();
    std::fs::write(dir.join("check.ts"), GATEKEEPER_CLIENTS_CHECK).unwrap();
    let run = |program: &std::path::Path, args: &[&str]| {
        let result = Command::new(program).args(args).current_dir(&dir).output().unwrap();
        assert!(
            result.status.success(),
            "{} {args:?}:\n{}{}",
            program.display(),
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    };
    run(
        &tsc,
        &[
            "--strict",
            "--exactOptionalPropertyTypes",
            "--noUncheckedIndexedAccess",
            "--target",
            "es2022",
            "--module",
            "nodenext",
            "--moduleResolution",
            "nodenext",
            "--lib",
            "esnext,dom",
            "--skipLibCheck",
            "--rootDir",
            ".",
            "--outDir",
            "js",
            "check.ts",
            "api/index.ts",
        ],
    );
    std::fs::write(dir.join("js/package.json"), r#"{"type": "module"}"#).unwrap();
    run(std::path::Path::new("node"), &["js/check.js"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn gatekeeper_needs_a_config() {
    let err = failure(forge(&["-", "--target", "gatekeeper", "--out", "api"], GATEKEEPER_SPEC));
    assert!(err.starts_with("forge: --target gatekeeper needs --config"), "{err}");
}

#[test]
fn config_is_only_for_gatekeeper() {
    let err = failure(forge(
        &["-", "--target", "ts", "--config", "c.json", "--out", "sdk"],
        SPEC,
    ));
    assert_eq!(err, "forge: --config is only for --target gatekeeper\n");
}

#[test]
fn missing_config() {
    let err = failure(forge(
        &[
            "-",
            "--target",
            "gatekeeper",
            "--config",
            "missing.json",
            "--out",
            "api",
        ],
        GATEKEEPER_SPEC,
    ));
    assert!(err.starts_with("forge: missing.json: "), "{err}");
}
