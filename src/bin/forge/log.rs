//! Process-wide stderr logging for the `forge` CLI.
//!
//! Configured once at startup from `--log-level` or the `FORGE_LOG`
//! environment variable. Defaults to `warn` so normal runs stay quiet on
//! stderr unless something needs attention.

use std::fmt;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU8, Ordering};

use strum::{Display, EnumString, VariantNames};

/// Log severity, ordered from quietest to loudest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Display, EnumString, VariantNames)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl Level {
    /// Parses a level name (case-insensitive) for `--log-level`.
    pub fn parse(s: &str) -> Result<Level, String> {
        s.trim().parse::<Level>().map_err(|_| {
            format!(
                "unrecognized log level {s}, possible values: {}",
                Level::VARIANTS.join(", "),
            )
        })
    }
}

/// Resolves the effective log level from `--log-level` and `FORGE_LOG`,
/// defaulting to `warn`.
pub fn resolve(explicit: Option<Level>) -> Level {
    explicit
        .or_else(|| std::env::var("FORGE_LOG").ok().and_then(|v| v.trim().parse().ok()))
        .unwrap_or(Level::Warn)
}

static MAX_LEVEL: AtomicU8 = AtomicU8::new(Level::Warn as u8);

/// Sets the active log level for the process.
pub fn init(level: Level) {
    MAX_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// True when messages at `level` should be emitted.
pub fn enabled(level: Level) -> bool {
    (level as u8) <= MAX_LEVEL.load(Ordering::Relaxed)
}

/// Writes one log line to stderr when `level` is enabled.
pub fn emit(level: Level, args: fmt::Arguments<'_>) {
    if !enabled(level) {
        return;
    }
    let stderr = io::stderr();
    let mut lock = stderr.lock();
    let _ = writeln!(lock, "{level}: {args}");
}

macro_rules! warn_impl {
    ($($arg:tt)*) => {
        if $crate::log::enabled($crate::log::Level::Warn) {
            $crate::log::emit($crate::log::Level::Warn, format_args!($($arg)*));
        }
    };
}

macro_rules! info_impl {
    ($($arg:tt)*) => {
        if $crate::log::enabled($crate::log::Level::Info) {
            $crate::log::emit($crate::log::Level::Info, format_args!($($arg)*));
        }
    };
}

macro_rules! debug_impl {
    ($($arg:tt)*) => {
        if $crate::log::enabled($crate::log::Level::Debug) {
            $crate::log::emit($crate::log::Level::Debug, format_args!($($arg)*));
        }
    };
}

pub(crate) use {debug_impl as debug, info_impl as info, warn_impl as warn};
