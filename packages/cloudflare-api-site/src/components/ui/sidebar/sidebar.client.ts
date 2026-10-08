/** Sidebar runtime: filter, persistence, "/" shortcut. */

import { mount } from '@cloudflare/nimbus-docs/client';
import {
  BROAD_FILTER_DEBOUNCE_MS,
  computeSidebarFilter,
  FILTER_DEBOUNCE_MS,
  normalizeSidebarFilterText,
  type SidebarFilterEntry,
} from '@/sidebar-filter';

const STORAGE_KEY = 'sidebar-state';
const OPENED_BY_FILTER = 'data-nb-opened-by-filter';
const FILTERING = 'data-nb-filtering';

interface SidebarState {
  hash: string;
  open: boolean[];
  scroll: number;
}

function initSidebar(root: HTMLElement): () => void {
  const teardowns: Array<() => void> = [];
  const persist = root.hasAttribute('data-nb-sidebar-persist');

  const filterTeardown = initFilter(root);
  if (filterTeardown) teardowns.push(filterTeardown);

  if (persist) teardowns.push(initPersistence(root));

  return () => teardowns.forEach((t) => t());
}

// ---------------------------------------------------------------------------
// Filter
//
// Matching is shared with the unit-tested `computeSidebarFilter`: every query
// term must appear in order along an entry's ancestor path, so "workers
// scripts list" finds "List" under Workers > Scripts.
// ---------------------------------------------------------------------------

interface IndexedEntry extends SidebarFilterEntry {
  item: HTMLLIElement;
  group: HTMLDetailsElement | null;
}

function indexSidebar(root: HTMLElement): IndexedEntry[] {
  const entries: IndexedEntry[] = [];
  const topLevel = root.querySelector<HTMLUListElement>('ul.top-level');
  if (!topLevel) return entries;

  function visit(list: HTMLUListElement, parentIndex: number | null): void {
    for (const item of list.children) {
      if (!(item instanceof HTMLLIElement)) continue;
      const group = item.querySelector<HTMLDetailsElement>(':scope > details');
      const link = group ? null : item.querySelector<HTMLElement>(':scope > a');
      if (!group && !link) continue;

      const label = group ? group.querySelector(':scope > summary')?.textContent : link?.textContent;
      const index = entries.length;
      const entry: IndexedEntry = {
        item,
        group,
        searchText: normalizeSidebarFilterText(label ?? ''),
        parentIndex,
        descendantEndIndex: index + 1,
        isGroup: group !== null,
      };
      entries.push(entry);

      const sublist = group?.querySelector<HTMLUListElement>(':scope > ul');
      if (sublist) visit(sublist, index);
      entry.descendantEndIndex = entries.length;
    }
  }

  visit(topLevel, null);
  return entries;
}

function initFilter(root: HTMLElement): (() => void) | null {
  // SidebarFilter is rendered next to Sidebar, so look in the parent too.
  const inputElement =
    root.querySelector<HTMLInputElement>('[data-nb-sidebar-filter-input]') ??
    root.parentElement?.querySelector<HTMLInputElement>('[data-nb-sidebar-filter-input]') ??
    null;
  if (!inputElement) return null;
  const input = inputElement;

  let entries: IndexedEntry[] | null = null;
  let timer = 0;
  // Where the tree was scrolled before filtering, restored when the filter clears.
  let scrollBefore: number | null = null;

  function run() {
    timer = 0;
    const query = normalizeSidebarFilterText(input.value);
    const scroller = scrollContainer(root);
    if (!query) {
      resetFilter(root);
      if (scrollBefore !== null) scroller.scrollTop = scrollBefore;
      scrollBefore = null;
      return;
    }
    scrollBefore ??= scroller.scrollTop;
    entries ??= indexSidebar(root);
    applyFilter(entries, query);
    root.setAttribute(FILTERING, '');
  }

  function handleInput() {
    window.clearTimeout(timer);
    const query = normalizeSidebarFilterText(input.value);
    if (!query) {
      run();
      return;
    }
    timer = window.setTimeout(run, query.length === 1 ? BROAD_FILTER_DEBOUNCE_MS : FILTER_DEBOUNCE_MS);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // With a query, Escape only clears it; it must not also close the mobile drawer.
    if (input.value) e.preventDefault();
    input.value = '';
    handleInput();
    input.blur();
  }

  input.addEventListener('input', handleInput);
  input.addEventListener('keydown', handleKeydown);
  root.addEventListener('click', handleSummaryClick);

  return () => {
    window.clearTimeout(timer);
    input.removeEventListener('input', handleInput);
    input.removeEventListener('keydown', handleKeydown);
    root.removeEventListener('click', handleSummaryClick);
    resetFilter(root);
  };
}

