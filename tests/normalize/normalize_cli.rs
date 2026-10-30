//! `forge normalize`, the command, on files and on standard input.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

/// A document with one operation, written on one line, with no final newline.
const FERN: &str = r#"{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"x-fern-sdk-group-name":["a"],"x-fern-sdk-method-name":"get","responses":{"204":{"description":"ok"}}}}}}"#;

/// The same document, written native.
const NATIVE: &str = r#"{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"x-forge-group-name":"a","x-forge-method-name":"get","responses":{"204":{"description":"ok"}}}}}}"#;

/// A document with a key from each compatibility source.
const SOURCES: &str = r##"{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"x-fern-sdk-group-name":["a"],"x-fern-sdk-method-name":"get","responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/S"}}}}}}}},"components":{"schemas":{"S":{"type":"object","properties":{"secret":{"type":"string","x-sensitive":true},"hidden":{"type":"string","x-stainless-skip":true}}}}}}"##;

/// A folder of its own to write files in, which is empty.
fn dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("normalize").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs `forge normalize` with `args`, writing `stdin` to it.
fn normalize(args: &[&str], stdin: &str) -> Output {
    forge(&[&["normalize"], args].concat(), stdin)
}

/// Runs `forge normalize --write` with `args`, which rewrites the files in place.
fn rewrite(args: &[&str], stdin: &str) -> Output {
    normalize(&[&["--write"], args].concat(), stdin)
}

/// Runs `forge` with `args`, writing `stdin` to it.
fn forge(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Beside the output being read: a child that has written more than a pipe
    // holds is not reading its input until that is read.
    let mut input = child.stdin.take().unwrap();
    let stdin = stdin.to_owned();
    // A child that exits before it has read it all is not a failure to write.
    let writer = std::thread::spawn(move || input.write_all(stdin.as_bytes()));
    let output = child.wait_with_output().unwrap();
    let _ = writer.join().unwrap();
    output
}

fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap()
}

#[track_caller]
fn succeeded(out: &Output) {
    assert!(out.status.success(), "forge failed: {}", text(&out.stderr));
}

#[track_caller]
fn failed(out: &Output) -> &str {
    assert!(!out.status.success(), "forge succeeded");
    text(&out.stderr)
}

#[test]
fn a_file_is_rewritten_in_place_as_it_was_written() {
    let dir = dir("in-place");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        NATIVE,
        "still on one line, with no final newline"
    );
    let err = text(&out.stderr);
    assert!(err.contains("rewrote 2 keys"), "{err}");
    assert!(
        !err.contains("x-fern-sdk-method-name: 1"),
        "the keys are listed only with -v: {err}"
    );
    assert!(err.contains("1 file: 1 rewritten, 0 unchanged"), "{err}");
    let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
    assert_eq!(leftovers.len(), 1, "no file is left beside it");
}

