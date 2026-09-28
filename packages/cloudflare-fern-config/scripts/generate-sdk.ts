// Generate Fern SDKs from fern/openapi.json.
//
// Usage:
//   tsx scripts/generate-sdk.ts                  # typescript (the default-group)
//   tsx scripts/generate-sdk.ts typescript
//   tsx scripts/generate-sdk.ts python go rust   # any number of languages
//
// A language maps to the "<language>-sdk" group in fern/generators.yml.
//
// Everything a generation run needs lives here, so CI and a laptop run the same
// command: spec resolution, the heap-tuned generator image, the Fern invocation,
// and the TypeScript custom-runtime overlay.
//
// Requires a Docker daemon -- Fern generators are distributed as container
// images and this uses `fern generate --local`.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFernCompatibilityFixes } from '@cloudflare/forge/fern-openapi-compat';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const FERN_DIR = join(PKG_ROOT, 'fern');
const GENERATORS = join(FERN_DIR, 'generators.yml');
const SPEC = join(FERN_DIR, 'openapi.json');

// Heap for the TypeScript generator container. Cloudflare's IR is ~242 MB and
// the official image exits 133 partway through generation with node's default.
const TYPESCRIPT_HEAP_MB = process.env['FERN_TYPESCRIPT_HEAP_MB'] ?? '8192';

const languages = process.argv.slice(2);
if (languages.length === 0) {
  languages.push('typescript');
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isNonEmptyFile(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: PKG_ROOT }) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

// ------------------------------------------------------------------ preflight
try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
} catch {
  fail('a running Docker daemon is required (fern generate --local runs generators as containers)');
}

// ----------------------------------------------------------------------- spec
const FORGE_OPENAPI_TAG = /^openapi\.v\d{8}\.\d+$/;

function githubCurlHeaders(accept: string): string[] {
  const headers = ['-H', `Accept: ${accept}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers.push('-H', `Authorization: Bearer ${token}`);
  return headers;
}

function githubJson(url: string): unknown {
  return JSON.parse(
    execFileSync('curl', ['-fsSL', ...githubCurlHeaders('application/vnd.github+json'), url], { encoding: 'utf8' }),
  );
}

function resolveForgeRelease(): { tag_name?: string; assets?: Array<{ name?: string; url?: string }> } {
  const pin = process.env['FORGE_OPENAPI_RELEASE'];
  if (pin) {
    return githubJson(`https://api.github.com/repos/cloudflare/forge/releases/tags/${pin}`) as {
      tag_name?: string;
      assets?: Array<{ name?: string; url?: string }>;
    };
  }
  const releases = githubJson('https://api.github.com/repos/cloudflare/forge/releases?per_page=100') as Array<{
    tag_name?: string;
    assets?: Array<{ name?: string; url?: string }>;
  }>;
  const latest = releases
    .filter((release) => FORGE_OPENAPI_TAG.test(release.tag_name ?? ''))
    .sort((left, right) => (left.tag_name ?? '').localeCompare(right.tag_name ?? '', 'en', { numeric: true }))
    .at(-1);
  if (!latest) fail('No openapi.vYYYYMMDD.N release found on cloudflare/forge');
  return latest;
}

function downloadForgeReleaseSpec(dest: string): void {
  const release = resolveForgeRelease();
  const asset = release.assets?.find((item) => item.name === 'openapi.forge.json');
  if (!asset?.url) fail(`${release.tag_name} has no openapi.forge.json asset`);
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync('curl', ['-fsSL', ...githubCurlHeaders('application/octet-stream'), '-o', dest, asset.url]);
  console.log(`==> Downloaded ${release.tag_name} to ${dest}`);
}

// Install an explicitly supplied spec; otherwise use fern/openapi.json in place.
const source = process.env['FORGE_OPENAPI_SPEC'];
if (source && isNonEmptyFile(source)) {
  console.log(`==> Installing spec from ${source}`);
  copyFileSync(source, SPEC);
} else if (!isNonEmptyFile(SPEC)) {
  downloadForgeReleaseSpec(SPEC);
}

const openApi = JSON.parse(readFileSync(SPEC, 'utf8')) as Record<string, unknown>;
const fernCompatibilityFixes = applyFernCompatibilityFixes(openApi);
const fernCompatibilityFixCount = Object.values(fernCompatibilityFixes).reduce((total, count) => total + count, 0);
if (fernCompatibilityFixCount > 0) {
  writeFileSync(SPEC, `${JSON.stringify(openApi, null, 2)}\n`);
  console.log(`==> Applied ${fernCompatibilityFixCount} Fern OpenAPI compatibility repair(s)`);
}

// ---------------------------------------------------------- generator image --
// Read the pinned image for a group straight out of generators.yml so the tag can
// never drift from the generator Fern is about to run. Deliberately a line scan
// rather than a YAML dependency: the shape is a two-line literal.
function generatorImage(language: string): string | undefined {
  const lines = readFileSync(GENERATORS, 'utf8').split('\n');
  let inGroup = false;
  let name: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `${language}-sdk:`) {
      inGroup = true;
      continue;
    }
    if (!inGroup) continue;
    const nameMatch = /^-\s+name:\s*(\S+)$/.exec(trimmed);
    if (nameMatch) name = nameMatch[1];
    const versionMatch = /^version:\s*(\S+)$/.exec(trimmed);
    if (versionMatch && name !== undefined) return `${name}:${versionMatch[1]}`;
  }
  return undefined;
}

