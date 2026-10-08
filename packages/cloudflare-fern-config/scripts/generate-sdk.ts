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
// command: spec resolution, the Fern invocation, and the TypeScript
// custom-runtime overlay.
//
// TypeScript runs the vendored fork of Fern's TypeScript generator natively
// (local-command in generators.yml). The other languages need a Docker daemon:
// their generators are distributed as container images and this uses
// `fern generate --local`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFernCompatibilityFixes } from '@cloudflare/forge/fern-openapi-compat';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const FERN_DIR = join(PKG_ROOT, 'fern');
const GENERATORS = join(FERN_DIR, 'generators.yml');
const SPEC = join(FERN_DIR, 'openapi.json');

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
if (languages.some((language) => language !== 'typescript')) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    fail('a running Docker daemon is required (fern generate --local runs these generators as containers)');
  }
}

const generatorGroups = new Set(
  readFileSync(GENERATORS, 'utf8')
    .split('\n')
    .map((line) => /^ {2}(\S+-sdk):$/.exec(line)?.[1])
    .filter((group) => group !== undefined),
);

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

// ------------------------------------------------------------------ generate --
const groupArgs: string[] = [];
for (const language of languages) {
  if (!generatorGroups.has(`${language}-sdk`)) {
    fail(`no '${language}-sdk' group in ${GENERATORS}`);
  }
  groupArgs.push('--group', `${language}-sdk`);
}

const sdkTs = join(REPO_ROOT, 'packages', 'cloudflare-forge-sdk-ts');
const generated = join(sdkTs, 'src', '_generated');
if (languages.includes('typescript')) {
  // The custom runtime (and its .fernignore) is re-installed below, so start from
  // an empty dir: with a .fernignore present Fern copies output through a temp
  // git repo, which costs ~45s on this SDK.
  rmSync(generated, { recursive: true, force: true });
}

// cwd must be at or below the package root so the CLI discovers fern/.
run(
  join(PKG_ROOT, 'node_modules', '.bin', 'fern'),
  ['generate', ...groupArgs, '--local', '--no-prompt', '--force', '--log-level', 'info'],
  {
    cwd: PKG_ROOT,
    // Heap for the Fern CLI itself (validation + IR); the TypeScript generator
    // sets its own in generators.yml.
    env: { ...process.env, NODE_OPTIONS: process.env['NODE_OPTIONS'] ?? '--max-old-space-size=4096' },
  },
);

// ------------------------------------------------------- typescript post-step --
if (languages.includes('typescript')) {
  // Fern can exit 0 having produced nothing useful when a generator crashes,
  // so assert on a real entrypoint before going further.
  if (!isNonEmptyFile(join(generated, 'index.ts'))) {
    fail(`Fern exited 0 but ${join(generated, 'index.ts')} is missing or empty`);
  }

  // allowCustomFetcher expects the Cloudflare envelope unwrap and URL join
  // overrides layered over the generated core.
  console.log('==> Installing TypeScript custom runtime');
  cpSync(join(sdkTs, 'custom'), generated, { recursive: true });
}

console.log(`==> Done: ${languages.join(', ')}`);
