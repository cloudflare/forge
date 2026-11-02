import { readFile, stat } from 'node:fs/promises';

const FORGE_RELEASES_URL = new URL('https://github.com/cloudflare/forge/releases/');
const FORGE_OPENAPI_ASSET = 'openapi.forge.json';

export interface ForgeOpenApiSource {
  document: unknown;
  /** When the artifact last changed, when its source says. */
  lastModified?: Date;
}

function lastModifiedOf(header: string | null): Date | undefined {
  const date = header ? new Date(header) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function parseForgeOpenApi(source: string, location: string): unknown {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(`Could not parse the Forge OpenAPI artifact as JSON (${location})`, { cause });
  }
}

export function forgeOpenApiUrl(release = process.env['FORGE_OPENAPI_RELEASE']): URL {
  const revision = release?.trim();
  const assetPath = revision
    ? `download/${encodeURIComponent(revision)}/${FORGE_OPENAPI_ASSET}`
    : `latest/download/${FORGE_OPENAPI_ASSET}`;
  return new URL(assetPath, FORGE_RELEASES_URL);
}

export async function fetchForgeOpenApi(
  release = process.env['FORGE_OPENAPI_RELEASE'],
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ForgeOpenApiSource> {
  const url = forgeOpenApiUrl(release);
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(
      `Could not fetch the Forge OpenAPI release asset: ${response.status} ${response.statusText} (${url})`,
    );
  }

  try {
    return { document: await response.json(), lastModified: lastModifiedOf(response.headers.get('last-modified')) };
  } catch (cause) {
    throw new Error(`Could not parse the Forge OpenAPI release asset as JSON (${url})`, { cause });
  }
}

export async function loadForgeOpenApi(
  specPath = process.env['FORGE_OPENAPI_SPEC'],
  release = process.env['FORGE_OPENAPI_RELEASE'],
): Promise<ForgeOpenApiSource> {
  if (!specPath) return fetchForgeOpenApi(release);

  let source: string;
  let lastModified: Date;
  try {
    [source, { mtime: lastModified }] = await Promise.all([readFile(specPath, 'utf8'), stat(specPath)]);
  } catch (cause) {
    throw new Error(`Could not read the Forge OpenAPI artifact (${specPath})`, { cause });
  }
  return { document: parseForgeOpenApi(source, specPath), lastModified };
}
