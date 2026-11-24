//! Process-wide stderr logging for the `forge` CLI.
//!
//! Configured once at startup from `--log-level`, `-v`/`--verbose`, or the
//! `FORGE_LOG` environment variable. Defaults to `warn` so normal runs stay
//! quiet on stderr unless something needs attention.

use std::fmt;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU8, Ordering};

/// Log severity, ordered from quietest to loudest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, clap::ValueEnum)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }

    /// Maps `-v` count to a log level: 0 -> `warn`, 1 -> `info`, 2 -> `debug`,
    /// 3+ -> `trace`.
    pub fn from_verbose(count: u8) -> Level {
        match count {
            0 => Level::Warn,
            1 => Level::Info,
            2 => Level::Debug,
            _ => Level::Trace,
        }
    }

    /// Parses a level name (case-insensitive), for `FORGE_LOG`.
    fn parse_env(s: &str) -> Option<Level> {
        match s.trim().to_ascii_lowercase().as_str() {
            "error" => Some(Level::Error),
            "warn" | "warning" => Some(Level::Warn),
            "info" => Some(Level::Info),
            "debug" => Some(Level::Debug),
            "trace" => Some(Level::Trace),
            _ => None,
        }
    }
}

/// Resolves the effective log level from CLI flags (`--log-level`, `-v`) and
/// `FORGE_LOG`, defaulting to `warn`.
pub fn resolve(explicit: Option<Level>, verbose: u8) -> Level {
    match explicit {
        Some(level) => level,
        None if verbose > 0 => Level::from_verbose(verbose),
        None => std::env::var("FORGE_LOG")
            .ok()
            .and_then(|v| Level::parse_env(&v))
            .unwrap_or(Level::Warn),
    }
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
    let _ = writeln!(lock, "{}: {args}", level.as_str());
}

macro_rules! warn_impl {
    ($($arg:tt)*) => {
        $crate::log::emit($crate::log::Level::Warn, format_args!($($arg)*))
    };
}

macro_rules! info_impl {
    ($($arg:tt)*) => {
        $crate::log::emit($crate::log::Level::Info, format_args!($($arg)*))
    };
}

macro_rules! debug_impl {
    ($($arg:tt)*) => {
        $crate::log::emit($crate::log::Level::Debug, format_args!($($arg)*))
    };
}

pub(crate) use {debug_impl as debug, info_impl as info, warn_impl as warn};
