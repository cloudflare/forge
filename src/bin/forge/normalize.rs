//! `forge normalize`, which rewrites the extensions other tools' metadata is
//! written with into the native ones, in the files it is given.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use forge::Err;
use forge::normalize::{Normalized, Options, Report, Source, Sources, normalize};

/// A compatibility source named on the command line.
#[derive(Clone, Copy, clap::ValueEnum)]
enum SourceArg {
    Cloudflare,
    Deprecated,
    Fern,
    Stainless,
}

impl From<SourceArg> for Source {
    fn from(source: SourceArg) -> Source {
        match source {
            SourceArg::Cloudflare => Source::Cloudflare,
            SourceArg::Deprecated => Source::Deprecated,
            SourceArg::Fern => Source::Fern,
            SourceArg::Stainless => Source::Stainless,
        }
    }
}

/// What `forge normalize` is given, which says what it does in `main.rs`.
#[derive(clap::Args)]
pub struct Args {
    /// The OpenAPI JSON documents, as paths. A pattern such as `specs/*.json`
    /// is expanded by the shell. One document is printed to standard output,
    /// with nothing changed, unless `--write` is given. Or - to read one from
    /// standard input and print it.
    #[arg(required = true)]
    inputs: Vec<String>,
    /// Rewrite the files in place, each only if there is something to rewrite
    /// in it. Without it nothing is changed, and one document is printed.
    #[arg(short, long, conflicts_with = "check")]
    write: bool,
    /// Keep each key that is rewritten, beside the native key that replaces
    /// it, for what still reads the old one.
    #[arg(long)]
    leave_old_extensions: bool,
    /// Rewrite only keys from this compatibility source. May be repeated.
    /// Without it, keys from every source are rewritten.
    #[arg(long = "from", value_enum)]
    from: Vec<SourceArg>,
    /// Say what would be rewritten, and write nothing. It fails if there is
    /// anything to rewrite, to check that documents are normalized.
    #[arg(long)]
    check: bool,
    /// Say how many times each key was rewritten.
    #[arg(short, long)]
    verbose: bool,
}

/// A file to rewrite.
struct Input {
    /// The path it was given by, which is how it is named.
    shown: PathBuf,
    /// The file it is, with every link followed, which is what is read and
    /// written: a link stays a link, and a file given twice is rewritten once.
    real: PathBuf,
}

/// How a run says what it did.
#[derive(Clone, Copy)]
struct Say {
    check: bool,
    verbose: bool,
    /// Whether the document is printed to standard output, and no file is
    /// rewritten, so that is what is said.
    printed: bool,
}

pub fn run(args: Args) -> Result<(), Err> {
    let sources = if args.from.is_empty() {
        Sources::ALL
    } else {
        args.from.into_iter().map(Source::from).collect()
    };
    let options = Options {
        leave_old_extensions: args.leave_old_extensions,
        sources,
    };
    let say = Say {
        check: args.check,
        verbose: args.verbose,
        printed: !args.write && !args.check,
    };
    if args.inputs.iter().any(|input| input == "-") {
        if args.inputs.len() > 1 {
            return Err("- cannot be given with other inputs".into());
        }
        if args.write {
            return Err("- cannot be given with --write: standard input is not a file to rewrite".into());
        }
        return filter(&options, say);
    }

    let files = unique_files(&args.inputs)?;
    if !args.write && !args.check {
        // Nothing is changed, so there is one document to print.
        let [file] = &files[..] else {
            return Err("several files are only rewritten with --write, or checked with --check".into());
        };
        return print_file(file, &options, say);
    }

    let (mut rewritten, mut unchanged, mut failed) = (0, 0, 0);
    // One file at a time: each is held as a tree of several times its size.
    for input in files {
        let name = input.shown.display().to_string();
        let result = rewrite(&input.real, &options, say).map_err(|err| format!("{name}: {err}"));
        match result {
            Ok(report) => {
                if report.changed() {
                    rewritten += 1;
                } else {
                    unchanged += 1;
                }
                print(&name, &report, say);
            }
            Err(err) => {
                failed += 1;
                eprintln!("forge: {err}");
            }
        }
    }
    let total = rewritten + unchanged;
    if failed > 0 {
        return Err(format!("{failed} {} could not be processed", plural(failed, "file", "files")).into());
    }
    if say.check {
        if rewritten > 0 {
            return Err(format!(
                "{rewritten} of {total} {} would be rewritten",
                plural(total, "file", "files")
            )
            .into());
        }
        eprintln!(
            "forge: {total} {} checked, none would be rewritten",
            plural(total, "file", "files")
        );
    } else {
        eprintln!(
            "forge: {total} {}: {rewritten} rewritten, {unchanged} unchanged",
            plural(total, "file", "files")
        );
    }
    Ok(())
}

/// Returns `one` if `n` is 1, and `many` if it is not.
fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// Rewrites the document read from standard input to standard output.
fn filter(options: &Options, say: Say) -> Result<(), Err> {
    let mut json = Vec::new();
    io::stdin().read_to_end(&mut json)?;
    document(&json, "stdin", options, say)
}

/// Prints the document in the file to standard output, rewritten, and leaves
/// the file as it is.
fn print_file(input: &Input, options: &Options, say: Say) -> Result<(), Err> {
    let name = input.shown.display().to_string();
    reject_yaml(&input.real).map_err(|err| format!("{name}: {err}"))?;
    let json = fs::read(&input.real).map_err(|err| format!("{name}: {err}"))?;
    document(&json, &name, options, say)
}