// Fern always runs the official image name, so a heap-tuned wrapper has to be
// retagged over it. The label makes this idempotent across runs.
function ensureHeapTunedImage(image: string, heapMb: string) {
  let current = '';
  try {
    current = execFileSync(
      'docker',
      ['image', 'inspect', image, '--format', '{{index .Config.Labels "forge.heap-mb"}}'],
      {
        encoding: 'utf8',
      },
    ).trim();
  } catch {
    current = '';
  }
  if (current === heapMb) {
    console.log(`==> ${image} already heap-tuned (${heapMb} MB)`);
    return;
  }
  console.log(`==> Building heap-tuned ${image} (${heapMb} MB)`);
  run('docker', ['pull', image]);
  // Only the heap is tuned: node rejects --stack-size in NODE_OPTIONS, and
  // RLIMIT_STACK is 8 MB in these images with no way to pass --ulimit.
  const dockerfile = `FROM ${image}\nENV NODE_OPTIONS="--max-old-space-size=${heapMb}"\n`;
  execFileSync('docker', ['build', '--tag', image, '--label', `forge.heap-mb=${heapMb}`, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

// ------------------------------------------------------------------ generate --
const groupArgs: string[] = [];
for (const language of languages) {
  const image = generatorImage(language);
  if (image === undefined) {
    fail(`no '${language}-sdk' group in ${GENERATORS}`);
  }
  if (language === 'typescript') {
    ensureHeapTunedImage(image, TYPESCRIPT_HEAP_MB);
  }
  groupArgs.push('--group', `${language}-sdk`);
}

// cwd must be at or below the package root so the CLI discovers fern/.
run(
  join(PKG_ROOT, 'node_modules', '.bin', 'fern'),
  ['generate', ...groupArgs, '--local', '--no-prompt', '--force', '--log-level', 'info'],
  {
    cwd: PKG_ROOT,
    // Heap for the Fern CLI itself (validation + IR), separate from the container.
    env: { ...process.env, NODE_OPTIONS: process.env['NODE_OPTIONS'] ?? '--max-old-space-size=4096' },
  },
);

// ------------------------------------------------------- typescript post-step --
if (languages.includes('typescript')) {
  const sdkTs = join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts');
  const generated = join(sdkTs, 'src', '_generated');

  // Fern can exit 0 having produced nothing useful when a generator crashes
  // inside the container, so assert on a real entrypoint before going further.
  if (!isNonEmptyFile(join(generated, 'index.ts'))) {
    fail(`Fern exited 0 but ${join(generated, 'index.ts')} is missing or empty`);
  }

  // Fern 3.80.1 emits invalid dotted/subtraction expressions for multipart
  // fields whose wire names are not identifiers. Use bracket access so the
  // request type and serializer retain the exact wire name.
  const openApi = JSON.parse(readFileSync(SPEC, 'utf8')) as Record<string, unknown>;
  const propertyNames = new Set<string>();
  for (const pathItem of Object.values((openApi['paths'] as Record<string, unknown> | undefined) ?? {})) {
    if (pathItem === null || typeof pathItem !== 'object') continue;
    for (const operation of Object.values(pathItem as Record<string, unknown>)) {
      if (operation === null || typeof operation !== 'object') continue;
      const requestBody = (operation as Record<string, unknown>)['requestBody'];
      if (requestBody === null || typeof requestBody !== 'object') continue;
      const content = (requestBody as Record<string, unknown>)['content'];
      if (content === null || typeof content !== 'object') continue;
      const multipart = (content as Record<string, unknown>)['multipart/form-data'];
      if (multipart === null || typeof multipart !== 'object') continue;
      const schema = (multipart as Record<string, unknown>)['schema'];
      if (schema === null || typeof schema !== 'object') continue;
      const properties = (schema as Record<string, unknown>)['properties'];
      if (properties === null || typeof properties !== 'object') continue;
      for (const wireName of Object.keys(properties as Record<string, unknown>)) {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(wireName)) propertyNames.add(wireName);
      }
    }
  }

  let correctedAccessors = 0;
  const correctFile = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        correctFile(entryPath);
      } else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(entryPath, 'utf8');
        let corrected = source;
        for (const wireName of propertyNames) {
          const emittedAccess = [...wireName]
            .map((character) => (character === '-' ? '\\s*-\\s*' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('');
          corrected = corrected.replace(
            new RegExp(`request\\.${emittedAccess}`, 'g'),
            `request[${JSON.stringify(wireName)}]`,
          );
        }
        if (corrected !== source) {
          correctedAccessors += 1;
          writeFileSync(entryPath, corrected);
        }
      }
    }
  };
  correctFile(generated);
  console.log(`==> Corrected multipart property access in ${correctedAccessors} generated file(s)`);

  // allowCustomFetcher expects the Cloudflare envelope unwrap and URL join
  // overrides layered over the generated core. The .fernignore travels with them
  // so a later regeneration preserves them.
  console.log('==> Installing TypeScript custom runtime');
  cpSync(join(sdkTs, 'custom'), generated, { recursive: true });
}

console.log(`==> Done: ${languages.join(', ')}`);
