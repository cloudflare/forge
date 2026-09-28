// Generate the Fern TypeScript SDK package artifact.
//
// Shared Fern/OpenAPI generation lives in @cloudflare/fern-config so every SDK
// language consumes the same spec and generator configuration. That package
// handles the generator image, the Fern run and the custom runtime overlay; this
// wrapper adds the TypeScript-only sdk-map on top.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PKG_ROOT, '..', '..');

console.log('==> Running Fern generation for TypeScript');
execFileSync('pnpm', ['--filter', '@cloudflare/fern-config', 'run', 'generate', 'typescript'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

console.log('==> Verifying Fern output');
const generatedIndex = join(PKG_ROOT, 'src', '_generated', 'index.ts');
if (!existsSync(generatedIndex) || statSync(generatedIndex).size === 0) {
  console.error(`error: Fern generation did not produce ${generatedIndex}`);
  console.error('       the SDK output is missing or empty; refusing to continue.');
  process.exit(1);
}

// Derived from the freshly generated client + the spec that produced it, so the
// map can never drift from the SDK it ships with. generate-sdk-map.ts defaults to
// the spec @cloudflare/fern-config installed, so no paths are passed here.
console.log('==> Generating operationId -> SDK call-site map (sdk-map.json)');
execFileSync('pnpm', ['exec', 'tsx', join(PKG_ROOT, 'scripts', 'generate-sdk-map.ts')], {
  cwd: PKG_ROOT,
  stdio: 'inherit',
});

console.log('==> Fern SDK generation complete');
