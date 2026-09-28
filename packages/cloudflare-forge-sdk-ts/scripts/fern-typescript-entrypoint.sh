#!/bin/sh
set -eu

if [ -n "${CLOUDFLARE_FERN_CAPTURE_DIR:-}" ]; then
  capture_dir=/capture
  mkdir -p "${capture_dir}"
  cp /fern/ir.json "${capture_dir}/ir.json"
  cp /fern/config.json "${capture_dir}/config.json"

  # Fern requires an output archive before copying local results.
  capture_output=$(mktemp -d)
  printf '// Canonical IR capture only.\n' > "${capture_output}/index.ts"
  (cd "${capture_output}" && zip -q /fern/output/output.zip index.ts)
  exit 0
fi

if [ "${CLOUDFLARE_FERN_SHARD_COUNT:-1}" -gt 1 ]; then
  shard_config=$(mktemp)
  node --input-type=commonjs - /fern/config.json "${shard_config}" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
config.output.snippetFilepath = null;
writeFileSync(process.argv[3], JSON.stringify(config));
JS
  set -- "${shard_config}"
fi

exec node \
  "--stack-size=${FERN_NODE_STACK_SIZE:-8192}" \
  --enable-source-maps \
  /cli.cjs \
  "$@"