// A group the reader toggles while filtering keeps the reader's choice.
function handleSummaryClick(e: Event): void {
  if (!(e.target instanceof Element)) return;
  const details = e.target.closest('summary')?.parentElement;
  if (details instanceof HTMLDetailsElement) details.removeAttribute(OPENED_BY_FILTER);
}

function setOpenByFilter(group: HTMLDetailsElement, open: boolean): void {
  if (group.open === open) return;
  group.open = open;
  group.toggleAttribute(OPENED_BY_FILTER, open);
}

/** The element that scrolls the tree: the desktop rail, or the mobile drawer panel while it borrows the tree. */
function scrollContainer(root: HTMLElement): HTMLElement {
  return root.closest<HTMLElement>('aside, [data-mobile-sidebar-panel]') ?? root;
}

function resetFilter(root: HTMLElement): void {
  root.removeAttribute(FILTERING);
  root.querySelectorAll<HTMLElement>('[data-nb-sidebar-hidden]').forEach((el) => {
    el.removeAttribute('data-nb-sidebar-hidden');
  });
  // Close groups the filter opened, restoring the reader's own state.
  root.querySelectorAll<HTMLDetailsElement>(`details[${OPENED_BY_FILTER}]`).forEach((group) => {
    setOpenByFilter(group, false);
  });
}

function applyFilter(entries: IndexedEntry[], query: string): void {
  const result = computeSidebarFilter(entries, query);
  entries.forEach((entry, index) => {
    entry.item.toggleAttribute('data-nb-sidebar-hidden', !result.visible[index]);
    const group = entry.group;
    if (!group) return;
    if (result.expanded[index]) {
      if (!group.open) setOpenByFilter(group, true);
    } else if (group.hasAttribute(OPENED_BY_FILTER)) {
      // Close groups an earlier, broader query opened but this one does not need.
      setOpenByFilter(group, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Persistence (open state + scroll)
// ---------------------------------------------------------------------------

function initPersistence(root: HTMLElement): () => void {
  // Scroll is saved for the desktop rail only; the drawer borrows the tree.
  const rail: HTMLElement = root.closest('aside') ?? root;
  const hash = root.dataset.nbSidebarHash ?? '';
  let lastRailScroll = rail.scrollTop;

  function readState(): SidebarState {
    const open: boolean[] = [];
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((group) => {
      // Groups opened only by the filter are not the reader's state.
      open.push(group.open && !group.hasAttribute(OPENED_BY_FILTER));
    });
    // Keep the last unfiltered rail position while the tree is in the drawer
    // (the rail is hidden) or narrowed by the filter.
    if (rail.contains(root) && !root.hasAttribute(FILTERING)) lastRailScroll = rail.scrollTop;
    return { hash, open, scroll: lastRailScroll };
  }

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(readState()));
    } catch {}
  }

  function handleVisibility() {
    if (document.visibilityState === 'hidden') save();
  }

  let raf = 0;
  function handleScroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(save);
  }

  // `toggle` does not bubble, so listen in the capture phase.
  root.addEventListener('toggle', save, true);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', save);
  rail.addEventListener('scroll', handleScroll);

  return () => {
    root.removeEventListener('toggle', save, true);
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('pagehide', save);
    rail.removeEventListener('scroll', handleScroll);
    cancelAnimationFrame(raf);
  };
}

// ---------------------------------------------------------------------------
// Global `/` shortcut — bound once at module load
// ---------------------------------------------------------------------------

(function bindFilterShortcut() {
  if (document.documentElement.hasAttribute('data-nb-sidebar-shortcut-bound')) return;
  document.documentElement.setAttribute('data-nb-sidebar-shortcut-bound', '');

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable)
    ) {
      return;
    }
    const input = [...document.querySelectorAll<HTMLInputElement>('[data-nb-sidebar-filter-input]')].find(
      (candidate) => candidate.getClientRects().length > 0,
    );
    if (!input) return;
    e.preventDefault();
    input.focus();
  });
})();

mount('[data-nb-sidebar]', initSidebar);
