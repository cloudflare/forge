#!/usr/bin/env node
/**
 * Generates `src/generated/terraform-docs.json` from local checkouts of the Cloudflare Terraform
 * provider and the cloudflare-go SDK modules it imports.
 *
 * This script is deliberately offline. It never downloads anything, never spawns processes, and
 * never executes code from the checkouts. All reads go through `SourceTree`, which confines them to
 * each checkout and refuses symbolic links. Fetching pinned sources is the caller's job, e.g. the
 * `sync-terraform-docs` workflow or a manual `git clone --depth 1 --branch <tag>`.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SourceTree } from './source-tree.ts';
import {
  buildTerraformDocs,
  declarationFiles,
  parseSdkApiMarkdown,
  parseServiceSource,
  SERVICE_FILES,
  type ServiceSource,
} from './terraform-provider.ts';

const PROVIDER_REPOSITORY = 'https://github.com/cloudflare/terraform-provider-cloudflare';
const DEFAULT_OUTPUT = fileURLToPath(new URL('../src/generated/terraform-docs.json', import.meta.url));

const USAGE = `Usage: generate-terraform-docs --provider-dir <path> --sdk-dir <module>=<path> [...] [options]

  --provider-dir <path>          Checkout of cloudflare/terraform-provider-cloudflare at a release tag
  --sdk-dir <module>=<path>      Checkout of a cloudflare-go module the provider imports (repeatable),
                                 e.g. github.com/cloudflare/cloudflare-go/v7=../cloudflare-go
  --output <path>                Output file (default: src/generated/terraform-docs.json)
  --check                        Fail if the output is out of date instead of writing it
  --allow-unresolved             Do not fail when provider SDK calls cannot be resolved to endpoints

Fetch sources with, for example:
  git clone --depth 1 --branch v5.27.0 https://github.com/cloudflare/terraform-provider-cloudflare provider
  git clone --depth 1 --branch v7.12.0 https://github.com/cloudflare/cloudflare-go sdk-v7`;

/** Returns cloudflare-go modules and versions required by the provider's go.mod. */
export function parseSdkRequirements(goMod: string): Map<string, string> {
  const requirements = new Map<string, string>();
  for (const match of goMod.matchAll(/^\s*(?:require\s+)?(github\.com\/cloudflare\/cloudflare-go\/v\d+)\s+(v\S+)/gm)) {
    requirements.set(match[1]!, match[2]!);
  }
  return requirements;
}

/** Reads `const PackageVersion = "x.y.z"` from a release-please managed `internal/version.go`. */
export function parsePackageVersion(versionGo: string, label: string): string {
  const version = versionGo.match(/^const PackageVersion = "(\d+\.\d+\.\d+[^"]*)"/m)?.[1];
  if (!version) throw new Error(`${label}: internal/version.go has no PackageVersion`);
  return version;
}

async function collectServices(provider: SourceTree): Promise<ServiceSource[]> {
  const files = await provider.listFiles('internal/services', (file) =>
    /^internal\/services\/\w+\/(?:resource|data_source|list_data_source)\.go$/.test(file),
  );
  const services: ServiceSource[] = [];
  for (const file of files) {
    const kind = SERVICE_FILES[path.posix.basename(file)]!;
    const parsed = parseServiceSource(await provider.requireText(file), kind);
    if (parsed) services.push(parsed);
  }
  return services;
}

async function collectApiMarkdown(sdk: SourceTree): Promise<Map<string, string>> {
  const endpoints = new Map<string, string>();
  for (const file of await sdk.listFiles('.', (relative) => /(?:^|\/)api\.md$/.test(relative))) {
    parseSdkApiMarkdown(await sdk.requireText(file), endpoints);
  }
  return endpoints;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'provider-dir': { type: 'string' },
      'sdk-dir': { type: 'string', multiple: true },
      output: { type: 'string' },
      check: { type: 'boolean', default: false },
      'allow-unresolved': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values['provider-dir']) throw new Error(`Missing --provider-dir\n\n${USAGE}`);

  const provider = await SourceTree.open('provider', values['provider-dir']);
  const version = parsePackageVersion(await provider.requireText('internal/version.go'), 'provider');
  const services = await collectServices(provider);
  const requirements = parseSdkRequirements(await provider.requireText('go.mod'));

  const sdkDirs = new Map<string, string>();
  for (const entry of values['sdk-dir'] ?? []) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`--sdk-dir expects <module>=<path>, received ${entry}`);
    sdkDirs.set(entry.slice(0, separator), entry.slice(separator + 1));
  }

  const usedModules = [...new Set(services.flatMap(({ sdkModule }) => (sdkModule ? [sdkModule] : [])))].sort();
  const sdks: Array<{ module: string; version: string; commit?: string }> = [];
  const sdkEndpoints = new Map<string, Map<string, string>>();
  for (const module of usedModules) {
    const required = requirements.get(module);
    if (!required) throw new Error(`Provider imports ${module} but its go.mod does not require it`);
    const directory = sdkDirs.get(module);
    if (!directory) {
      throw new Error(`Missing --sdk-dir ${module}=<path> (provider v${version} requires ${module} ${required})`);
    }
    const sdk = await SourceTree.open(module, directory);
    const sdkVersion = parsePackageVersion(await sdk.requireText('internal/version.go'), module);
    const commit = await sdk.gitCommit();
    // Pseudo-versions (`v7.12.1-0.20261001120000-0123456789ab`) pin a commit, not a release.
    const pseudoCommit = required.match(/[.-]\d{14}-([0-9a-f]{12})$/)?.[1];
    const matches = pseudoCommit ? commit?.startsWith(pseudoCommit) === true : `v${sdkVersion}` === required;
    if (!matches) {
      const found = pseudoCommit ? `commit ${commit ?? '<unknown>'}` : `v${sdkVersion}`;
      throw new Error(`${module}: checkout is ${found} but provider v${version} requires ${required}`);
    }
    sdks.push({ module, version: required, ...(commit ? { commit } : {}) });
    sdkEndpoints.set(module, await collectApiMarkdown(sdk));
  }

  // Read only the documentation and example files each declaration needs.
  const providerFiles = new Map<string, string | undefined>();
  for (const service of services) {
    for (const file of Object.values(declarationFiles(service.kind, service.name))) {
      if (!providerFiles.has(file)) providerFiles.set(file, await provider.readText(file));
    }
  }

  const commit = await provider.gitCommit();
  const docs = buildTerraformDocs({
    provider: { repository: PROVIDER_REPOSITORY, version, ...(commit ? { commit } : {}) },
    sdks,
    services,
    sdkEndpoints,
    readProviderFile: (file) => providerFiles.get(file),
  });

  const summary = `${docs.stats.declarations} declarations (${docs.stats.linkedDeclarations} linked), ${docs.stats.endpoints} endpoints, ${docs.stats.unresolvedCalls} unresolved calls`;
  if (docs.unresolvedCalls.length > 0 && !values['allow-unresolved']) {
    const sample = docs.unresolvedCalls.slice(0, 20).map(({ declaration, call }) => `  ${declaration}: ${call}`);
    throw new Error(
      `Provider v${version}: ${docs.unresolvedCalls.length} SDK calls could not be resolved to an endpoint.\n${sample.join('\n')}\n` +
        'The provider or cloudflare-go code shape may have changed. Re-run with --allow-unresolved to inspect.',
    );
  }

  const output = path.resolve(values.output ?? DEFAULT_OUTPUT);
  const serialized = `${JSON.stringify(docs, null, 1)}\n`;
  const relativeOutput = path.relative(process.cwd(), output);
  if (values.check) {
    const current = existsSync(output) ? await readFile(output, 'utf8') : '';
    if (current !== serialized) {
      throw new Error(`${relativeOutput} is out of date for provider v${version}. Run generate:terraform-docs.`);
    }
    console.log(`generate-terraform-docs: ${relativeOutput} is up to date with provider v${version} (${summary})`);
    return;
  }
  await writeFile(output, serialized, 'utf8');
  console.log(`generate-terraform-docs: wrote ${relativeOutput} for provider v${version} (${summary})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
    process.exitCode = 1;
  });
}
