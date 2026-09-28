#!/usr/bin/env bash
# Build a local Docker image that wraps an official Fern generator with:
#   1. NODE_OPTIONS=--max-old-space-size=${FERN_NODE_MAX_OLD_SPACE_SIZE:-8192}
#      (Cloudflare's IR is ~250 MB and
#      OOMs the default Node heap as exit code 133).
#   2. Cached wrapper reuse when the version, limits, CA, and patches match.
#   3. A scoped host CA installed in the container's CA store, so go mod / pip /
#      cargo can verify TLS through corporate MITM proxies (e.g. Cloudflare for
#      Teams).
#
# Retag the result over the official `fernapi/...` name so the host CLI's
# IR-version mapping stays intact.
#
# Usage: ./scripts/build-generator-image.sh <language> <version>
#   e.g. ./scripts/build-generator-image.sh go 1.46.0
set -euo pipefail

lang=${1:?usage: $0 <language> <version>}
version=${2:?usage: $0 <language> <version>}
base="fernapi/fern-${lang}-sdk:${version}"
node_max_old_space_size=${FERN_NODE_MAX_OLD_SPACE_SIZE:-8192}
node_stack_size=${FERN_NODE_STACK_SIZE:-8192}

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required to build the Fern generator wrapper" >&2
  echo "       run this on a Docker-capable machine/runner." >&2
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd)

patch_fern_cli_for_capture() {
  local fern_cli
  fern_cli=$(node --input-type=module - "${PKG_ROOT:-$(cd "${script_dir}/.." && pwd)}" <<'JS'
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.argv[2], 'package.json'));
process.stdout.write(require.resolve('fern-api/cli.cjs'));
JS
)
  node "${cli_patch_script}" "${fern_cli}"
}

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

# Export a scoped host trust root. Empty on Linux/CI is fine; the image just
# falls back to its bundled certs.
#
# Set FERN_GENERATOR_HOST_CA_PEM to a PEM file for exact control. On macOS, the
# fallback searches for a certificate common name containing
# FERN_GENERATOR_HOST_CA_COMMON_NAME (default: Cloudflare) instead of exporting
# the entire system keychain.
if [ -n "${FERN_GENERATOR_HOST_CA_PEM:-}" ]; then
  cp "${FERN_GENERATOR_HOST_CA_PEM}" "${tmp}/host-ca.pem"
elif [ "$(uname)" = "Darwin" ]; then
  security find-certificate -a -p -c "${FERN_GENERATOR_HOST_CA_COMMON_NAME:-Cloudflare}" \
    /Library/Keychains/System.keychain \
    /System/Library/Keychains/SystemRootCertificates.keychain \
    > "${tmp}/host-ca.pem" 2>/dev/null || true
fi
[ -s "${tmp}/host-ca.pem" ] || : > "${tmp}/host-ca.pem"

# Exact version tags are immutable for our purposes. Reuse an already-built
# wrapper when its inputs match instead of rebuilding on every generation.
build_script="${script_dir}/build-generator-image.sh"
patch_script="${script_dir}/patch-fern-typescript-cli.mjs"
cli_patch_script="${script_dir}/patch-fern-cli-capture.mjs"
wrapper_key=$(node --input-type=module - "${lang}" "${version}" "${node_max_old_space_size}" "${node_stack_size}" "${tmp}/host-ca.pem" "${build_script}" "${patch_script}" <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [, , lang, version, heap, stack, caPath, buildPath, patchPath] = process.argv;
const hash = createHash('sha256');
for (const value of [lang, version, heap, stack]) hash.update(`${value}\0`);
hash.update(readFileSync(caPath));
hash.update(readFileSync(buildPath));
if (lang === 'typescript') {
  hash.update(readFileSync(patchPath));
  hash.update(readFileSync(new URL('patch-fern-cli-capture.mjs', new URL(`file://${buildPath}`))));
  hash.update(readFileSync(new URL('fern-typescript-entrypoint.sh', new URL(`file://${buildPath}`))));
}
process.stdout.write(hash.digest('hex'));
JS
)
current_wrapper_key=$(docker image inspect "${base}" --format '{{ index .Config.Labels "com.cloudflare.fern-wrapper-key" }}' 2>/dev/null || true)
if [ "${current_wrapper_key}" = "${wrapper_key}" ]; then
  if [ "${lang}" = "typescript" ]; then
    patch_fern_cli_for_capture
  fi
  echo "reusing cached Cloudflare wrapper ${base}"
  exit 0
