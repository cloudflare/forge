#!/bin/bash
set -euo pipefail

# Build the Cloudflare fork of the TypeScript SDK generator as an npm tarball
# for a downstream repo to vendor next to @cloudflare/codegen-cli. Nothing is
# published; commit the tarball into the consumer and depend on it via
#   "@cloudflare/codegen-typescript-sdk": "file:<path>/cloudflare-codegen-typescript-sdk-<version>.tgz"
# then run it natively from generators.yml instead of the Docker image:
#   local-command: [node, <path>/node_modules/@cloudflare/codegen-typescript-sdk/cli.cjs]
# The generator shells out to the configured formatter/linter (oxfmt, oxlint);
# they must be on PATH, otherwise it installs them into the output project.
#
# Usage: scripts/build-vendor-typescript-generator.sh [output-dir]   (default: ./vendor-out)
# Writes cloudflare-codegen-typescript-sdk-<version>.tgz and appends to SHA256SUMS.
#
# The version is the upstream generator version this branch is based on; the
# `gitHead` field in the tarball's package.json is the commit it was built from.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$(mkdir -p "${1:-$REPO_ROOT/vendor-out}" && cd "${1:-$REPO_ROOT/vendor-out}" && pwd)"
GENERATOR_DIR="$REPO_ROOT/generators/typescript/sdk/cli"

cd "$REPO_ROOT"
VERSION=$(grep -m1 '^- version:' generators/typescript/sdk/versions.yml | sed 's/^- version: *//; s/["'\'']//g')
TARBALL="cloudflare-codegen-typescript-sdk-${VERSION}.tgz"
GIT_HEAD=$(git rev-parse HEAD)

echo "==> Building @cloudflare/codegen-typescript-sdk ${VERSION} from ${GIT_HEAD}"
pnpm install --frozen-lockfile
pnpm turbo run compile --concurrency=2 --filter @fern-typescript/sdk-generator-cli
(cd "$GENERATOR_DIR" && pnpm run dist:cli)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude '*.map' "$GENERATOR_DIR/dist/" "$STAGE/"
cat > "$STAGE/package.json" <<EOF
{
  "name": "@cloudflare/codegen-typescript-sdk",
  "version": "${VERSION}",
  "description": "Cloudflare fork of the Fern TypeScript SDK generator, built for native local generation.",
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "https://github.com/cloudflare/forge.git", "directory": "generators/typescript/sdk/cli" },
  "gitHead": "${GIT_HEAD}",
  "main": "cli.cjs",
  "engines": { "node": ">=22" }
}
EOF

rm -f "$OUT_DIR/$TARBALL"
(cd "$STAGE" && npm pack --pack-destination "$OUT_DIR" >/dev/null)
tar -xzOf "$OUT_DIR/$TARBALL" package/cli.cjs >/dev/null
(cd "$OUT_DIR" && touch SHA256SUMS && grep -v " $TARBALL\$" SHA256SUMS > SHA256SUMS.tmp || true; mv SHA256SUMS.tmp SHA256SUMS; shasum -a 256 "$TARBALL" >> SHA256SUMS)

echo "==> Wrote $OUT_DIR/$TARBALL (gitHead ${GIT_HEAD})"
grep " $TARBALL\$" "$OUT_DIR/SHA256SUMS"