#[test]
fn a_file_that_needs_nothing_is_left_as_it_is() {
    let dir = dir("native");
    let file = dir.join("spec.json");
    let written = format!("{NATIVE}\n\n");
    fs::write(&file, &written).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(fs::read_to_string(&file).unwrap(), written);
    assert!(
        text(&out.stderr).contains("1 file: 0 rewritten, 1 unchanged"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn the_old_keys_can_be_left() {
    let dir = dir("leave");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();

    succeeded(&rewrite(&["--leave-old-extensions", file.to_str().unwrap()], ""));

    let value: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let operation = &value["paths"]["/a"]["get"];
    assert_eq!(operation["x-fern-sdk-method-name"], "get");
    assert_eq!(operation["x-forge-method-name"], "get");
}

#[test]
fn standard_input_is_written_to_standard_output() {
    let out = normalize(&["-"], FERN);

    succeeded(&out);
    assert_eq!(text(&out.stdout), NATIVE);
}

#[test]
fn from_rewrites_only_the_selected_compatibility_sources_and_may_be_repeated() {
    let out = normalize(&["--from", "fern", "--from", "cloudflare", "-"], SOURCES);

    succeeded(&out);
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    let operation = &value["paths"]["/a"]["get"];
    assert_eq!(operation["x-forge-method-name"], "get");
    assert!(operation.get("x-fern-sdk-method-name").is_none());
    let properties = &value["components"]["schemas"]["S"]["properties"];
    assert_eq!(properties["secret"]["x-forge-sensitive"], true);
    assert!(properties["secret"].get("x-sensitive").is_none());
    assert_eq!(properties["hidden"]["x-stainless-skip"], true);
    assert!(properties["hidden"].get("x-forge-skip").is_none());
}

#[test]
fn deprecated_is_a_compatibility_source_and_currently_has_no_keys() {
    let out = normalize(&["--from", "deprecated", "-"], SOURCES);

    succeeded(&out);
    assert_eq!(text(&out.stdout), SOURCES);
}

#[test]
fn without_from_every_compatibility_source_is_rewritten() {
    let out = normalize(&["-"], SOURCES);

    succeeded(&out);
    let text = text(&out.stdout);
    for old in ["x-fern-", "x-sensitive", "x-stainless-"] {
        assert!(!text.contains(old), "{old} is left in {text}");
    }
}

#[test]
fn standard_input_that_needs_nothing_comes_out_as_it_went_in() {
    let document = format!("  {NATIVE}  \n");

    let out = normalize(&["-"], &document);

    succeeded(&out);
    assert_eq!(text(&out.stdout), document);
}

#[test]
fn standard_input_cannot_be_given_with_files() {
    let out = normalize(&["-", "spec.json"], "");

    let err = failed(&out);

    assert!(err.contains("- cannot be given with other inputs"), "{err}");
}

#[test]
fn a_file_that_is_missing_is_an_error_that_names_it() {
    let out = rewrite(&["missing.json"], "");

    let err = failed(&out);
    assert!(err.contains("forge: missing.json: "), "{err}");
}

#[test]
fn a_file_that_is_not_json_is_an_error_and_the_others_are_still_rewritten() {
    let dir = dir("invalid");
    fs::write(dir.join("a.json"), FERN).unwrap();
    // It has to look like it might change, or it is not parsed.
    fs::write(dir.join("b.json"), r#"{"x-fern-ignore": "#).unwrap();

    let (a, b) = (dir.join("a.json"), dir.join("b.json"));

    let out = rewrite(&[a.to_str().unwrap(), b.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(err.contains("b.json"), "{err}");
    assert!(err.contains("1 file could not be processed"), "{err}");
    assert_eq!(fs::read_to_string(dir.join("a.json")).unwrap(), NATIVE);
    assert_eq!(fs::read_to_string(dir.join("b.json")).unwrap(), r#"{"x-fern-ignore": "#);
}

#[test]
fn a_native_key_wins_and_the_other_is_dropped() {
    let dir = dir("conflict");
    let file = dir.join("spec.json");
    fs::write(
        &file,
        r#"{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"x-fern-sdk-method-name":"old","x-forge-method-name":"new","x-forge-group-name":["a"],"responses":{"204":{"description":"ok"}}}}}}"#,
    )
    .unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    succeeded(&out);
    let written = fs::read_to_string(&file).unwrap();
    assert!(written.contains(r#""x-forge-method-name":"new""#), "{written}");
    assert!(!written.contains("x-fern"), "{written}");
}

#[test]
fn a_group_that_cannot_be_a_dotted_string_is_kept_and_nothing_is_said_about_it() {
    let dir = dir("kept");
    let file = dir.join("spec.json");
    fs::write(&file, FERN.replace(r#"["a"]"#, r#"["a.b"]"#)).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    succeeded(&out);
    let err = text(&out.stderr);
    assert!(
        !err.contains("note") && !err.contains("warning"),
        "an array that is kept is expected: {err}"
    );
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        NATIVE.replace(r#""x-forge-group-name":"a""#, r#""x-forge-group-name":["a.b"]"#),
        "the array is kept, and only the keys are renamed"
    );
}

#[test]
fn what_it_did_is_a_line_for_each_file_and_the_keys_are_listed_with_v() {
    let dir = dir("verbose");
    for name in ["a.json", "b.json"] {
        fs::write(dir.join(name), FERN).unwrap();
    }
    let (a, b) = (dir.join("a.json"), dir.join("b.json"));

    let quiet = rewrite(&[a.to_str().unwrap()], "");
    let verbose = rewrite(&["-v", b.to_str().unwrap()], "");

    let (quiet, verbose) = (text(&quiet.stderr), text(&verbose.stderr));
    assert_eq!(quiet.lines().count(), 2, "{quiet}");
    assert!(verbose.contains("  x-fern-sdk-group-name: 1"), "{verbose}");
    assert!(verbose.contains("  x-fern-sdk-method-name: 1"), "{verbose}");
}

#[test]
fn check_writes_nothing_and_fails_when_there_is_something_to_rewrite() {
    let dir = dir("check");
    let (old, native) = (dir.join("old.json"), dir.join("native.json"));
    fs::write(&old, FERN).unwrap();
    fs::write(&native, NATIVE).unwrap();

    let out = normalize(&["--check", old.to_str().unwrap(), native.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(err.contains("old.json: would rewrite 2 keys"), "{err}");
    assert!(err.contains("forge: 1 of 2 files would be rewritten"), "{err}");
    assert_eq!(fs::read_to_string(&old).unwrap(), FERN, "nothing is written");
}

#[test]
fn check_succeeds_when_there_is_nothing_to_rewrite() {
    let dir = dir("check-clean");
    let file = dir.join("spec.json");
    fs::write(&file, NATIVE).unwrap();

    let out = normalize(&["--check", file.to_str().unwrap()], "");

    succeeded(&out);
    assert!(
        text(&out.stderr).contains("1 file checked, none would be rewritten"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn check_on_standard_input_writes_nothing_and_fails_when_there_is_something_to_rewrite() {
    let out = normalize(&["--check", "-"], FERN);

    let err = failed(&out);
    assert!(err.contains("the document would be rewritten"), "{err}");
    assert!(out.stdout.is_empty(), "nothing is written");
    assert!(normalize(&["--check", "-"], NATIVE).status.success());
}

#[test]
fn a_yaml_file_is_an_error_and_is_not_reported_as_native() {
    let dir = dir("yaml");
    for name in ["spec.yml", "spec.YAML"] {
        fs::write(dir.join(name), "openapi: 3.0.3\nx-fern-ignore: true\n").unwrap();
        let file = dir.join(name);

        let out = rewrite(&[file.to_str().unwrap()], "");

        let err = failed(&out);
        assert!(err.contains("YAML is not supported yet"), "{name}: {err}");
        assert!(err.contains(name), "{name}: {err}");
        assert!(!err.contains("unchanged"), "{name}: {err}");
    }
}

#[test]
fn a_file_that_is_not_json_is_an_error_whatever_it_is_named() {
    let dir = dir("not-an-object");
    for (name, content) in [
        ("yaml.json", "openapi: 3.0.3\nx-fern-ignore: true\n"),
        ("empty.json", ""),
        ("blank.json", "  \n"),
    ] {
        fs::write(dir.join(name), content).unwrap();
        let file = dir.join(name);

        let out = rewrite(&[file.to_str().unwrap()], "");

        let err = failed(&out);
        assert!(err.contains(name), "{name}: {err}");
        assert!(!err.contains("unchanged"), "{name}: {err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), content, "{name} is left as it is");
    }
}

#[test]
fn the_usage_says_forge_normalize_and_the_help_of_forge_lists_the_command() {
    let help = normalize(&["--help"], "");
    let general = forge(&["--help"], "");

    assert!(
        text(&help.stdout).contains("Usage: forge normalize"),
        "{}",
        text(&help.stdout)
    );
    assert!(text(&help.stdout).contains("--check"), "{}", text(&help.stdout));
    assert!(
        text(&help.stdout).contains("--from <FROM>")
            && text(&help.stdout).contains("cloudflare")
            && text(&help.stdout).contains("deprecated")
            && text(&help.stdout).contains("fern")
            && text(&help.stdout).contains("stainless"),
        "{}",
        text(&help.stdout)
    );
    assert!(
        text(&general.stdout).contains("Commands:") && text(&general.stdout).contains("  normalize  "),
        "{}",
        text(&general.stdout)
    );
    assert!(
        text(&general.stdout).contains("forge <COMMAND>"),
        "{}",
        text(&general.stdout)
    );
    let missing = normalize(&[], "");
    assert!(failed(&missing).contains("Usage: forge normalize"));
}

#[cfg(unix)]
#[test]
fn a_link_stays_a_link_and_the_file_it_points_to_is_rewritten() {
    let dir = dir("symlink");
    fs::create_dir_all(dir.join("real")).unwrap();
    fs::create_dir_all(dir.join("links")).unwrap();
    fs::write(dir.join("real/spec.json"), FERN).unwrap();
    std::os::unix::fs::symlink("../real/spec.json", dir.join("links/spec.json")).unwrap();

    let out = rewrite(&[dir.join("links/spec.json").to_str().unwrap()], "");

    succeeded(&out);
    assert!(
        fs::symlink_metadata(dir.join("links/spec.json"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link was replaced by a file"
    );
    assert_eq!(fs::read_to_string(dir.join("real/spec.json")).unwrap(), NATIVE);
    assert!(
        text(&out.stderr).contains("links/spec.json: rewrote 2 keys"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn a_file_given_more_than_once_is_rewritten_once() {
    let dir = dir("twice");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();
    let again = format!("{}/./spec.json", dir.display());

    for _ in 0..5 {
        fs::write(&file, FERN).unwrap();
        let out = rewrite(&[file.to_str().unwrap(), &again], "");

        succeeded(&out);
        assert!(
            text(&out.stderr).contains("1 file: 1 rewritten"),
            "{}",
            text(&out.stderr)
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), NATIVE);
    }
}

/// Nothing is changed unless `--write` says so.
#[test]
fn one_file_is_printed_rewritten_and_is_not_changed_without_write() {
    let dir = dir("print");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();

    let out = normalize(&[file.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(text(&out.stdout), NATIVE);
    assert_eq!(fs::read_to_string(&file).unwrap(), FERN, "the file is as it was");
    assert!(
        text(&out.stderr).contains("spec.json: 2 keys rewritten in the output"),
        "{}",
        text(&out.stderr)
    );
    assert!(!text(&out.stderr).contains("rewrote"), "nothing was written");
}

#[test]
fn a_file_with_nothing_to_rewrite_is_printed_as_it_is() {
    let dir = dir("print-nothing");
    let file = dir.join("spec.json");
    fs::write(&file, NATIVE).unwrap();

    let out = normalize(&[file.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(text(&out.stdout), NATIVE);
    assert_eq!(text(&out.stderr), "");
}

#[test]
fn several_files_are_only_rewritten_with_write_or_checked_with_check() {
    let dir = dir("several");
    let (a, b) = (dir.join("a.json"), dir.join("b.json"));
    fs::write(&a, FERN).unwrap();
    fs::write(&b, FERN).unwrap();
    let both = [a.to_str().unwrap(), b.to_str().unwrap()];

    let out = normalize(&both, "");

    let err = failed(&out);
    assert!(err.contains("--write") && err.contains("--check"), "{err}");
    assert_eq!(text(&out.stdout), "", "nothing is printed");
    assert_eq!(fs::read_to_string(&a).unwrap(), FERN);
    assert_eq!(fs::read_to_string(&b).unwrap(), FERN);

    // The same file twice is one file, which is printed.
    succeeded(&normalize(&[both[0], both[0]], ""));
}

#[test]
fn write_and_check_cannot_be_given_together() {
    let dir = dir("write-check");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();

    let out = normalize(&["--write", "--check", file.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(err.contains("--write") && err.contains("--check"), "{err}");
    assert_eq!(fs::read_to_string(&file).unwrap(), FERN);
}

#[test]
fn standard_input_cannot_be_rewritten_in_place() {
    let out = normalize(&["--write", "-"], FERN);

    let err = failed(&out);
    assert!(err.contains("- cannot be given with --write"), "{err}");
    assert_eq!(text(&out.stdout), "");
}

#[test]
fn write_rewrites_each_file_in_place_and_says_so() {
    let dir = dir("write");
    let (a, b) = (dir.join("a.json"), dir.join("b.json"));
    fs::write(&a, FERN).unwrap();
    fs::write(&b, NATIVE).unwrap();

    let out = rewrite(&[a.to_str().unwrap(), b.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(text(&out.stdout), "", "what is written is the files");
    assert_eq!(fs::read_to_string(&a).unwrap(), NATIVE);
    assert!(
        text(&out.stderr).contains("2 files: 1 rewritten, 1 unchanged"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn a_folder_is_an_error_that_says_so() {
    let dir = dir("a-folder");
    fs::write(dir.join("a.json"), FERN).unwrap();

    let out = rewrite(&[dir.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(err.contains("is a folder, not a file"), "{err}");
    assert_eq!(
        fs::read_to_string(dir.join("a.json")).unwrap(),
        FERN,
        "nothing in it is rewritten"
    );
}

#[test]
fn a_pattern_is_for_the_shell_and_is_not_expanded() {
    let dir = dir("pattern");
    fs::write(dir.join("a.json"), FERN).unwrap();

    let out = rewrite(&[&format!("{}/*.json", dir.display())], "");

    let err = failed(&out);
    assert!(err.contains("*.json: "), "{err}");
    assert_eq!(fs::read_to_string(dir.join("a.json")).unwrap(), FERN);
}

#[test]
fn a_file_whose_name_has_glob_characters_is_that_file() {
    let dir = dir("brackets");
    let file = dir.join("spec[1].json");
    fs::write(&file, FERN).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    succeeded(&out);
    assert_eq!(fs::read_to_string(&file).unwrap(), NATIVE);
}

#[cfg(unix)]
#[test]
fn a_read_only_file_is_not_rewritten() {
    use std::os::unix::fs::PermissionsExt;

    let dir = dir("read-only");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");
    let check = normalize(&["--check", file.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(
        err.contains("spec.json: the file is read-only, so it is not rewritten"),
        "{err}"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), FERN);
    assert!(
        text(&check.stderr).contains("would rewrite 2 keys"),
        "a check only reads: {}",
        text(&check.stderr)
    );
}

#[test]
fn a_byte_order_mark_is_an_error_and_the_file_is_left_as_it_is() {
    let dir = dir("bom");
    let file = dir.join("spec.json");
    let content = format!("\u{feff}{FERN}");
    fs::write(&file, &content).unwrap();

    let out = rewrite(&[file.to_str().unwrap()], "");

    let err = failed(&out);
    assert!(err.contains("spec.json: expected value at line 1 column 1"), "{err}");
    assert_eq!(fs::read_to_string(&file).unwrap(), content);
}

#[test]
fn standard_input_is_called_stdin_and_a_failure_on_it_says_so() {
    let out = normalize(&["-"], FERN);
    let broken = normalize(&["-"], "{\"x-fern-ignore\": ");

    assert!(
        text(&out.stderr).starts_with("stdin: 2 keys rewritten in the output"),
        "{}",
        text(&out.stderr)
    );
    assert!(failed(&broken).contains("forge: stdin: "), "{}", text(&broken.stderr));
}

#[test]
fn v_says_how_many_group_paths_were_joined() {
    let dir = dir("joined");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();

    let out = rewrite(&["-v", file.to_str().unwrap()], "");

    assert!(
        text(&out.stderr).contains("  1 group path written as a dotted string"),
        "{}",
        text(&out.stderr)
    );
}

#[cfg(unix)]
#[test]
fn a_hard_link_stays_a_link_to_the_file_that_is_rewritten() {
    let dir = dir("hard-link");
    let (a, b) = (dir.join("a.json"), dir.join("b.json"));
    fs::write(&a, FERN).unwrap();
    fs::hard_link(&a, &b).unwrap();

    succeeded(&rewrite(&[a.to_str().unwrap()], ""));

    assert_eq!(fs::read_to_string(&a).unwrap(), NATIVE);
    assert_eq!(
        fs::read_to_string(&b).unwrap(),
        NATIVE,
        "the other name is the same file, which is rewritten"
    );
}

#[cfg(unix)]
#[test]
fn two_names_of_one_file_are_one_file_and_are_rewritten_once() {
    let dir = dir("hard-links-given");
    let (a, b) = (dir.join("a.json"), dir.join("b.json"));
    fs::write(&a, FERN).unwrap();
    fs::hard_link(&a, &b).unwrap();

    let out = rewrite(&[a.to_str().unwrap(), b.to_str().unwrap()], "");

    succeeded(&out);
    assert!(
        text(&out.stderr).contains("1 file: 1 rewritten"),
        "{}",
        text(&out.stderr)
    );
    assert_eq!(fs::read_to_string(&b).unwrap(), NATIVE);
}

#[cfg(unix)]
#[test]
fn a_file_in_a_folder_that_cannot_be_written_to_is_rewritten_in_place() {
    use std::os::unix::fs::PermissionsExt;

    let dir = dir("read-only-folder");
    let file = dir.join("spec.json");
    fs::write(&file, FERN).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    // The folder cannot be written to, unless this is run as the owner of
    // everything, which it is not a test of.
    if fs::write(dir.join("probe"), "").is_ok() {
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }

    let out = rewrite(&[file.to_str().unwrap()], "");

    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    succeeded(&out);
    assert_eq!(fs::read_to_string(&file).unwrap(), NATIVE);
}
