#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFernCompatibilityFixes } from '@cloudflare/forge/fern-openapi-compat';

const DIST_ROOT = dirname(fileURLToPath(import.meta.url));
// The vendored fern-api and @cloudflare/codegen-typescript-sdk packages
// (Cloudflare's forks of the Fern CLI and Fern TypeScript generator), copied
// into dist by build-package.ts so the packed tarball has no file: dependency
// on this repo's vendor/ directory.
const FERN_CLI = join(DIST_ROOT, 'vendor', 'codegen-cli', 'cli.cjs');
const TYPESCRIPT_GENERATOR = join(DIST_ROOT, 'vendor', 'codegen-typescript-sdk', 'cli.cjs');
const GENERATOR_ROOT = join(DIST_ROOT, 'generator');
const BASELINE_SDK = join(DIST_ROOT, 'baseline-sdk');
const BASELINE_TAR = join(DIST_ROOT, 'baseline-sdk.tar');
const TYPESCRIPT_GENERATOR_VERSION = '3.88.3';
// Cloudflare's IR is ~242 MB; node's default heap is too small for it.
const TYPESCRIPT_GENERATOR_HEAP_MB = 8192;
// Fern's TypeScript generator formats and lints its output with these. Found on
// PATH, it uses them as-is; otherwise it installs them into the generated
// project each run.
const CHECK_FIX_TOOLS = ['oxfmt', 'oxlint'] as const;

type OpenApiDoc = {
  paths?: Record<string, Record<string, unknown>>;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface Args {
  openapi?: string;
  base?: string;
  out?: string;
  help: boolean;
}

function usage(): string {
  return `Generate a Cloudflare TypeScript SDK from a complete bundled OpenAPI specification.

The OpenAPI may be a file path or - for stdin. With no positional OpenAPI, the
pre-generated SDK is copied without running Fern and --base supplies its matching
complete OpenAPI. A positional OpenAPI runs the vendored Fern generator natively.
The finalized OpenAPI, SDK source, and sdk-map.json are written to --out.

Usage:
  forge [openapi.json|-] --out <dir> [options]

Options:
  --base <file.json>       Complete OpenAPI matching the pre-generated SDK
  --out <dir>              Required output directory
  -h, --help               Show this help
`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === '--') continue;
    const next = argv[i + 1];
    if (arg === '--base' || arg === '--out' || arg === '--bundle') {
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      if (arg === '--base') args.base = next;
      else if (arg === '--out') args.out = next;
      else args.openapi = next;
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (args.openapi === undefined) {
      args.openapi = arg;
    } else {
      throw new Error(`Unexpected extra bundle argument: ${arg}`);
    }
  }
  return args;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Failed to read JSON at ${path}: ${(error as Error).message}`);
  }
}

function readBundle(path: string): OpenApiDoc {
  if (path === '-') {
    try {
      return JSON.parse(readFileSync(0, 'utf8')) as OpenApiDoc;
    } catch (error) {
      throw new Error(`Failed to read OpenAPI JSON from stdin: ${(error as Error).message}`);
    }
  }
  return readJson<OpenApiDoc>(resolve(path));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function countOperations(doc: OpenApiDoc): number {
  let count = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const operationId = (operation as { operationId?: unknown }).operationId;
      if (typeof operationId === 'string') count += 1;
    }
  }
  return count;
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
}

function writeFernWorkspace(root: string, generated: string, fernSpec: string): void {
  const apiDir = join(root, 'fern/apis/api');
  mkdirSync(apiDir, { recursive: true });
  writeJson(join(root, 'fern/fern.config.json'), { organization: 'cloudflare', version: '5.112.0' });
  writeFileSync(
    join(apiDir, 'generators.yml'),
    `api:\n  specs:\n    - openapi: ../../../openapi.json\n      settings:\n        only-include-referenced-schemas: false\n        object-query-parameters: true\n        respect-nullable-schemas: true\n        coerce-enums-to-literals: true\n        path-parameter-order: url-order\n        resolve-schema-collisions: true\ndefault-group: typescript-sdk\ngroups:\n  typescript-sdk:\n    generators:\n      - name: fernapi/fern-typescript-sdk\n        version: ${TYPESCRIPT_GENERATOR_VERSION}\n        local-command:\n          - ${JSON.stringify(process.execPath)}\n          - --max-old-space-size=${TYPESCRIPT_GENERATOR_HEAP_MB}\n          - ${JSON.stringify(TYPESCRIPT_GENERATOR)}\n        output:\n          location: local-file-system\n          path: ${JSON.stringify(generated)}\n        config:\n          allowCustomFetcher: true\n          formatter: oxfmt\n          linter: oxlint\n          skipResponseValidation: true\n          fetchSupport: native\n          formDataSupport: Node18\n          fileResponseType: binary-response\n          streamType: web\n          omitUndefined: true\n          offsetSemantics: page-index\n          maxRetries: 2\n          retryStatusCodes: recommended\n`,
  );
  copyFileSync(fernSpec, join(root, 'openapi.json'));
}

// npm allows `bin` as a single path (named after the package) or a name->path map.
function binScript(manifest: unknown, tool: string, manifestPath: string): string {
  const bin = manifest && typeof manifest === 'object' && 'bin' in manifest ? manifest.bin : undefined;
  const script =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object'
        ? Object.entries(bin).find(([name]) => name === tool)?.[1]
        : undefined;
  if (typeof script !== 'string') {
    throw new Error(`${manifestPath} has no "bin" entry for ${tool}`);
  }
  return script;
}

// Expose this package's own oxfmt/oxlint to the generator through PATH shims;
// package managers do not put a dependency's bins on the consumer's PATH.
function writeCheckFixToolShims(binDir: string): void {
  const require = createRequire(import.meta.url);
  mkdirSync(binDir, { recursive: true });
  for (const tool of CHECK_FIX_TOOLS) {
    const manifestPath = require.resolve(`${tool}/package.json`);
    const bin = binScript(readJson<unknown>(manifestPath), tool, manifestPath);
    const script = join(dirname(manifestPath), bin);
    const shim = join(binDir, tool);
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    chmodSync(shim, 0o755);
  }
}

function installCustomRuntime(generated: string): void {
  cpSync(join(GENERATOR_ROOT, 'custom'), generated, { recursive: true });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.out) throw new Error('--out is required');

  const out = resolve(args.out);
  if (args.openapi === undefined) {
    if (!args.base) throw new Error('--base is required when copying the pre-generated SDK');
    rmSync(out, { recursive: true, force: true });
    const targetSdk = join(out, 'sdk');
    mkdirSync(targetSdk, { recursive: true });
    if (existsSync(BASELINE_TAR)) {
      execFileSync('tar', ['-xf', BASELINE_TAR, '-C', targetSdk]);
    } else if (existsSync(BASELINE_SDK)) {
      cpSync(BASELINE_SDK, targetSdk, { recursive: true });
    } else {
      throw new Error(`baseline generated SDK not found at ${BASELINE_TAR} or ${BASELINE_SDK}`);
    }
    copyFileSync(resolve(args.base), join(out, 'openapi.json'));
    process.stderr.write(`forge-transformer-sdk-ts: copied packaged baseline SDK to ${out}\n`);
    return;
  }

  const source = readBundle(args.openapi);
  const sourceLabel = args.openapi === '-' ? 'stdin' : resolve(args.openapi);
  const work = mkdtempSync(join(tmpdir(), 'forge-transformer-sdk-ts-'));
  const sourceSpec = join(work, 'openapi.source.json');
  const fernSpec = join(work, 'openapi.fern.json');
  const generated = join(work, 'sdk');

  try {
    writeJson(sourceSpec, source);
    const fernSource = structuredClone(source);
    const fernCompatibilityFixes = applyFernCompatibilityFixes(fernSource);
    const fernCompatibilityFixCount = Object.values(fernCompatibilityFixes).reduce((total, count) => total + count, 0);
    writeJson(fernSpec, fernSource);
    if (fernCompatibilityFixCount > 0) {
      process.stderr.write(
        `forge-transformer-sdk-ts: applied ${fernCompatibilityFixCount} Fern OpenAPI compatibility repair(s)\n`,
      );
    }
    writeFernWorkspace(work, generated, fernSpec);
    const binDir = join(work, 'bin');
    writeCheckFixToolShims(binDir);
    run(
      process.execPath,
      [
        // The CLI builds the ~242 MB IR in-process as well.
        `--max-old-space-size=${TYPESCRIPT_GENERATOR_HEAP_MB}`,
        FERN_CLI,
        'generate',
        '--group',
        'typescript-sdk',
        '--local',
        '--force',
        '--no-prompt',
      ],
      work,
      { PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}` },
    );
    if (!existsSync(join(generated, 'index.ts'))) {
      throw new Error(`Fern exited 0 but produced no ${join(generated, 'index.ts')}`);
    }
    installCustomRuntime(generated);
    run(process.execPath, [join(GENERATOR_ROOT, 'generate-sdk-map.js')], work, {
      FORGE_SDK_GENERATED: generated,
      FORGE_SDK_SOURCE_SPEC: sourceSpec,
      FORGE_SDK_FERN_SPEC: fernSpec,
    });

    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(generated, join(out, 'sdk'), { recursive: true });
    copyFileSync(sourceSpec, join(out, 'openapi.json'));
    process.stderr.write(
      `forge-transformer-sdk-ts: generated ${countOperations(source)} operations from ${sourceLabel} in ${out}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
