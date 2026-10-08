import { readFile } from 'node:fs/promises';

const FORGE_RELEASES_URL = new URL('https://github.com/cloudflare/forge/releases/');
const FORGE_OPENAPI_ASSET = 'openapi.forge.json';

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
): Promise<unknown> {
  const url = forgeOpenApiUrl(release);
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(
      `Could not fetch the Forge OpenAPI release asset: ${response.status} ${response.statusText} (${url})`,
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new Error(`Could not parse the Forge OpenAPI release asset as JSON (${url})`, { cause });
  }
}

export async function loadForgeOpenApi(
  specPath = process.env['FORGE_OPENAPI_SPEC'],
  release = process.env['FORGE_OPENAPI_RELEASE'],
  readTextFile: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<unknown> {
  if (!specPath) return fetchForgeOpenApi(release);

  let source: string;
  try {
    source = await readTextFile(specPath);
  } catch (cause) {
    throw new Error(`Could not read the Forge OpenAPI artifact (${specPath})`, { cause });
  }
  return parseForgeOpenApi(source, specPath);
}
