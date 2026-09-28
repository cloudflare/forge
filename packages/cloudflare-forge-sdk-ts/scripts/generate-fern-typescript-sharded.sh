#!/usr/bin/env bash
# Generate TypeScript from one Fern IR across deterministic file shards.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PKG_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
REPO_ROOT=$(cd "${PKG_ROOT}/../.." && pwd)
WORKSPACE_ROOT=${FERN_TYPESCRIPT_WORKSPACE_ROOT:-${PKG_ROOT}}
OUT_DIR=${FERN_TYPESCRIPT_OUT_DIR:-${REPO_ROOT}/packages/forge-sdk-ts/src/_generated}
GENERATOR_IMAGE="fernapi/fern-typescript-sdk:${FERN_TYPESCRIPT_GENERATOR_VERSION:?set FERN_TYPESCRIPT_GENERATOR_VERSION}"
SHARD_COUNT=${FERN_TYPESCRIPT_SHARD_COUNT:-3}
SHARD_HEAP_MB=${FERN_TYPESCRIPT_SHARD_HEAP_MB:-2304}

for command in docker unzip node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "error: ${command} is required for sharded TypeScript generation" >&2
    exit 1
  fi
done

if ! [[ "${SHARD_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: FERN_TYPESCRIPT_SHARD_COUNT must be a positive integer" >&2
  exit 1
fi
if ! [[ "${SHARD_HEAP_MB}" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: FERN_TYPESCRIPT_SHARD_HEAP_MB must be a positive integer" >&2
  exit 1
fi

work_dir=$(mktemp -d)
backup_dir=$(mktemp -d)
cleanup() {
  local status=$?
  if [ "${status}" -ne 0 ]; then
    rm -rf "${OUT_DIR}"
    mkdir -p "${OUT_DIR}"
    cp -R "${backup_dir}/." "${OUT_DIR}/" 2>/dev/null || true
    echo "error: TypeScript shard generation failed; restored ${OUT_DIR}" >&2
  fi
  rm -rf "${work_dir}" "${backup_dir}"
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}"
cp -R "${OUT_DIR}/." "${backup_dir}/" 2>/dev/null || true

capture_dir="${work_dir}/capture"
mkdir -p "${capture_dir}"
capture_started=$(date +%s)
echo "==> Capturing Fern canonical TypeScript IR"
(
  cd "${WORKSPACE_ROOT}"
  if [ -n "${FERN_TYPESCRIPT_FERN_CLI:-}" ]; then
    CLOUDFLARE_FERN_CAPTURE_DIR="${capture_dir}" \
      FERN_NO_VERSION_REDIRECTION=1 \
      "${FERN_TYPESCRIPT_FERN_CLI}" "${FERN_TYPESCRIPT_FERN_CLI_SCRIPT:?set FERN_TYPESCRIPT_FERN_CLI_SCRIPT}" \
        generate --group typescript-sdk --local --force
  else
    CLOUDFLARE_FERN_CAPTURE_DIR="${capture_dir}" \
      FERN_NO_VERSION_REDIRECTION=1 \
      pnpm exec fern generate --group typescript-sdk --local --force
  fi
)

echo "==> Canonical IR captured in $(( $(date +%s) - capture_started ))s"

if [ ! -s "${capture_dir}/ir.json" ] || [ ! -s "${capture_dir}/config.json" ]; then
  echo "error: Fern did not capture the canonical IR/config" >&2
  exit 1
fi

shards_started=$(date +%s)
pids=()
for ((index = 0; index < SHARD_COUNT; index++)); do
  shard_dir="${work_dir}/shards/${index}"
  mkdir -p "${shard_dir}/output" "${shard_dir}/files"
  cp "${capture_dir}/config.json" "${shard_dir}/config.json"
  # Avoid copying the 225 MB IR for each shard.
  ln "${capture_dir}/ir.json" "${shard_dir}/ir.json" 2>/dev/null \
    || cp "${capture_dir}/ir.json" "${shard_dir}/ir.json"

  echo "==> TypeScript shard $((index + 1))/${SHARD_COUNT}"
  docker run --rm \
    --user root \
    -e "NODE_OPTIONS=--max-old-space-size=${SHARD_HEAP_MB}" \
    -e "CLOUDFLARE_FERN_SHARD_COUNT=${SHARD_COUNT}" \
    -e "CLOUDFLARE_FERN_SHARD_INDEX=${index}" \
    -v "${shard_dir}/config.json:/fern/config.json:ro" \
    -v "${shard_dir}/ir.json:/fern/ir.json:ro" \
    -v "${shard_dir}/output:/fern/output" \
    "${GENERATOR_IMAGE}" /fern/config.json \
    > "${shard_dir}/generator.log" 2>&1 &
  pids+=("$!")
done

failed=0
for ((index = 0; index < SHARD_COUNT; index++)); do
  if ! wait "${pids[index]}"; then
    failed=1
    echo "error: TypeScript shard $((index + 1))/${SHARD_COUNT} failed" >&2
    cat "${work_dir}/shards/${index}/generator.log" >&2
  elif [ "${FERN_TYPESCRIPT_SHARD_LOGS:-0}" = "1" ]; then
    cat "${work_dir}/shards/${index}/generator.log"
  else
    grep '\[TIMING\]' "${work_dir}/shards/${index}/generator.log" || true
  fi
done
[ "${failed}" -eq 0 ] || exit 1
echo "==> ${SHARD_COUNT} TypeScript shards finished in $(( $(date +%s) - shards_started ))s"

for ((index = 0; index < SHARD_COUNT; index++)); do
  archive="${work_dir}/shards/${index}/output/output.zip"
  if [ ! -s "${archive}" ]; then
    echo "error: TypeScript shard $((index + 1)) produced no output archive" >&2
    exit 1
  fi
  unzip -q "${archive}" -d "${work_dir}/shards/${index}/files"
done

shard_outputs=()
for ((index = 0; index < SHARD_COUNT; index++)); do
  shard_outputs+=("${work_dir}/shards/${index}/files")
done

rm -rf "${OUT_DIR}"
node "${SCRIPT_DIR}/merge-fern-typescript-shards.mjs" "${OUT_DIR}" "${shard_outputs[@]}"

# Some imports become complete only after merge.
cid=$(docker create "${GENERATOR_IMAGE}")
if ! docker cp "${cid}:/assets/asIs/oxfmtrc.json" "${work_dir}/oxfmtrc.json"; then
  docker rm "${cid}" >/dev/null 2>&1 || true
  exit 1
fi
docker rm "${cid}" >/dev/null
cp "${work_dir}/oxfmtrc.json" "${OUT_DIR}/.oxfmtrc.json"
docker run --rm \
  --user root \
  -v "${OUT_DIR}:/work" \
  --entrypoint /bin/sh \
  "${GENERATOR_IMAGE}" \
  -c 'cd /work && oxfmt .'
rm "${OUT_DIR}/.oxfmtrc.json"

if [ "${FERN_TYPESCRIPT_INSTALL_CUSTOM_RUNTIME:-1}" = "1" ]; then
  echo "==> typescript-sdk: installing Fern custom runtime"
  pnpm exec tsx "${SCRIPT_DIR}/install-fern-custom-runtime.ts"
fi

echo "==> typescript-sdk: wrote ${OUT_DIR} from ${SHARD_COUNT} canonical-IR shards"
