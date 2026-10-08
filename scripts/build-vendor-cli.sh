#!/bin/bash
set -euo pipefail

# Build the Cloudflare fork of the Fern CLI as an npm tarball for a downstream
# repo to vendor. Nothing is published; commit the tarball into the consumer
# and depend on it via
#   "fern-api": "file:<path>/fern-api-<version>.tgz"
# The package installs the `fern` command.
#
# Usage: scripts/build-vendor-cli.sh [output-dir]   (default: ./vendor-out)
# Writes fern-api-<version>.tgz and appends to SHA256SUMS in output-dir.
#
# The version is the upstream CLI version this branch is based on, so the
# CLI's version check matches the fern.config.json consumers write. Two builds
# on the same base share a version; tell them apart by the SHA-256 and the
# `gitHead` field in the tarball's package.json (the commit it was built from).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$(mkdir -p "${1:-$REPO_ROOT/vendor-out}" && cd "${1:-$REPO_ROOT/vendor-out}" && pwd)"

cd "$REPO_ROOT"
VERSION=$(grep -m1 '^- version:' packages/cli/cli/versions.yml | sed 's/^- version: *//; s/["'\'']//g')
TARBALL="fern-api-${VERSION}.tgz"
CLI_GIT_HEAD=$(git rev-parse HEAD)
export CLI_GIT_HEAD

echo "==> Building fern-api (Cloudflare fork) ${VERSION} from ${CLI_GIT_HEAD}"
pnpm install --frozen-lockfile
pnpm turbo run compile --concurrency=2 --filter @fern-api/cli
(cd packages/cli/cli && node build.prod.mjs "$VERSION")

rm -f "$OUT_DIR/$TARBALL"
(cd packages/cli/cli/dist/prod && npm pack --pack-destination "$OUT_DIR" >/dev/null)
tar -xzOf "$OUT_DIR/$TARBALL" package/cli.cjs >/dev/null
(cd "$OUT_DIR" && touch SHA256SUMS && grep -v " $TARBALL\$" SHA256SUMS > SHA256SUMS.tmp || true; mv SHA256SUMS.tmp SHA256SUMS; shasum -a 256 "$TARBALL" >> SHA256SUMS)

echo "==> Wrote $OUT_DIR/$TARBALL (gitHead ${CLI_GIT_HEAD})"
grep " $TARBALL\$" "$OUT_DIR/SHA256SUMS"
