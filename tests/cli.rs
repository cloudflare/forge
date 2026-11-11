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
    for name in ["index.ts", "a/client.ts", "_/index.ts", "operations.json"] {
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
