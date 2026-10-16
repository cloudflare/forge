# Images for building forge's release binaries locally, for the targets a
# machine can't build natively. `just build-docker <target>` builds and runs
# them; see the justfile. CI builds on native runners instead.
#
# The justfile sets RUST_VERSION to the channel in rust-toolchain.toml, so the
# containers build with the same Rust as CI. The default, the latest 1.x,
# only keeps the image names valid for a plain `docker build`.
#
# The images also trust any .crt files in docker/certs/, which is gitignored.

ARG RUST_VERSION=1

# Linux: musl, so the binary is static and runs on any distro. Alpine is
# musl-based, so its C compiler targets musl too, which the cc crate uses
# for wasmtime's C code. Run with --platform linux/arm64 or linux/amd64 to
# build for that architecture.
FROM rust:${RUST_VERSION}-alpine AS linux
COPY certs/ /tmp/certs/
RUN find /tmp/certs -name '*.crt' -exec cp {} /usr/local/share/ca-certificates/ \; \
    && update-ca-certificates \
    && apk add --no-cache musl-dev

# Windows: MSVC, cross-compiled with cargo-xwin, which downloads Microsoft's
# CRT and Windows SDK on first use. clang, lld and llvm are its toolchain.
FROM rust:${RUST_VERSION}-slim-bookworm AS windows
ARG CARGO_XWIN_VERSION=0.23.1
COPY certs/ /tmp/certs/
RUN find /tmp/certs -name '*.crt' -exec cp {} /usr/local/share/ca-certificates/ \; \
    && update-ca-certificates
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang lld llvm \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked cargo-xwin --version "${CARGO_XWIN_VERSION}" --root /usr/local \
    && rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc
