/**
 * Generates the Terraform docs file (`--output`) from the released Cloudflare Terraform provider.
 * The caller chooses where the file goes: the repository root's `pnpm generate:terraform-docs`
 * writes it into `cloudflare-api-site`.
 *
 * `./sources.ts` clones the provider and the cloudflare-go versions it requires into a cache; it is
 * the only part that uses the network. Everything else is offline and read-only: the checkouts are
 * read through `SourceTree`, which confines reads to each checkout and refuses symbolic links, and
 * nothing in them is executed.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generatedTerraformDocsSchema } from './schema.ts';
import { SourceTree } from './source-tree.ts';
import { cloneRelease, resolveLatestProviderVersion } from './sources.ts';
import {
  buildTerraformDocs,
  declarationFiles,
  parseSdkApiMarkdown,
  parseServiceSource,
  SERVICE_FILES,
  type ServiceSource,
} from './terraform-provider.ts';

const PROVIDER_REPOSITORY = 'https://github.com/cloudflare/terraform-provider-cloudflare';

const USAGE = `Usage: generate-terraform-docs --output <file> [--provider-version <x.y.z|latest>] [--check] [--allow-unresolved]

  --output <file>                    The file to write, or with --check, to compare against
  --provider-version <x.y.z|latest>  Provider release to document; latest is the newest stable one on the
                                     Terraform registry. Default: the version recorded in <file>
  --check                            Fail if <file> is out of date instead of writing it
  --allow-unresolved                 Do not fail when provider SDK calls cannot be resolved to endpoints

Sources are cloned into node_modules/.cache/terraform-docs and reused.`;

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
  if (!version) {
    throw new Error(`${label}: internal/version.go has no PackageVersion`);
  }
  return version;
}

/**
 * Checks the version a checkout's `internal/version.go` reports against the tag it was cloned from.
 * Release-please does not always bump that file for patch releases (provider v5.28.1 and
 * cloudflare-go v7.13.1 both report x.y.0), so a patch-only mismatch returns a warning; any other
 * mismatch throws.
 */
export function checkReportedVersion(label: string, tag: string, reported: string): string | undefined {
  const version = tag.replace(/^v/, '');
  if (reported === version) {
    return undefined;
  }
  const minor = (value: string) => value.match(/^(\d+\.\d+)\.\d+$/)?.[1];
  const tagMinor = minor(version);
  if (tagMinor && tagMinor === minor(reported)) {
    return `${label}: v${version} checkout reports version ${reported}; continuing with the tag`;
  }
  throw new Error(`${label}: v${version} checkout reports version ${reported}`);
}

async function collectServices(provider: SourceTree): Promise<ServiceSource[]> {
  const files = await provider.listFiles('internal/services', (file) =>
    /^internal\/services\/\w+\/(?:resource|data_source|list_data_source)\.go$/.test(file),
  );
  const services: ServiceSource[] = [];
  for (const file of files) {
    const kind = SERVICE_FILES[path.posix.basename(file)]!;
    const parsed = parseServiceSource(await provider.requireText(file), kind);
    if (parsed) {
      services.push(parsed);
    }
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

/** The provider version recorded in an existing generated file. */
async function recordedVersion(file: string): Promise<string> {
  if (!existsSync(file)) {
    throw new Error(`${file} doesn't exist yet; pass --provider-version`);
  }
  const recorded = generatedTerraformDocsSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!recorded.success) {
    throw new Error(`${file} isn't a valid Terraform docs file; pass --provider-version`);
  }
  return recorded.data.source.provider.version;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      output: { type: 'string' },
      'provider-version': { type: 'string' },
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
  if (!values.output) {
    throw new Error(`Missing --output\n\n${USAGE}`);
  }
  const output = path.resolve(values.output);
  const requested = values['provider-version'];
  const version = (
    requested === 'latest' ? await resolveLatestProviderVersion() : (requested ?? (await recordedVersion(output)))
  ).replace(/^v/, '');
  const cache = path.resolve('node_modules', '.cache', 'terraform-docs', `v${version}`);

  const provider = await SourceTree.open(
    'provider',
    await cloneRelease('terraform-provider-cloudflare', `v${version}`, path.join(cache, 'provider')),
  );
  const providerVersion = parsePackageVersion(await provider.requireText('internal/version.go'), 'provider');
  const providerWarning = checkReportedVersion('provider', version, providerVersion);
  if (providerWarning) {
    console.warn(`warning: ${providerWarning}`);
  }
  const services = await collectServices(provider);
  const requirements = parseSdkRequirements(await provider.requireText('go.mod'));

  // Only the cloudflare-go modules the provider's services import, at the versions its go.mod pins.
  const usedModules = [...new Set(services.flatMap(({ sdkModule }) => (sdkModule ? [sdkModule] : [])))].sort();
  const sdks: Array<{ module: string; version: string; commit?: string }> = [];
  const sdkEndpoints = new Map<string, Map<string, string>>();
  for (const module of usedModules) {
    const required = requirements.get(module);
    if (!required) {
      throw new Error(`Provider imports ${module} but its go.mod does not require it`);
    }
    const sdk = await SourceTree.open(
      module,
      await cloneRelease('cloudflare-go', required, path.join(cache, path.posix.basename(module))),
    );
    const sdkVersion = parsePackageVersion(await sdk.requireText('internal/version.go'), module);
    const sdkWarning = checkReportedVersion(module, required, sdkVersion);
    if (sdkWarning) {
      console.warn(`warning: ${sdkWarning}`);
    }
    const commit = await sdk.gitCommit();
    sdks.push({ module, version: required, ...(commit ? { commit } : {}) });
    sdkEndpoints.set(module, await collectApiMarkdown(sdk));
  }

  // Read only the documentation and example files each declaration needs.
  const providerFiles = new Map<string, string | undefined>();
  for (const service of services) {
    for (const file of Object.values(declarationFiles(service.kind, service.name))) {
      if (!providerFiles.has(file)) {
        providerFiles.set(file, await provider.readText(file));
      }
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

  const serialized = `${JSON.stringify(docs, null, 1)}\n`;
  const relativeOutput = path.relative(process.cwd(), output);
  if (values.check) {
    const current = existsSync(output) ? await readFile(output, 'utf8') : '';
    if (current !== serialized) {
      throw new Error(`${relativeOutput} is out of date for provider v${version}. Regenerate it without --check.`);
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
