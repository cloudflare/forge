#!/usr/bin/env tsx
// Post-build step for the sdk-map:
//   1. Copy the generated sdk-map.json into the published dist tree so a
//      downstream consumer that only installs the package can read it.
//   2. Verify every entry resolves to a real function on a constructed
//      CloudflareApiClient — using the built dist artifact (i.e. exactly what is
//      published), not the TypeScript source. This is the acceptance guarantee
//      that the map matches the client and was not hand-written.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface SdkMapEntry {
  accessor: string[];
  method: string;
  requestType?: string;
  responseType?: string;
  requestBodyProperty?: string;
  requiredRequestProperties?: string[];
}

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_MAP = join(PKG_ROOT, 'src', '_generated', 'sdk-map.json');
const DIST_GENERATED = join(PKG_ROOT, 'dist', '_generated');
const DIST_MAP = join(DIST_GENERATED, 'sdk-map.json');
const DIST_INDEX = join(PKG_ROOT, 'dist', 'index.js');

async function main(): Promise<void> {
  if (!existsSync(SRC_MAP)) {
    throw new Error(`verify-sdk-map: missing ${SRC_MAP}; run generate first.`);
  }
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`verify-sdk-map: missing ${DIST_INDEX}; run build first.`);
  }

  mkdirSync(DIST_GENERATED, { recursive: true });
  copyFileSync(SRC_MAP, DIST_MAP);

  const map = (await import(pathToFileURL(DIST_MAP).href, { with: { type: 'json' } })).default as Record<
    string,
    SdkMapEntry
  >;
  const { CloudflareApiClient, getSdkMapEntry } = (await import(pathToFileURL(DIST_INDEX).href)) as {
    CloudflareApiClient: new (options: { apiToken: string }) => Record<string, unknown>;
    getSdkMapEntry: (operationId: string) => SdkMapEntry | undefined;
  };

  const client = new CloudflareApiClient({ apiToken: 'verify-sdk-map' });
  const failures: string[] = [];
  for (const operationId of Object.keys(map)) {
    const entry = getSdkMapEntry(operationId);
    if (entry === undefined) {
      failures.push(`${operationId}: getSdkMapEntry returned undefined`);
      continue;
    }
    let node: unknown = client;
    for (const segment of entry.accessor) {
      node = node == null ? undefined : (node as Record<string, unknown>)[segment];
    }
    const fn = node == null ? undefined : (node as Record<string, unknown>)[entry.method];
    if (typeof fn !== 'function') {
      failures.push(`${operationId}: client.${[...entry.accessor, entry.method].join('.')} is not a function`);
    }
  }

  if (getSdkMapEntry('verify-sdk-map:unknown-operation') !== undefined) {
    failures.push('unknown operation ID: getSdkMapEntry did not return undefined');
  }

  if (failures.length > 0) {
    const sample = failures.slice(0, 25).join('\n  - ');
    throw new Error(
      `verify-sdk-map: ${failures.length} entr(ies) did not resolve on a constructed client:\n  - ${sample}${
        failures.length > 25 ? `\n  … and ${failures.length - 25} more` : ''
      }`,
    );
  }

  console.log(
    `verify-sdk-map: copied ${DIST_MAP}; ${Object.keys(map).length} entr(ies) resolve on a constructed client`,
  );
}

await main();
