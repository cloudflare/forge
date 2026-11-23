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

/// Runs `forge generate` with `args`, writing `stdin` to it.
fn generate(args: &[&str], stdin: &str) -> Output {
    forge("generate", args, stdin)
}

/// Runs `forge inspect` with `args`, writing `stdin` to it.
fn inspect(args: &[&str], stdin: &str) -> Output {
    forge("inspect", args, stdin)
}

/// Runs the `forge` subcommand `command` with `args`, writing `stdin` to it.
fn forge(command: &str, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .arg(command)
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
    let err = failure(generate(&["-"], SPEC));
    assert!(err.contains("--target <TARGET>"), "{err}");
    assert!(err.contains("--out <OUT>"), "{err}");
}

#[test]
fn unknown_target() {
    let err = failure(generate(&["-", "--target", "go", "--out", "sdk"], SPEC));
    assert!(err.contains("invalid value 'go'"), "{err}");
    assert!(err.contains("possible values: ts, capnweb"), "{err}");
}

#[test]
fn missing_spec() {
    let err = failure(generate(&["missing.json", "--target", "ts", "--out", "sdk"], ""));
    assert!(err.starts_with("forge: missing.json: "), "{err}");
}

#[test]
fn invalid_spec() {
    let err = failure(generate(&["-", "--target", "ts", "--out", "sdk"], "{"));
    assert!(err.starts_with("forge: -: "), "{err}");
}

#[test]
fn ts() {
    let out = std::env::temp_dir().join(format!("forge-cli-ts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = generate(&["-", "--target", "ts", "--out", out.to_str().unwrap()], SPEC);
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
    let result = generate(&["-", "--target", "capnweb", "--out", out.to_str().unwrap()], SPEC);
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

/// `forge` with no arguments prints the top-level help on stdout and exits
/// successfully, so it reads cleanly in a pager or pipeline. Every other
/// invalid invocation keeps the usual stderr-and-exit-2 shape.
#[test]
fn no_arguments_print_help_on_stdout_with_exit_zero() {
    let out = Command::new(env!("CARGO_BIN_EXE_forge")).output().unwrap();

    assert!(out.status.success(), "status: {:?}", out.status);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        out.stderr.is_empty(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("Usage: forge <COMMAND>"), "{stdout}");
    assert!(stdout.contains("generate"), "{stdout}");
    assert!(stdout.contains("normalize"), "{stdout}");
    assert!(stdout.contains("inspect"), "{stdout}");
}

/// An unknown subcommand still errors on stderr with status 2, so scripts
/// that watch exit codes keep catching bad invocations.
#[test]
fn an_unknown_subcommand_errors_on_stderr_with_exit_two() {
    let out = Command::new(env!("CARGO_BIN_EXE_forge"))
        .arg("not-a-command")
        .output()
        .unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stdout.is_empty(),
        "stdout: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr.contains("unrecognized subcommand 'not-a-command'"), "{stderr}");
}

#[test]
fn inspect_methods() {
    let spec = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/zones/{zone_id}/dns_records": {
          "get": {
            "x-forge-group-name": "dns.records",
            "x-forge-method-name": "listRecords",
            "x-forge-availability": "beta",
            "responses": {"200": {"description": "ok"}}
          },
          "post": {
            "operationId": "dns.records.create",
            "x-forge-hidden": true,
            "deprecated": true,
            "responses": {"200": {"description": "ok"}}
          },
          "put": {
            "operationId": "dns.records.skipped",
            "x-forge-skip": true,
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/user": {
          "get": {
            "operationId": "getUser",
            "responses": {"200": {"description": "ok"}}
          }
        }
      }
    }"#;
    let out = inspect(&["methods", "-"], spec);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let methods: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        methods,
        serde_json::json!([
            {
                "group": [],
                "name": "get-user",
                "method": "GET",
                "path": "/user",
                "hidden": false,
                "deprecated": false,
                "availability": null
            },
            {
                "group": ["dns", "records"],
                "name": "create",
                "method": "POST",
                "path": "/zones/{zone_id}/dns_records",
                "hidden": true,
                "deprecated": true,
                "availability": null
            },
            {
                "group": ["dns", "records"],
                "name": "list-records",
                "method": "GET",
                "path": "/zones/{zone_id}/dns_records",
                "hidden": false,
                "deprecated": false,
                "availability": "beta"
            }
        ])
    );
}

#[test]
fn inspect_methods_of_an_invalid_document() {
    let spec = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/a": {
          "get": {
            "operationId": "a.get",
            "responses": {"200": {"description": "ok"}}
          },
          "post": {
            "operationId": "a.get",
            "responses": {"200": {"description": "ok"}}
          }
        }
      }
    }"#;
    let err = failure(inspect(&["methods", "-"], spec));
    assert!(err.contains("in the same group"), "{err}");
}

#[test]
fn inspect_methods_filters_with_conditions_flag() {
    let spec = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/a": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "get",
            "x-forge-skip": ["terraform"],
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/b": {
          "get": {
            "x-forge-group-name": "b",
            "x-forge-method-name": "get",
            "x-forge-only-for": ["sdk"],
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/c": {
          "get": {
            "x-forge-group-name": "c",
            "x-forge-method-name": "get",
            "x-forge-only-for": ["mcp"],
            "responses": {"200": {"description": "ok"}}
          }
        }
      }
    }"#;

    let names = |args: &[&str]| -> Vec<String> {
        let out = inspect(args, spec);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let list: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
        list.into_iter()
            .map(|entry| {
                let group = entry["group"][0].as_str().unwrap();
                let name = entry["name"].as_str().unwrap();
                format!("{group}.{name}")
            })
            .collect()
    };

    // Omitted `--conditions`: active set is empty, so only `/a` is kept.
    assert_eq!(names(&["methods", "-"]), ["a.get"]);
    // Comma-separated conditions: `sdk,mcp` keeps all three.
    assert_eq!(
        names(&["methods", "--conditions=sdk,mcp", "-"]),
        ["a.get", "b.get", "c.get"]
    );
    // Repeated `--conditions` flags combine.
    assert_eq!(
        names(&["methods", "--conditions=terraform", "--conditions=sdk", "-"]),
        ["b.get"]
    );
}

#[test]
fn generate_filters_with_conditions_flag() {
    let spec = r#"{
      "openapi": "3.0.3",
      "info": {"title": "t", "version": "1"},
      "paths": {
        "/a": {
          "get": {
            "x-forge-group-name": "a",
            "x-forge-method-name": "get",
            "x-forge-skip": ["sdk"],
            "responses": {"200": {"description": "ok"}}
          }
        },
        "/b": {
          "get": {
            "x-forge-group-name": "b",
            "x-forge-method-name": "get",
            "x-forge-only-for": ["sdk"],
            "responses": {"200": {"description": "ok"}}
          }
        }
      }
    }"#;

    let out = std::env::temp_dir().join(format!("forge-cli-conditions-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = generate(
        &[
            "-",
            "--target",
            "ts",
            "--conditions=sdk",
            "--out",
            out.to_str().unwrap(),
        ],
        spec,
    );
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(
        !out.join("a/client.ts").exists(),
        "skipped group a should not be emitted"
    );
    assert!(out.join("b/client.ts").is_file(), "only-for group b should be emitted");
    std::fs::remove_dir_all(&out).unwrap();
}
