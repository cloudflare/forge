# Project commands. Run `just --list` to see them all. CI runs these same
# recipes, so a recipe that passes here passes there.
_default:
  just --list -u

alias f := fmt
alias l := lint

# The wasm guest is its own workspace, so the root `cargo fmt` skips it and it
# gets its own run.

# Format the code, including the wasm guest
fmt:
    cargo fmt
    cargo fmt --manifest-path tests/wasm/ts/Cargo.toml

# Check formatting without changing files, as CI does
fmt-check:
    cargo fmt --check
    cargo fmt --check --manifest-path tests/wasm/ts/Cargo.toml

# The second run checks the library alone, as users with
# `default-features = false` build it.

# Run clippy with all features, then with no default features
lint:
    cargo clippy --locked --all-targets --all-features -- -D warnings
    cargo clippy --locked --all-targets --no-default-features -- -D warnings

# Release builds
#
# Every way of getting release binaries puts them in target/binaries/<target>/
# release/, and `just pack` packs whatever is there. CI builds each target
# with `just build` on a native runner. Locally, `just build-all` builds them
# all: macOS targets natively, which needs a Mac, and the rest in Docker.
# `just fetch` downloads a CI run's binaries instead.

# The Rust targets forge ships, as in packages/forge/scripts/platforms.mjs.
mac_targets := "aarch64-apple-darwin x86_64-apple-darwin"
docker_targets := "aarch64-unknown-linux-musl x86_64-unknown-linux-musl aarch64-pc-windows-msvc x86_64-pc-windows-msvc"
binaries := "target/binaries"

# Link the C runtime into the Windows binaries, or they need VCRUNTIME140.dll
# from the Visual C++ Redistributable, which many machines don't have. Both
# `just build` (CI's Windows runners) and `just build-docker` (cargo-xwin, which
# keeps these flags) build with them. Other targets ignore them.
export CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS := "-C target-feature=+crt-static"
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS := "-C target-feature=+crt-static"

# Build the release binary for <target> on this machine
build target:
    rustup target add {{ target }}
    cargo build --release --locked --features wasm --target {{ target }}
    mkdir -p {{ binaries }}/{{ target }}/release
    cp target/{{ target }}/release/{{ if target =~ 'windows' { "forge.exe" } else { "forge" } }} {{ binaries }}/{{ target }}/release/

# Build the release binary for a Linux or Windows <target> in Docker
build-docker target:
    #!/usr/bin/env bash
    set -euo pipefail
    target='{{ target }}'
    rust=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
    case "$target" in
      aarch64-unknown-linux-musl) stage=linux platform=linux/arm64 exe=forge cargo=(cargo build) ;;
      x86_64-unknown-linux-musl) stage=linux platform=linux/amd64 exe=forge cargo=(cargo build) ;;
      *-pc-windows-msvc) stage=windows platform= exe=forge.exe cargo=(cargo xwin build) ;;
      *) echo "error: build-docker builds Linux and Windows targets; build $target with: just build $target" >&2; exit 1 ;;
    esac
    image="forge-release-$stage:$rust${platform:+-${platform#linux/}}"
    # Extra CA certificates for the images to trust, behind a proxy that
    # re-signs HTTPS traffic: FORGE_DOCKER_CA_CERT, or else the bundle Node
    # trusts, NODE_EXTRA_CA_CERTS. They go one per file, because Alpine's
    # update-ca-certificates skips a file that holds more than one.
    ca_dir=target/docker/extra-ca
    rm -rf "$ca_dir" && mkdir -p "$ca_dir"
    ca="${FORGE_DOCKER_CA_CERT:-${NODE_EXTRA_CA_CERTS:-}}"
    if [ -n "$ca" ]; then
      [ -f "$ca" ] || { echo "error: no CA certificate file at $ca" >&2; exit 1; }
      awk -v dir="$ca_dir" '/-----BEGIN CERTIFICATE-----/ { n++; out = sprintf("%s/extra-%d.crt", dir, n) } out { print > out } /-----END CERTIFICATE-----/ { close(out); out = "" }' "$ca"
      echo "==> trusting $(ls "$ca_dir" | wc -l | tr -d ' ') extra CA certificate(s) from $ca"
    fi
    echo "==> $target in $image"
    docker build --quiet ${platform:+--platform "$platform"} --target "$stage" --build-arg "RUST_VERSION=$rust" \
      --build-context "extra-ca=$ca_dir" \
      --tag "$image" --file docker/release.Dockerfile docker >/dev/null
    # Runs as you, so everything it writes under target/ is yours. Each target
    # builds into a directory of its own: the host's target/ holds build
    # scripts compiled for the host, which can't run in the container.
    # RUSTUP_TOOLCHAIN pins the image's Rust, so rustup doesn't try to install
    # the components rust-toolchain.toml lists.
    docker run --rm ${platform:+--platform "$platform"} --user "$(id -u):$(id -g)" \
      --volume "$PWD:/work" --workdir /work \
      --env HOME=/tmp \
      --env CARGO_HOME=/work/target/docker/cargo-home \
      --env CARGO_TARGET_DIR="/work/target/docker/$target" \
      --env XWIN_CACHE_DIR=/work/target/docker/xwin \
      --env RUSTUP_TOOLCHAIN="$rust" \
      --env CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS \
      --env CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS \
      "$image" "${cargo[@]}" --release --locked --features wasm --target "$target"
    mkdir -p "{{ binaries }}/$target/release"
    cp "target/docker/$target/$target/release/$exe" "{{ binaries }}/$target/release/"

# Build every release binary this machine can: macOS ones need a Mac
build-all:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname -s)" = Darwin ]; then
      for target in {{ mac_targets }}; do just build "$target"; done
    else
      echo "warning: skipping {{ mac_targets }}, which build only on a Mac; just fetch gets them from CI" >&2
    fi
    for target in {{ docker_targets }}; do just build-docker "$target"; done

# Download the release binaries a publish-preview run built, instead of building them
fetch run:
    rm -rf target/fetch {{ binaries }}
    gh run download {{ run }} --pattern 'forge-*' --dir target/fetch
    mkdir -p {{ binaries }}
    cp -R target/fetch/forge-*/. {{ binaries }}/
    rm -rf target/fetch

# Pack the binaries in target/binaries into packages/forge/dist/; takes archive.mjs options
pack *args:
    node packages/forge/scripts/archive.mjs --artifacts {{ binaries }} {{ args }}
