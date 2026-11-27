/**
 * API search dialog. Queries as the reader types, keeps the last answer on
 * screen until the next one arrives, and answers repeated queries from memory.
 * The input keeps focus; arrow keys move a selection through the results,
 * which are plain links, so clicks and their modifiers work as anywhere else.
 */

import { lockScroll, mount, onShortcut, syncShortcutHints, unlockScroll } from '@cloudflare/nimbus-docs/client';
import { methodLabel } from '@/components/ui/api-sidebar/method';
import { shortcuts } from '@/lib/shortcuts';
import {
  addRecentSearchHit,
  parseRecentSearchHits,
  parseSearchResult,
  SEARCH_DEBOUNCE_MS,
  SEARCH_KINDS,
  SearchCache,
  searchApi,
  searchCountLabel,
  searchHitTrail,
  wrapIndex,
  type RecentSearchHit,
  type SearchFilterKind,
  type SearchKind,
  type SearchResult,
} from '@/search';
import { SearchAnalytics } from '@/search-analytics';
import { splitSearchHighlight } from '@/search-highlight';

/** A request slower than this shows the spinner; a faster one shows only its answer. */
const SPINNER_DELAY_MS = 300;
/** The query a reader left open comes back, with its results, for this long. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_KEY = 'cf-api-search';
const RECENT_KEY = 'cf-api-search-recent';

interface Session {
  query: string;
  filter: SearchFilterKind;
  result?: SearchResult | undefined;
  at: number;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

/** A path wraps after a slash, never at a hyphen inside a segment. */
function pathText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text
    .replaceAll('-', '\u2011')
    .split(/(?<=\/)/)
    .forEach((segment, index) => {
      if (index > 0) fragment.append(document.createElement('wbr'));
      fragment.append(segment);
    });
  return fragment;
}

/** `text` with the parts that match `query` marked, each part shaped by `format`. */
function highlighted(
  text: string,
  query: string,
  format: (part: string) => Node | string = (part) => part,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of splitSearchHighlight(text, query)) {
    const content = format(part.text);
    fragment.append(part.highlighted ? element('mark', undefined, content) : content);
  }
  return fragment;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}

function isFilterKind(value: unknown): value is SearchFilterKind {
  return value === 'all' || SEARCH_KINDS.includes(value as SearchKind);
}

