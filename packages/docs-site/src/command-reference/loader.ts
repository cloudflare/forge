import type { Loader } from 'astro/loaders';
import { commandCatalogSchema } from './schema.ts';

export const COMMAND_CATALOG_ENTRY_ID = 'catalog';
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type CommandCatalogSource = () => unknown | Promise<unknown>;

export interface RemoteCommandCatalogOptions {
  maxResponseBytes?: number;
  timeoutMs?: number;
}

async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error(`Command catalog response exceeds ${maxResponseBytes} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }

  return body + decoder.decode();
}

/** Creates a build-time source for a public command catalog endpoint. */
export function remoteCommandCatalogSource(
  url: string | URL,
  fetcher: typeof fetch = fetch,
  options: RemoteCommandCatalogOptions = {},
) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:') throw new Error('Command catalog endpoints must use HTTPS');
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError('maxResponseBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer');
  }

  return async () => {
    const response = await fetcher(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Could not fetch the command catalog: ${response.status} ${response.statusText}`);
    }

    const declaredBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new Error(`Command catalog response exceeds ${maxResponseBytes} bytes`);
    }

    const body = await readBoundedBody(response, maxResponseBytes);

    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error('Command catalog response is not valid JSON', { cause: error });
    }
  };
}

/** Loads one versioned command catalog from an injected local or remote source. */
export function commandCatalogLoader(source: CommandCatalogSource) {
  return {
    name: 'command-reference',
    schema: commandCatalogSchema,
    async load({ generateDigest, logger, parseData, store }) {
      const sourceData = commandCatalogSchema.parse(await source());
      const data = await parseData({ id: COMMAND_CATALOG_ENTRY_ID, data: sourceData });
      const digest = generateDigest(data);

      store.clear();
      store.set({ id: COMMAND_CATALOG_ENTRY_ID, data, digest });
      logger.info(`Loaded ${data.commands.length} command(s)`);
    },
  } satisfies Loader;
}
