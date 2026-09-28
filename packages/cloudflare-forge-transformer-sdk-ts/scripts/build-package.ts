import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { create as createTar } from 'tar';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(SCRIPT_DIR);
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const DIST = join(PKG_ROOT, 'dist');
const BASELINE_SDK =
  process.env['FORGE_BASELINE_SDK'] ?? join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'src', '_generated');

type OpenApiOperation = Record<string, unknown> & { operationId?: string };
type OpenApiDocument = { paths?: Record<string, Record<string, OpenApiOperation>> };

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'generator', 'custom', 'core', 'fetcher'), { recursive: true });
mkdirSync(join(DIST, 'vendor'), { recursive: true });

buildSync({
  entryPoints: [join(PKG_ROOT, 'scripts', 'generate-from-openapi.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['fern-api', 'typescript'],
  outfile: join(DIST, 'cli.js'),
});

buildSync({
  entryPoints: [join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'generate-sdk-map.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['typescript'],
  outfile: join(DIST, 'generator', 'generate-sdk-map.js'),
});

if (existsSync(join(BASELINE_SDK, 'index.ts')) && existsSync(join(BASELINE_SDK, 'sdk-map.json'))) {
  createTar(
    {
      file: join(DIST, 'baseline-sdk.tar'),
      cwd: BASELINE_SDK,
      sync: true,
    },
    ['.'],
  );
  console.log(`==> Packaged baseline SDK from ${BASELINE_SDK}`);
} else {
  console.log(`note: baseline generated SDK not found at ${BASELINE_SDK}; skipping baseline-sdk.tar packaging`);
}

const spec = join(REPO_ROOT, 'packages', 'cloudflare-fern-config', 'fern', 'openapi.json');
const metadataSpec = join(REPO_ROOT, 'openapi.json');
const openapi = JSON.parse(readFileSync(spec, 'utf8')) as OpenApiDocument;
const metadata = JSON.parse(readFileSync(metadataSpec, 'utf8')) as OpenApiDocument;
const metadataByOperationId = new Map<string, Record<string, unknown>>();
for (const pathItem of Object.values(metadata.paths ?? {})) {
  for (const operation of Object.values(pathItem)) {
    if (operation?.operationId) metadataByOperationId.set(operation.operationId, operation);
  }
}
for (const pathItem of Object.values(openapi.paths ?? {})) {
  for (const operation of Object.values(pathItem)) {
    if (!operation?.operationId) continue;
    const source = metadataByOperationId.get(operation.operationId);
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if ((key.startsWith('x-fern-') || key.startsWith('x-forge-')) && operation[key] === undefined) {
        operation[key] = value;
      }
    }
  }
}
writeFileSync(join(DIST, 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
console.log(`==> Packaged OpenAPI spec from ${spec} with metadata from ${metadataSpec}`);

cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'fern-typescript-entrypoint.sh'),
  join(DIST, 'generator', 'fern-typescript-entrypoint.sh'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'patch-fern-cli-capture.mjs'),
  join(DIST, 'generator', 'patch-fern-cli-capture.mjs'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'merge-fern-typescript-shards.mjs'),
  join(DIST, 'generator', 'merge-fern-typescript-shards.mjs'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'generate-fern-typescript-sharded.sh'),
  join(DIST, 'generator', 'generate-fern-typescript-sharded.sh'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'build-generator-image.sh'),
  join(DIST, 'generator', 'build-generator-image.sh'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'scripts', 'patch-fern-typescript-cli.mjs'),
  join(DIST, 'generator', 'patch-fern-typescript-cli.mjs'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'custom', '.fernignore'),
  join(DIST, 'generator', 'custom', '.fernignore'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'custom', 'core', 'fetcher', 'getResponseBody.ts'),
  join(DIST, 'generator', 'custom', 'core', 'fetcher', 'getResponseBody.ts'),
);
cpSync(
  join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts', 'custom', 'core', 'fetcher', 'unwrapCloudflareEnvelope.ts'),
  join(DIST, 'generator', 'custom', 'core', 'fetcher', 'unwrapCloudflareEnvelope.ts'),
);

chmodSync(join(DIST, 'cli.js'), 0o755);

console.log('==> Built self-contained @cloudflare/forge-transformer-sdk-ts generator');