function readStorage(storage: () => Storage, key: string): unknown {
  try {
    return JSON.parse(storage().getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeStorage(storage: () => Storage, key: string, value: unknown): void {
  try {
    if (value === undefined) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or off: search works without it.
  }
}

function readSession(): Session | undefined {
  const value = readStorage(() => sessionStorage, SESSION_KEY) as Partial<Session> | null;
  if (!value || typeof value.query !== 'string' || !isFilterKind(value.filter)) return undefined;
  if (typeof value.at !== 'number' || Date.now() - value.at > SESSION_TTL_MS) return undefined;
  let result: SearchResult | undefined;
  try {
    result = value.result ? parseSearchResult(value.result) : undefined;
  } catch {
    result = undefined;
  }
  return { query: value.query, filter: value.filter, result, at: value.at };
}

function isMac(): boolean {
  return /mac|iphone|ipad/i.test(navigator.userAgent);
}

function initSearch(root: HTMLElement): () => void {
  const apiUrl = root.dataset['apiUrl'];
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const dialog = find<HTMLDialogElement>('[data-cf-search-dialog]');
  const input = find<HTMLInputElement>('[data-cf-search-input]');
  const list = find('[data-cf-search-results]');
  const body = find('[data-cf-search-body]');
  const filtersBar = find('[data-cf-search-bar="filters"]');
  const recentBar = find('[data-cf-search-bar="recent"]');
  const count = find('[data-cf-search-count]');
  const empty = find('[data-cf-search-message="empty"]');
  const emptyText = find('[data-cf-search-empty-text]');
  const widen = find('[data-cf-search-widen]');
  const failure = find('[data-cf-search-message="error"]');
  const idle = find('[data-cf-search-message="idle"]');
  if (
    !apiUrl ||
    !dialog ||
    !input ||
    !list ||
    !body ||
    !filtersBar ||
    !recentBar ||
    !count ||
    !empty ||
    !emptyText ||
    !widen ||
    !failure ||
    !idle
  ) {
    return () => {};
  }

  const filterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-cf-search-filter]'));
  const leads = new Map(
    Array.from(root.querySelectorAll<HTMLTemplateElement>('template[data-cf-search-lead]'), (node) => [
      node.dataset['cfSearchLead'],
      node,
    ]),
  );
  const cache = new SearchCache();

  let filter: SearchFilterKind = 'all';
  /** The rows on screen: results of `shown`, or recent hits when it is null. */
  let rows: RecentSearchHit[] = [];
  let shown: { query: string; filter: SearchFilterKind; result: SearchResult } | null = null;
  let active = -1;
  let pending = false;
  let openWhenAnswered = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let analytics: SearchAnalytics | undefined;
  let scrollLocked = false;
  let warmed = false;
  let pointer = { x: -1, y: -1 };
  let pressedBackdrop = false;

  const options = () => list.children as HTMLCollectionOf<HTMLAnchorElement>;
  const kindOf = (value: SearchFilterKind): SearchKind | undefined => (value === 'all' ? undefined : value);

  /** Opens a connection to the search Worker ahead of the first query. */
  function warm(): void {
    if (warmed) return;
    warmed = true;
    const { origin } = new URL(apiUrl!);
    if (origin === window.location.origin) return;
    const link = element('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.append(link);
  }

  function setActive(index: number, scroll = true): void {
    options()[active]?.setAttribute('aria-selected', 'false');
    active = rows.length === 0 ? -1 : Math.max(0, Math.min(index, rows.length - 1));
    const option = options()[active];
    if (!option) {
      input!.removeAttribute('aria-activedescendant');
      return;
    }
    option.setAttribute('aria-selected', 'true');
    input!.setAttribute('aria-activedescendant', option.id);
    if (scroll) {
      // The first and last rows bring the list's own padding with them.
      if (active === 0) body!.scrollTop = 0;
      else if (active === rows.length - 1) body!.scrollTop = body!.scrollHeight;
      else option.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderRow(row: RecentSearchHit, index: number, query: string): HTMLAnchorElement {
    const lead = element('span', 'cf-search-lead');
    const template = leads.get(row.kind);
    if (row.kind !== 'http_method' && template) lead.append(template.content.cloneNode(true));
    const chip = row.httpMethod ? template?.content.firstElementChild?.cloneNode(true) : undefined;
    if (chip instanceof HTMLElement) {
      chip.dataset['m'] = row.httpMethod!.toLowerCase();
      chip.textContent = methodLabel(row.httpMethod) ?? row.httpMethod!;
      chip.title = row.httpMethod!.toUpperCase();
      lead.append(chip);
    }

    const line = element('span', 'cf-search-line', element('span', 'cf-search-title', highlighted(row.title, query)));
    const main = element('span', 'cf-search-main', line);
    if (row.kind === 'resource' && row.qualifiedName) {
      line.append(element('span', 'cf-search-code', highlighted(row.qualifiedName, query)));
    }
    const trail = searchHitTrail(row);
    if (trail) line.append(element('span', 'cf-search-crumbs', trail));

    if (row.kind === 'http_method' && row.endpoint) {
      main.append(element('span', 'cf-search-code', highlighted(row.endpoint, query, pathText)));
    }

    const option = element('a', 'cf-search-hit', lead, main);
    option.href = row.path;
    option.id = `cf-search-hit-${index}`;
    option.tabIndex = -1;
    option.dataset['kind'] = row.kind;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    return option;
  }

  function renderRows(next: RecentSearchHit[], query: string): void {
    rows = next;
    active = -1;
    list!.replaceChildren(...rows.map((row, index) => renderRow(row, index, query)));
    list!.hidden = rows.length === 0;
    input!.setAttribute('aria-expanded', String(rows.length > 0));
    setActive(0, false);
    body!.scrollTop = 0;
  }

  function setLoading(loading: boolean): void {
    pending = loading;
    clearTimeout(spinnerTimer);
    list!.setAttribute('aria-busy', String(loading));
    if (loading) spinnerTimer = setTimeout(() => dialog!.setAttribute('data-loading', ''), SPINNER_DELAY_MS);
    else dialog!.removeAttribute('data-loading');
  }

  function readRecent(): RecentSearchHit[] {
    return parseRecentSearchHits(readStorage(() => localStorage, RECENT_KEY));
  }

  /** Nothing typed: the pages the reader last opened from here, if any. */
  function showIdle(): void {
    shown = null;
    const recent = readRecent();
    renderRows(recent, '');
    list!.removeAttribute('aria-label');
    list!.setAttribute('aria-labelledby', 'cf-search-recent-label');
    recentBar!.hidden = recent.length === 0;
    idle!.hidden = recent.length > 0;
    empty!.hidden = failure!.hidden = true;
    count!.textContent = '';
  }

  function showResult(query: string, result: SearchResult): void {
    shown = { query, filter, result };
    const { hits } = result;
    renderRows(hits, query);
    list!.setAttribute('aria-label', 'Results');
    list!.removeAttribute('aria-labelledby');
    filtersBar!.hidden = false;
    recentBar!.hidden = true;
    idle!.hidden = true;
    failure!.hidden = true;
    empty!.hidden = hits.length > 0;
    if (hits.length === 0) {
      const scope = filterButtons.find((button) => button.dataset['cfSearchFilter'] === filter)?.textContent?.trim();
      emptyText!.textContent =
        filter === 'all' ? `Nothing matches “${query}”.` : `Nothing in ${scope} matches “${query}”.`;
      widen!.hidden = filter === 'all';
    }
    // With no results the message below says so, and is announced in the count's place.
    count!.textContent = hits.length > 0 ? searchCountLabel(hits.length) : '';
  }

  function showError(): void {
    shown = null;
    renderRows([], '');
    filtersBar!.hidden = false;
    recentBar!.hidden = true;
    idle!.hidden = true;
    empty!.hidden = true;
    failure!.hidden = false;
    count!.textContent = '';
  }

  function cancel(): void {
    clearTimeout(debounceTimer);
    controller?.abort();
    controller = undefined;
    openWhenAnswered = false;
    setLoading(false);
  }

  /** Answers the input's query: from memory at once, otherwise after `delay`. */
  function runSearch(delay = SEARCH_DEBOUNCE_MS): void {
    cancel();
    const query = input!.value.trim();
    if (!query) {
      showIdle();
      return;
    }
    const kind = kindOf(filter);
    const cached = cache.get(query, kind);
    if (cached) {
      showResult(query, cached);
      return;
    }

    const request = new AbortController();
    controller = request;
    setLoading(true);
    debounceTimer = setTimeout(() => {
      searchApi({ apiUrl: apiUrl!, query, kind, signal: request.signal })
        .then((result) => {
          if (request.signal.aborted) return;
          const open = openWhenAnswered;
          cache.set(query, kind, result);
          cancel();
          showResult(query, result);
          analytics?.trackSearch(query, rows.length);
          if (open) activate(0);
        })
        .catch((error: unknown) => {
          if (request.signal.aborted || isAbortError(error)) return;
          cancel();
          showError();
        });
    }, delay);
  }

  function setFilter(kind: SearchFilterKind, search = true): void {
    filter = kind;
    for (const button of filterButtons) {
      const checked = button.dataset['cfSearchFilter'] === kind;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    if (search) runSearch(0);
  }

  /** Records that the reader opened row `index`: for analytics, and to offer it again. */
  function remember(index: number): void {
    const row = rows[index];
    if (!row) return;
    if (shown) analytics?.trackClick(shown.query, rows.length, row.id, index);
    const { id, kind, title, path, crumbs, httpMethod, endpoint, qualifiedName } = row;
    const recent = { id, kind, title, path, crumbs, httpMethod, endpoint, qualifiedName };
    writeStorage(() => localStorage, RECENT_KEY, addRecentSearchHit(readRecent(), recent));
  }

  /** Opens row `index` from the keyboard. */
  function activate(index: number): void {
    const row = rows[index];
    if (!row) return;
    remember(index);
    window.location.assign(row.path);
  }

  function saveSession(): void {
    const query = input!.value.trim();
    const session: Session | undefined = query
      ? { query, filter, result: cache.get(query, kindOf(filter)), at: Date.now() }
      : undefined;
    writeStorage(() => sessionStorage, SESSION_KEY, session);
  }

  function open(): void {
    if (dialog!.open) return;
    warm();
    analytics = new SearchAnalytics(apiUrl!);
    dialog!.showModal();
    lockScroll();
    scrollLocked = true;
    // The last query comes back selected: Enter repeats it, typing replaces it.
    input!.focus();
    input!.select();
    runSearch(0);
  }

  function close(): void {
    if (dialog!.open) dialog!.close();
  }

  const onClosed = () => {
    cancel();
    saveSession();
    if (scrollLocked) unlockScroll();
    scrollLocked = false;
    analytics?.destroy();
    analytics = undefined;
  };

  const onInput = (event: Event) => {
    // An IME's half-composed text is not a query yet; `compositionend` follows.
    if ((event as InputEvent).isComposing) return;
    runSearch();
  };

  function moveFilter(step: number): void {
    const index = filterButtons.findIndex((button) => button.dataset['cfSearchFilter'] === filter);
    const next = filterButtons[wrapIndex(index, step, filterButtons.length)];
    if (!next) return;
    setFilter(next.dataset['cfSearchFilter'] as SearchFilterKind);
    next.focus();
  }

  function pageSize(): number {
    const option = options()[Math.max(active, 0)];
    return option ? Math.max(1, Math.floor(body!.clientHeight / option.offsetHeight) - 1) : 1;
  }

  const onKeydown = (event: KeyboardEvent) => {
    // Safari reports the Enter that commits an IME's text as key code 229, after composing ends.
    if (event.isComposing || event.keyCode === 229) return;
    const { key } = event;
    const inFilters = filterButtons.includes(event.target as HTMLButtonElement);
    const mod = event.metaKey || event.ctrlKey;
    // Readline's next and previous line, where Ctrl is not the browser's own modifier.
    const readlineStep = key === 'n' ? 1 : key === 'p' ? -1 : 0;
    const readline = isMac() && event.ctrlKey && !event.metaKey && !event.altKey ? readlineStep : 0;

    const isFilterArrow =
      inFilters && (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowDown' || key === 'ArrowUp');
    let handled = true;
    if (readline) setActive(wrapIndex(active, readline, rows.length));
    else if (isFilterArrow && !mod) moveFilter(key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1);
    else if ((key === 'ArrowDown' || key === 'ArrowUp') && event.metaKey) setActive(key === 'ArrowDown' ? Infinity : 0);
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      setActive(wrapIndex(active, key === 'ArrowDown' ? 1 : -1, rows.length));
    } else if (key === 'PageDown' || key === 'PageUp') setActive(active + (key === 'PageDown' ? 1 : -1) * pageSize());
    else if ((key === 'Home' || key === 'End') && event.ctrlKey) setActive(key === 'End' ? Infinity : 0);
    else if (key === 'Enter' && event.target === input && !mod) {
      if (!failure.hidden) runSearch(0);
      else if (pending) openWhenAnswered = true;
      else activate(active);
    } else handled = false;

    if (handled) {
      event.preventDefault();
      // Moving through the results from the filters hands the keyboard back to the query.
      if (inFilters && !isFilterArrow) input.focus();
    } else if (inFilters && key.length === 1 && !mod && !event.altKey && key !== ' ') {
      // Typing goes to the query, wherever the focus is.
      input.focus();
    }
  };

  const onListClick = (event: MouseEvent) => {
    // The primary and middle buttons open a link; the secondary one only asks about it.
    if (event.button > 1) return;
    const option = (event.target as Element).closest<HTMLAnchorElement>('.cf-search-hit');
    if (option) remember(Array.prototype.indexOf.call(options(), option));
  };

  const onListPointerMove = (event: PointerEvent) => {
    // Rows that scroll under a resting pointer must not steal the keyboard's selection.
    if (event.clientX === pointer.x && event.clientY === pointer.y) return;
    pointer = { x: event.clientX, y: event.clientY };
    const option = (event.target as Element).closest<HTMLAnchorElement>('.cf-search-hit');
    if (!option) return;
    const index = Array.prototype.indexOf.call(options(), option);
    if (index !== active) setActive(index, false);
  };

  const onDialogPointerDown = (event: PointerEvent) => {
    pressedBackdrop = event.target === dialog;
  };

  const onDialogClick = (event: MouseEvent) => {
    const target = event.target as Element;
    // A press that began inside, such as a text selection dragged out, is not a dismissal.
    if (target === dialog) {
      if (pressedBackdrop) close();
      return;
    }
    if (target.closest('[data-cf-search-close]')) {
      close();
      return;
    }
    const filterButton = target.closest<HTMLButtonElement>('[data-cf-search-filter]');
    if (filterButton) {
      const kind = filterButton.dataset['cfSearchFilter'] as SearchFilterKind;
      if (kind !== filter) setFilter(kind);
      // A pointer keeps the query in hand; a key press leaves focus on the filters.
      if (event.detail > 0) input.focus();
    } else if (target.closest('[data-cf-search-widen]')) {
      setFilter('all');
      input.focus();
    } else if (target.closest('[data-cf-search-retry]')) {
      runSearch(0);
      input.focus();
    } else if (target.closest('[data-cf-search-clear-recent]')) {
      writeStorage(() => localStorage, RECENT_KEY, undefined);
      showIdle();
      input.focus();
    }
  };

  const trigger = find('[data-cf-search-open]');
  const unbindShortcut = onShortcut(shortcuts.search, (event) => {
    event.preventDefault();
    if (dialog.open) close();
    else open();
  });

  // Leaving for a result closes the dialog, so Back returns to the page, not to it.
  const onPageHide = () => {
    if (!dialog.open) return;
    // The dialog's `close` event would come too late to save the query.
    saveSession();
    close();
  };

  const session = readSession();
  if (session) {
    input.value = session.query;
    setFilter(session.filter, false);
    if (session.result) cache.set(session.query, kindOf(session.filter), session.result);
  }

  input.addEventListener('input', onInput);
  input.addEventListener('compositionend', onInput);
  list.addEventListener('click', onListClick);
  list.addEventListener('auxclick', onListClick);
  list.addEventListener('pointermove', onListPointerMove);
  dialog.addEventListener('keydown', onKeydown);
  dialog.addEventListener('pointerdown', onDialogPointerDown);
  dialog.addEventListener('click', onDialogClick);
  dialog.addEventListener('close', onClosed);
  trigger?.addEventListener('click', open);
  trigger?.addEventListener('pointerenter', warm);
  trigger?.addEventListener('focus', warm);
  window.addEventListener('pagehide', onPageHide);
  syncShortcutHints(root);

  return () => {
    unbindShortcut();
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionend', onInput);
    list.removeEventListener('click', onListClick);
    list.removeEventListener('auxclick', onListClick);
    list.removeEventListener('pointermove', onListPointerMove);
    dialog.removeEventListener('keydown', onKeydown);
    dialog.removeEventListener('pointerdown', onDialogPointerDown);
    dialog.removeEventListener('click', onDialogClick);
    dialog.removeEventListener('close', onClosed);
    trigger?.removeEventListener('click', open);
    trigger?.removeEventListener('pointerenter', warm);
    trigger?.removeEventListener('focus', warm);
    window.removeEventListener('pagehide', onPageHide);
    close();
    onClosed();
  };
}

mount('[data-cf-search]', initSearch);
