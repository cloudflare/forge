//! Safe in-place file replacement shared by `forge normalize` and
//! `forge openapi overlay`.
//!
//! Writes to a private sibling temp file first, copies the original file's
//! permissions before writing any bytes, and renames atomically over the
//! target so concurrent readers never see a truncated file. Falls back to an
//! in-place write when the target has hard links (renaming would detach them)
//! or when the parent directory is read-only.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use forge::Err;

/// Replaces the existing file at `path` with `bytes`, preserving its
/// permissions and hard links and refusing to overwrite read-only files.
pub fn replace_in_place(path: &Path, bytes: &[u8]) -> Result<(), Err> {
    if fs::metadata(path)?.permissions().readonly() {
        return Err("the file is read-only, so it is not rewritten".into());
    }
    if linked(path) {
        return Ok(write_in_place(path, bytes)?);
    }
    match write_atomically(path, bytes) {
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(write_in_place(path, bytes)?),
        written => Ok(written?),
    }
}

fn write_in_place(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::File::create(path)?.write_all(bytes)
}

/// Returns whether the file at `path` has other hard links.
#[cfg(unix)]
fn linked(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(path).is_ok_and(|metadata| metadata.nlink() > 1)
}

#[cfg(not(unix))]
fn linked(_: &Path) -> bool {
    false
}

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    let pid = std::process::id();
    let permissions = fs::metadata(path)?.permissions();

    // Retry on AlreadyExists so concurrent invocations sharing a directory
    // never clobber each other's temp file.
    let (temporary, mut file) = {
        let mut attempt = 0u32;
        loop {
            let candidate = path.with_file_name(format!(".{name}.forge-{pid}-{attempt}.tmp"));
            match create_private(&candidate) {
                Ok(file) => break (candidate, file),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempt < 1000 => {
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    };

    let written = (|| -> io::Result<()> {
        // Apply original permissions before writing bytes so the temp file is
        // never readable by more users than the target file is.
        file.set_permissions(permissions)?;
        file.write_all(bytes)?;
        drop(file);
        fs::rename(&temporary, path)
    })();

    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Creates a brand-new file at `path` (`O_EXCL`), readable only by its owner
/// on Unix until the target file's permissions are applied.
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