fi

docker pull "${base}"

# TypeScript: apply Cloudflare-specific Fern generator patches (SDK-variable
# path params, non-identifier multipart property access, and undiscriminated-
# union base properties used by stream-condition literals). Replaces residual
# postgen codemods and preserves Fern extension semantics missing in TS 3.80.1.
if [ "${lang}" = "typescript" ]; then
  echo "==> Patching fern-typescript-sdk:${version} for request wrappers / multipart keys / union base properties / HeadersIterator"
  container_id=$(docker create "${base}")
  docker cp "${container_id}:/cli.cjs" "${tmp}/cli.cjs"
  docker cp "${container_id}:/assets/core-utilities/src/core/fetcher/Headers.ts" "${tmp}/Headers.ts"
  docker rm "${container_id}" >/dev/null
  node "${patch_script}" "${tmp}/cli.cjs" "${tmp}/Headers.ts"
fi

orig_entrypoint=$(docker inspect "${base}" --format '{{json .Config.Entrypoint}}')
# Node-based generators (TS/Go/Java/C#/PHP/Ruby/Swift/Rust) recurse deeply
# through schema trees and overflow the default 1 MB stack. Splice
# --stack-size=8192 into the argv between `node` and the JS entry script.
# Python-based generator (fern-python-sdk uses /usr/local/bin/python) is
# untouched.
new_entrypoint=$(node - "${orig_entrypoint}" "${node_stack_size}" <<'JS'
const argv = JSON.parse(process.argv[2]);
const stackSize = process.argv[3];
const command = argv[0]?.split('/').at(-1);
const stackArg = `--stack-size=${stackSize}`;
const next = command === 'node' && !argv.some((arg) => arg.startsWith('--stack-size='))
  ? [argv[0], stackArg, ...argv.slice(1)]
  : argv;
process.stdout.write(JSON.stringify(next));
JS
)

typescript_copies=""
typescript_entrypoint_copy=""
if [ "${lang}" = "typescript" ] && [ -f "${tmp}/cli.cjs" ]; then
  cp "${script_dir}/fern-typescript-entrypoint.sh" "${tmp}/fern-typescript-entrypoint.sh"
  typescript_copies=$'COPY cli.cjs /cli.cjs\nCOPY Headers.ts /assets/core-utilities/src/core/fetcher/Headers.ts\n'
  typescript_entrypoint_copy=$'COPY fern-typescript-entrypoint.sh /fern-typescript-entrypoint.sh\n'
  # npm archives do not preserve executable bits for non-bin package files.
  # Invoke the packaged wrapper through sh so extracted tarballs work on Linux.
  new_entrypoint='["/bin/sh","/fern-typescript-entrypoint.sh"]'
fi

cat > "${tmp}/Dockerfile" <<DOCKERFILE
FROM ${base}
LABEL com.cloudflare.fern-wrapper-key="${wrapper_key}"
ENV NODE_OPTIONS="--max-old-space-size=${node_max_old_space_size}"
ENTRYPOINT ${new_entrypoint}
${typescript_copies}${typescript_entrypoint_copy}COPY host-ca.pem /usr/local/share/ca-certificates/host-ca.crt
RUN set -e; \
    if command -v update-ca-certificates >/dev/null 2>&1; then \
      update-ca-certificates; \
    elif command -v update-ca-trust >/dev/null 2>&1; then \
      cp /usr/local/share/ca-certificates/host-ca.crt /etc/pki/ca-trust/source/anchors/; \
      update-ca-trust; \
    else \
      cat /usr/local/share/ca-certificates/host-ca.crt >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true; \
    fi
DOCKERFILE

docker build --quiet -t "${base}" "${tmp}"
if [ "${lang}" = "typescript" ]; then
  patch_fern_cli_for_capture
fi
echo "retagged ${base} with NODE_OPTIONS=--max-old-space-size=${node_max_old_space_size}, --stack-size=${node_stack_size}, and scoped host CA"
