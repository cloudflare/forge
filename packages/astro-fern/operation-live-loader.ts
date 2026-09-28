import type { LiveLoader } from 'astro/loaders';
import { fernArtifactDigest, fernOperationArtifactPath } from './content-contract.ts';
import { contentOperationArtifactSchema, type FernContentOperationEntrySchema } from './content/schema.ts';

const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Minimal Fetch-compatible transport used to retrieve a published operation
 * artifact. Adapter asset bindings, object-store clients, and test doubles can
 * implement this interface without depending on a specific platform.
 */
export interface FernArtifactFetcher {
  /** Executes a request for a published Fern artifact. */
  fetch(request: Request): Promise<Response>;
}

/** Lookup supplied by `astro-fern/server` to the `apiOperations` Live Collection. */
export interface FernOperationLiveFilter {
  /** Stable semantic operation entry ID expected in the exact artifact payload. */
  id: string;
  /** SHA-256 digest of the exact artifact bytes expected at the URL. */
  digest: string;
  /** Trusted URL origin used to construct the artifact request. */
  origin: string;
  /** Astro deployment base prepended to the public artifact path. */
  base?: string;
  /** Optional transport; global `fetch` is used when omitted. */
  fetcher?: FernArtifactFetcher;
}

function operationError(entryId: string, message: string): Error {
  return new Error(`astro-fern: operation artifact "${entryId}" ${message}`);
}

/**
 * Creates the loader for the `apiOperations` Astro Live Collection.
 *
 * The loader supports individual lookups only. It validates HTTP status, JSON,
 * byte digest, artifact schema, and operation identity before returning an
 * entry. A 404 is reported to Astro as a missing entry; invalid responses are
 * returned as Live Loader errors, while transport exceptions reject.
 */
export function fernOperationLiveLoader(): LiveLoader<FernContentOperationEntrySchema, FernOperationLiveFilter, never> {
  return {
    name: 'astro-fern:operations',
    async loadEntry({ filter }) {
      let url: URL;
      try {
        url = new URL(fernOperationArtifactPath(filter.digest, filter.base), filter.origin);
      } catch (error) {
        return { error: operationError(filter.id, `has an invalid lookup: ${String(error)}`) };
      }
      const request = new Request(url, { headers: { Accept: 'application/json' } });
      const response = await (filter.fetcher ? filter.fetcher.fetch(request) : fetch(request));
      if (response.status === 404) return undefined;
      if (!response.ok) {
        return { error: operationError(filter.id, `could not be loaded (${response.status} ${response.statusText})`) };
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        return { error: operationError(filter.id, `could not be read: ${String(error)}`) };
      }
      const actualDigest = await fernArtifactDigest(bytes);
      if (actualDigest !== filter.digest) {
        return {
          error: operationError(filter.id, `has digest "${actualDigest}", expected "${filter.digest}"`),
        };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(DECODER.decode(bytes));
      } catch (error) {
        return { error: operationError(filter.id, `is not valid UTF-8 JSON: ${String(error)}`) };
      }
      const parsed = contentOperationArtifactSchema.safeParse(payload);
      if (!parsed.success) {
        return { error: operationError(filter.id, `does not match its schema: ${parsed.error.message}`) };
      }
      if (parsed.data.id !== filter.id) {
        return { error: operationError(filter.id, `contains entry ID "${parsed.data.id}"`) };
      }
      return {
        // Semantic operation IDs can recur across snapshots; the digest identifies these exact bytes.
        id: filter.digest,
        data: parsed.data,
        cacheHint: {
          tags: [`fern:artifact:${filter.digest}`, `fern:operation:${filter.id}`],
        },
      };
    },
    async loadCollection() {
      return { error: new Error('astro-fern: operation artifacts must be loaded individually') };
    },
  };
}