/// Rewrites `json`, the document called `name`, to standard output.
fn document(json: &[u8], name: &str, options: &Options, say: Say) -> Result<(), Err> {
    let normalized = normalize(json, options).map_err(|err| format!("{name}: {err}"))?;
    if say.check {
        print(name, &normalized.report, say);
        if normalized.report.changed() {
            return Err("the document would be rewritten".into());
        }
        return Ok(());
    }
    let mut out = io::stdout().lock();
    match &normalized.json {
        Some(edited) => out.write_all(edited)?,
        None => out.write_all(json)?,
    }
    // Standard output is held until a line is whole, and what is left at the
    // end, which is all of a document that is one line, is not otherwise
    // known to have been written.
    out.flush()?;
    print(name, &normalized.report, say);
    Ok(())
}

/// Returns the files `inputs` name, each once. A path that is not there is
/// left for reading it to say so, and a pattern such as `specs/*.json` is for
/// the shell to expand, so one that was not is a path that is not there.
fn unique_files(inputs: &[String]) -> Result<Vec<Input>, Err> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for input in inputs {
        if Path::new(input).is_dir() {
            return Err(format!("{input}: is a folder, not a file").into());
        }
        let shown = PathBuf::from(input);
        let real = fs::canonicalize(&shown).unwrap_or_else(|_| shown.clone());
        if seen.insert(Identity::of(&real)) {
            files.push(Input { shown, real });
        }
    }
    Ok(files)
}

/// Which file a path is, so that a file with more than one name, which a hard
/// link is, is found to be one and rewritten once.
#[derive(PartialEq, Eq, Hash)]
enum Identity {
    /// The device it is on, and where on it.
    #[cfg(unix)]
    Inode(u64, u64),
    Path(PathBuf),
}

impl Identity {
    fn of(real: &Path) -> Identity {
        #[cfg(unix)]
        if let Ok(metadata) = fs::metadata(real) {
            use std::os::unix::fs::MetadataExt;

            return Identity::Inode(metadata.dev(), metadata.ino());
        }
        Identity::Path(real.to_owned())
    }
}

/// Refuses the file at `path` if it is YAML, which is not supported yet.
fn reject_yaml(path: &Path) -> Result<(), Err> {
    let yaml = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("yml") || extension.eq_ignore_ascii_case("yaml"));
    if yaml {
        return Err("YAML is not supported yet: convert the document to JSON first".into());
    }
    Ok(())
}

/// Rewrites the file at `path`, if it has a key to rewrite, and says what it
/// found, which is all it does when it is only checking.
fn rewrite(path: &Path, options: &Options, say: Say) -> Result<Report, Err> {
    reject_yaml(path)?;
    let json = fs::read(path)?;
    let Normalized { json, report } = normalize(&json, options)?;
    if let Some(edited) = &json
        && !say.check
    {
        if fs::metadata(path)?.permissions().readonly() {
            return Err("the file is read-only, so it is not rewritten".into());
        }
        write(path, edited)?;
    }
    Ok(report)
}

/// Writes `json` to the file at `path`. It is written beside it first, and put
/// in its place, so that it is never left half written. Where a new file cannot
/// take the place of this one, because it has other links, which would be left
/// with the old one, or because its folder cannot be written to, it is written
/// in place.
fn write(path: &Path, edited: &[u8]) -> Result<(), Err> {
    if linked(path) {
        return Ok(write_in_place(path, edited)?);
    }
    match write_atomically(path, edited) {
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(write_in_place(path, edited)?),
        written => Ok(written?),
    }
}

fn write_in_place(path: &Path, edited: &[u8]) -> io::Result<()> {
    fs::File::create(path)?.write_all(edited)
}

/// Returns whether the file at `path` has other names.
#[cfg(unix)]
fn linked(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(path).is_ok_and(|metadata| metadata.nlink() > 1)
}

#[cfg(not(unix))]
fn linked(_: &Path) -> bool {
    false
}

fn write_atomically(path: &Path, edited: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    let temporary = path.with_file_name(format!(".{name}.forge-normalize-{}", std::process::id()));
    let permissions = fs::metadata(path)?.permissions();
    let written = create_private(&temporary)
        .and_then(|mut file| {
            // Before it has anything in it, so that it is not readable by more
            // than the file it replaces is, at any time.
            file.set_permissions(permissions)?;
            file.write_all(edited)
        })
        .and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Creates the file at `path`, which is not there, and is not a link to
/// another file that is, and that only its owner can read.
fn create_private(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }
    options.open(path)
}

/// Says what was done to the document called `name`, and what was not.
fn print(name: &str, report: &Report, say: Say) {
    if report.changed() {
        let total: usize = report.migrated.values().sum();
        let keys = plural(total, "key", "keys");
        if say.check {
            eprintln!("{name}: would rewrite {total} {keys}");
        } else if say.printed {
            eprintln!("{name}: {total} {keys} rewritten in the output");
        } else {
            eprintln!("{name}: rewrote {total} {keys}");
        }
        if say.verbose {
            for (key, count) in &report.migrated {
                eprintln!("  {key}: {count}");
            }
            if report.joined > 0 {
                eprintln!(
                    "  {} group {} written as a dotted string",
                    report.joined,
                    plural(report.joined, "path", "paths")
                );
            }
        }
    }
}
