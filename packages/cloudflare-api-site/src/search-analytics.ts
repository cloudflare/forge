/**
 * Best-effort search analytics, posted to the search Worker's `/api/stats`.
 * Events are buffered and flushed on a timer, when the buffer fills, and with
 * `sendBeacon` when the page is hidden or left. Failures are ignored.
 */

const ANALYTICS_VERSION = 'api-docs-search/1';
const DEFAULT_FLUSH_INTERVAL_MS = 20_000;
const DEFAULT_MAX_BUFFER_SIZE = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 1_024;
const MAX_RESULT_ID_LENGTH = 256;

export interface SearchAnalyticsEvent {
  inputQuery: string;
  snippetVersion: string;
  totalResult: number;
  clickedResultId?: string;
  clickPosition?: number;
  clickViewMore?: boolean;
}

export interface SearchAnalyticsOptions {
  flushIntervalMs?: number;
  maxBufferSize?: number;
  requestTimeoutMs?: number;
}

/** The stats endpoint beside a search endpoint: `/api/search` → `/api/stats`. */
export function statsUrlForSearch(apiUrl: string): string {
  const url = new URL(apiUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.at(-1) === 'search') segments[segments.length - 1] = 'stats';
  else segments.push('stats');
  url.pathname = `/${segments.join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function searchEvent(inputQuery: string, totalResult: number): SearchAnalyticsEvent {
  return { inputQuery: inputQuery.slice(0, MAX_QUERY_LENGTH), snippetVersion: ANALYTICS_VERSION, totalResult };
}

export function clickEvent(
  inputQuery: string,
  totalResult: number,
  clickedResultId: string,
  clickPosition: number,
): SearchAnalyticsEvent {
  return {
    ...searchEvent(inputQuery, totalResult),
    clickedResultId: clickedResultId.slice(0, MAX_RESULT_ID_LENGTH),
    clickPosition,
    clickViewMore: false,
  };
}

export class SearchAnalytics {
  readonly #endpoint: string;
  readonly #flushIntervalMs: number;
  readonly #maxBufferSize: number;
  readonly #requestTimeoutMs: number;
  #events: SearchAnalyticsEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  readonly #pageHide = () => this.#flushForNavigation();
  readonly #visibilityChange = () => {
    if (document.visibilityState === 'hidden') this.#flushForNavigation();
  };

  constructor(apiUrl: string, options: SearchAnalyticsOptions = {}) {
    this.#endpoint = statsUrlForSearch(apiUrl);
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#maxBufferSize = Math.max(1, options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pagehide', this.#pageHide);
      document.addEventListener('visibilitychange', this.#visibilityChange);
    }
  }

  trackSearch(inputQuery: string, totalResult: number): void {
    this.#track(searchEvent(inputQuery, totalResult));
  }

  trackClick(inputQuery: string, totalResult: number, clickedResultId: string, clickPosition: number): void {
    this.#track(clickEvent(inputQuery, totalResult, clickedResultId, clickPosition));
  }

  flush(): void {
    const events = this.#drain();
    if (events.length > 0) this.#post(JSON.stringify({ events }));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.removeEventListener('pagehide', this.#pageHide);
      document.removeEventListener('visibilitychange', this.#visibilityChange);
    }
    this.#flushForNavigation();
  }

  #track(event: SearchAnalyticsEvent): void {
    if (this.#destroyed) return;
    this.#events.push(event);
    if (this.#events.length >= this.#maxBufferSize) this.flush();
    else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.flush();
      }, this.#flushIntervalMs);
    }
  }

  #post(body: string): void {
    if (typeof fetch === 'undefined') return;
    void fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    }).catch(() => undefined);
  }

  #flushForNavigation(): void {
    const events = this.#drain();
    if (events.length === 0) return;
    const body = JSON.stringify({ events });

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        // Send as text/plain so cross-origin beacons avoid a credentialed CORS preflight.
        if (navigator.sendBeacon(this.#endpoint, body)) return;
      } catch {
        // Fall back to a keepalive request.
      }
    }
    this.#post(body);
  }

  #drain(): SearchAnalyticsEvent[] {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const events = this.#events;
    this.#events = [];
    return events;
  }
}
