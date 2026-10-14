# Project commands. Run `just --list` to see them all. CI runs these same
# recipes, so a recipe that passes here passes there.

alias f := fmt
alias l := lint

# The wasm guest is its own workspace, so the root `cargo fmt` skips it and it
# gets its own run.

# Check formatting, including the wasm guest
fmt:
    cargo fmt --check
    cargo fmt --check --manifest-path tests/wasm/ts/Cargo.toml

# The second run checks the library alone, as users with
# `default-features = false` build it.

# Run clippy with all features, then with no default features
lint:
    cargo clippy --locked --all-targets --all-features -- -D warnings
    cargo clippy --locked --all-targets --no-default-features -- -D warnings
