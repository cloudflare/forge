/**
 * Client for the external API search Worker. The site reads its URL from
 * `PUBLIC_API_SEARCH_URL`; `GET <url>?q=<query>[&kind=<kind>]` answers
 * `{ hits, hasMore }`.
 */

export const SEARCH_KINDS = ['resource', 'http_method'] as const;

/**
 * Debounce between the reader's last keystroke and the request: long enough to
 * skip the letters of a word typed in one go, short enough not to be felt.
 */
export const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_TIMEOUT_MS = 5_000;

export type SearchKind = (typeof SEARCH_KINDS)[number];
export type SearchFilterKind = 'all' | SearchKind;

export interface SearchHit {
  id: string;
  kind: SearchKind;
  title: string;
  /** Absolute URL pathname of the hit's page on this site. */
  path: string;
  crumbs: string[];
  httpMethod?: string;
  endpoint?: string;
  qualifiedName?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  hasMore: boolean;
}

function isSafePathname(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

function isSearchHit(value: unknown): value is SearchHit {
  if (!value || typeof value !== 'object') return false;
  const hit = value as Record<string, unknown>;
  return (
    typeof hit['id'] === 'string' &&
    typeof hit['title'] === 'string' &&
    isSafePathname(hit['path']) &&
    SEARCH_KINDS.includes(hit['kind'] as SearchKind) &&
    Array.isArray(hit['crumbs']) &&
    hit['crumbs'].every((crumb) => typeof crumb === 'string')
  );
}

/** Checks a search response's shape and validates each hit's fields and path. */
export function parseSearchResult(value: unknown): SearchResult {
  if (!value || typeof value !== 'object') throw new Error('Search response is malformed');
  const { hits, hasMore } = value as { hits?: unknown; hasMore?: unknown };
  if (!Array.isArray(hits) || typeof hasMore !== 'boolean' || !hits.every(isSearchHit)) {
    throw new Error('Search response is malformed');
  }
  return { hits, hasMore };
}

/** Queries the search Worker with a query the caller has trimmed. */
export async function searchApi({
  apiUrl,
  query,
  kind,
  signal,
  requestTimeoutMs = SEARCH_TIMEOUT_MS,
}: {
  apiUrl: string;
  query: string;
  kind?: SearchKind | undefined;
  signal?: AbortSignal | undefined;
  requestTimeoutMs?: number;
}): Promise<SearchResult> {
  const url = new URL(apiUrl);
  url.searchParams.set('q', query);
  if (kind) url.searchParams.set('kind', kind);

  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  if (!response.ok) throw new Error(`Search request failed with status ${response.status}`);
  return parseSearchResult(await response.json());
}

/**
 * The crumbs that lead to a hit, without the hit itself: the search index ends
 * every trail with the page's own title, which a result already shows.
 */
export function searchHitParents(hit: Pick<SearchHit, 'title' | 'crumbs'>): string[] {
  return hit.crumbs.at(-1) === hit.title ? hit.crumbs.slice(0, -1) : hit.crumbs;
}

/**
 * A hit's parents as one line. A deep trail keeps its ends, the product and
 * the two nearest parents, since those are what tell two results apart.
 */
export function searchHitTrail(hit: Pick<SearchHit, 'title' | 'crumbs'>): string {
  const parents = searchHitParents(hit);
  const shown = parents.length > 3 ? [parents[0], '…', ...parents.slice(-2)] : parents;
  return shown.join(' › ');
}

/** How many results a search found, as the dialog announces it. */
export function searchCountLabel(count: number): string {
  if (count === 0) return 'No results';
  return count === 1 ? '1 result' : `${count} results`;
}

/** Recent answers by query and kind, so a repeated or restored query needs no request. */
export class SearchCache {
  readonly #results = new Map<string, SearchResult>();
  readonly #capacity: number;

  constructor(capacity = 40) {
    this.#capacity = Math.max(1, capacity);
  }

  static #key(query: string, kind: SearchKind | undefined): string {
    return `${kind ?? ''}\n${query.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  }

  get(query: string, kind?: SearchKind): SearchResult | undefined {
    const key = SearchCache.#key(query, kind);
    const result = this.#results.get(key);
    if (!result) return undefined;
    // Re-insert so the least recently used answer is the first to go.
    this.#results.delete(key);
    this.#results.set(key, result);
    return result;
  }

  set(query: string, kind: SearchKind | undefined, result: SearchResult): void {
    const key = SearchCache.#key(query, kind);
    this.#results.delete(key);
    this.#results.set(key, result);
    while (this.#results.size > this.#capacity) {
      const oldest = this.#results.keys().next();
      if (oldest.done) break;
      this.#results.delete(oldest.value);
    }
  }
}

/** A result the reader opened, kept to offer again before they type. */
export type RecentSearchHit = SearchHit;

export const MAX_RECENT_SEARCH_HITS = 5;

/** `recent` with `hit` first, once, and no longer than `limit`. */
export function addRecentSearchHit(
  recent: readonly RecentSearchHit[],
  hit: RecentSearchHit,
  limit = MAX_RECENT_SEARCH_HITS,
): RecentSearchHit[] {
  return [hit, ...recent.filter((entry) => entry.path !== hit.path)].slice(0, limit);
}

/** Reads stored recent hits, dropping anything that is not one. */
export function parseRecentSearchHits(value: unknown, limit = MAX_RECENT_SEARCH_HITS): RecentSearchHit[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSearchHit).slice(0, limit);
}

/** The index `step` away from `current` in a list of `count`, wrapping at both ends. */
export function wrapIndex(current: number, step: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (((current + step) % count) + count) % count;
}
