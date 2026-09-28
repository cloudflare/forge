const FILTER_DEBOUNCE_MS = 100;
const BROAD_FILTER_DEBOUNCE_MS = 250;
const SIDEBAR_STATE_KEY = 'sl-sidebar-state';

export interface SidebarFilterEntry {
  searchText: string;
  parentIndex: number | null;
  descendantEndIndex: number;
  isGroup: boolean;
}

export interface SidebarFilterResult {
  visible: boolean[];
  expanded: boolean[];
}

export function normalizeSidebarFilterText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function computeSidebarFilter(entries: readonly SidebarFilterEntry[], rawQuery: string): SidebarFilterResult {
  const query = normalizeSidebarFilterText(rawQuery);
  const visible = Array.from({ length: entries.length }, () => query.length === 0);
  const expanded = Array.from({ length: entries.length }, () => false);
  if (!query) return { visible, expanded };
  const terms = query.split(' ');

  entries.forEach((entry, index) => {
    const searchPath = [entry.searchText];
    let searchParentIndex = entry.parentIndex;
    while (searchParentIndex !== null) {
      const parent = entries[searchParentIndex];
      if (!parent) break;
      searchPath.unshift(parent.searchText);
      searchParentIndex = parent.parentIndex;
    }
    const searchText = searchPath.join(' ');
    const localLabelIndex = searchText.length - entry.searchText.length;
    let searchIndex = 0;
    const matches = terms.every((term, termIndex) => {
      const isLastTerm = termIndex === terms.length - 1;
      const termIndexInPath = searchText.indexOf(
        term,
        isLastTerm ? Math.max(searchIndex, localLabelIndex) : searchIndex,
      );
      if (termIndexInPath < 0) return false;
      searchIndex = termIndexInPath + term.length;
      return true;
    });
    if (!matches) return;

    const endIndex = entry.isGroup ? entry.descendantEndIndex : index + 1;
    for (let matchIndex = index; matchIndex < endIndex; matchIndex++) {
      visible[matchIndex] = true;
    }
    if (entry.isGroup) expanded[index] = true;

    let parentIndex = entry.parentIndex;
    while (parentIndex !== null) {
      const parent = entries[parentIndex];
      if (!parent) break;
      visible[parentIndex] = true;
      expanded[parentIndex] = true;
      parentIndex = parent.parentIndex;
    }
  });

  return { visible, expanded };
}

export function computeSidebarScrollAdjustment(
  visibleTop: number,
  visibleBottom: number,
  itemTop: number,
  itemBottom: number,
): number {
  if (visibleBottom <= visibleTop || itemBottom <= itemTop) return 0;
  if (itemTop >= visibleTop && itemBottom <= visibleBottom) return 0;
  return (itemTop + itemBottom - visibleTop - visibleBottom) / 2;
}

export function hasMatchingSidebarScrollState(rawState: string | null, expectedHash: string): boolean {
  if (!rawState) return false;
  try {
    const state: unknown = JSON.parse(rawState);
    if (!state || typeof state !== 'object') return false;
    const { hash, scroll } = state as { hash?: unknown; scroll?: unknown };
    return hash === expectedHash && typeof scroll === 'number' && Number.isFinite(scroll) && scroll >= 0;
  } catch {
    return false;
  }
}

interface IndexedSidebarFilterEntry extends SidebarFilterEntry {
  element: HTMLLIElement;
  details: HTMLDetailsElement | null;
}

function indexSidebar(root: HTMLElement): IndexedSidebarFilterEntry[] {
  const entries: IndexedSidebarFilterEntry[] = [];
  const topLevel = root.querySelector<HTMLUListElement>('ul.top-level');
  if (!topLevel) return entries;

  function visit(list: HTMLUListElement, parentIndex: number | null): void {
    for (const child of list.children) {
      if (!(child instanceof HTMLLIElement)) continue;

      const anchor = child.querySelector<HTMLAnchorElement>(':scope > a');
      const details = child.querySelector<HTMLDetailsElement>(':scope > details');
      if (!anchor && !details) continue;

      const label = details
        ? details.querySelector<HTMLElement>(':scope > summary .group-label')?.textContent
        : anchor?.textContent;
      const index = entries.length;
      const entry: IndexedSidebarFilterEntry = {
        element: child,
        details,
        searchText: normalizeSidebarFilterText(label ?? ''),
        parentIndex,
        descendantEndIndex: index + 1,
        isGroup: details !== null,
      };
      entries.push(entry);

      const sublist = details?.querySelector<HTMLUListElement>(':scope > ul');
      if (sublist) visit(sublist, index);
      entry.descendantEndIndex = entries.length;
    }
  }

  visit(topLevel, null);
  return entries;
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible';
}

function hasStoredSidebarScroll(root: HTMLElement): boolean {
  const stateRoot = root.querySelector<HTMLElement>('sl-sidebar-state-persist');
  if (!stateRoot) return false;
  try {
    return hasMatchingSidebarScrollState(sessionStorage.getItem(SIDEBAR_STATE_KEY), stateRoot.dataset.hash ?? '');
  } catch {
    return false;
  }
}

function registerSidebarFilter(): void {
  class ForgeSidebarFilter extends HTMLElement {
    #input: HTMLInputElement | null = null;
    #entries: IndexedSidebarFilterEntry[] = [];
    #openedByFilter = new Set<HTMLDetailsElement>();
    #mobileMenuObserver: MutationObserver | null = null;
    #desktopMediaQuery: MediaQueryList | null = null;
    #filterTimer = 0;
    #animationFrame = 0;
    #scrollFrame = 0;
    #scrollBeforeFilter: number | null = null;
    #connected = false;
    #filtering = false;
    #mobileMenuWasOpen = false;

    connectedCallback(): void {
      if (this.#connected) return;
      const input = this.querySelector<HTMLInputElement>('[data-sidebar-filter-input]');
      if (!input) return;

      this.#connected = true;
      this.#input = input;
      this.#entries = indexSidebar(this);
      this.#mobileMenuWasOpen = document.body.hasAttribute('data-mobile-menu-expanded');
      this.#desktopMediaQuery = window.matchMedia('(min-width: 50rem)');
      this.#mobileMenuObserver = new MutationObserver(this.#handleMobileMenuChange);
      this.#mobileMenuObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-mobile-menu-expanded'],
      });

      input.addEventListener('input', this.#handleInput);
      input.addEventListener('keydown', this.#handleInputKeydown);
      this.addEventListener('click', this.#handleSidebarClick);
      document.addEventListener('keydown', this.#handleDocumentKeydown);
      this.#desktopMediaQuery.addEventListener('change', this.#handleBreakpointChange);
      this.#positionCurrentPage();
    }

    disconnectedCallback(): void {
      if (!this.#connected) return;
      this.#input?.removeEventListener('input', this.#handleInput);
      this.#input?.removeEventListener('keydown', this.#handleInputKeydown);
      this.removeEventListener('click', this.#handleSidebarClick);
      document.removeEventListener('keydown', this.#handleDocumentKeydown);
      this.#desktopMediaQuery?.removeEventListener('change', this.#handleBreakpointChange);
      this.#mobileMenuObserver?.disconnect();
      window.clearTimeout(this.#filterTimer);
      window.cancelAnimationFrame(this.#animationFrame);
      window.cancelAnimationFrame(this.#scrollFrame);

      this.#input = null;
      this.#entries = [];
      this.#openedByFilter.clear();
      this.#mobileMenuObserver = null;
      this.#desktopMediaQuery = null;
      this.#filterTimer = 0;
      this.#animationFrame = 0;
      this.#scrollFrame = 0;
      this.#scrollBeforeFilter = null;
      this.#connected = false;
      this.#filtering = false;
    }

    #handleInput = (): void => {
      window.clearTimeout(this.#filterTimer);
      window.cancelAnimationFrame(this.#animationFrame);
      if (!this.#input) return;
      const query = normalizeSidebarFilterText(this.#input.value);
      if (!query) {
        this.#resetFilter();
        return;
      }

      const delay = query.length === 1 ? BROAD_FILTER_DEBOUNCE_MS : FILTER_DEBOUNCE_MS;
      this.#filterTimer = window.setTimeout(() => {
        this.#filterTimer = 0;
        this.#animationFrame = window.requestAnimationFrame(() => {
          this.#animationFrame = 0;
          this.#applyFilter();
        });
      }, delay);
    };

    #handleInputKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      this.#clearFilter(this.#desktopMediaQuery?.matches !== false);
    };

    #handleDocumentKeydown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) {
        return;
      }
      if (!this.#input || !isVisible(this.#input)) return;

      event.preventDefault();
      event.stopPropagation();
      this.#input.focus();
    };

    #handleSidebarClick = (event: MouseEvent): void => {
      if (!this.#filtering || !(event.target instanceof Element)) return;
      const details = event.target.closest('summary')?.parentElement;
      if (details instanceof HTMLDetailsElement) this.#openedByFilter.delete(details);
    };

    #handleMobileMenuChange = (): void => {
      const mobileMenuIsOpen = document.body.hasAttribute('data-mobile-menu-expanded');
      if (!this.#mobileMenuWasOpen && mobileMenuIsOpen) {
        this.#positionCurrentPage(true);
      } else if (this.#mobileMenuWasOpen && !mobileMenuIsOpen) {
        this.#clearFilter(true);
      }
      this.#mobileMenuWasOpen = mobileMenuIsOpen;
    };

    #handleBreakpointChange = (event: MediaQueryListEvent): void => {
      if (event.matches) {
        this.#positionCurrentPage(true);
      } else if (!document.body.hasAttribute('data-mobile-menu-expanded')) {
        this.#clearFilter(true);
      }
    };

    #positionCurrentPage(ignoreStoredState = false): void {
      const isDesktop = this.#desktopMediaQuery?.matches === true;
      if (!isDesktop && !document.body.hasAttribute('data-mobile-menu-expanded')) return;
      if (isDesktop && !ignoreStoredState && hasStoredSidebarScroll(this)) return;
      const active = this.querySelector<HTMLElement>("[aria-current='page']");
      const scroller = this.closest('#starlight__sidebar');
      if (!active || !(scroller instanceof HTMLElement)) return;

      let ancestor = active.closest('details');
      while (ancestor && this.contains(ancestor)) {
        ancestor.open = true;
        ancestor = ancestor.parentElement?.closest('details') ?? null;
      }

      window.cancelAnimationFrame(this.#scrollFrame);
      this.#scrollFrame = window.requestAnimationFrame(() => {
        this.#scrollFrame = 0;
        if (!isDesktop && !document.body.hasAttribute('data-mobile-menu-expanded')) return;
        const scrollerRect = scroller.getBoundingClientRect();
        const filterRect = this.#input?.parentElement?.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const visibleTop = Math.max(scrollerRect.top, filterRect?.bottom ?? scrollerRect.top);
        const adjustment = computeSidebarScrollAdjustment(
          visibleTop,
          scrollerRect.bottom,
          activeRect.top,
          activeRect.bottom,
        );
        if (adjustment) scroller.scrollTop += adjustment;
      });
    }

    #applyFilter(): void {
      if (!this.#input) return;
      const query = normalizeSidebarFilterText(this.#input.value);
      if (!query) {
        this.#resetFilter();
        return;
      }

      if (!this.#filtering) {
        const scroller = this.closest('#starlight__sidebar');
        if (scroller instanceof HTMLElement) this.#scrollBeforeFilter = scroller.scrollTop;
      }
      this.#filtering = true;
      const result = computeSidebarFilter(this.#entries, query);
      this.#entries.forEach((entry, index) => {
        if (entry.details && this.#openedByFilter.has(entry.details) && !result.expanded[index]) {
          entry.details.open = false;
          this.#openedByFilter.delete(entry.details);
        }
      });
      this.#entries.forEach((entry, index) => {
        const hidden = !result.visible[index];
        if (entry.element.hidden !== hidden) entry.element.hidden = hidden;

        if (result.expanded[index] && entry.details && !entry.details.open) {
          this.#openedByFilter.add(entry.details);
          entry.details.open = true;
        }
      });
    }

    #clearFilter(blur = false): void {
      if (this.#input) this.#input.value = '';
      this.#resetFilter();
      if (blur) this.#input?.blur();
    }

    #resetFilter(): void {
      window.clearTimeout(this.#filterTimer);
      window.cancelAnimationFrame(this.#animationFrame);
      this.#filterTimer = 0;
      this.#animationFrame = 0;
      this.#entries.forEach((entry) => {
        if (entry.element.hidden) entry.element.hidden = false;
      });
      this.#openedByFilter.forEach((details) => {
        if (details.open) details.open = false;
      });
      this.#openedByFilter.clear();
      if (this.#scrollBeforeFilter !== null) {
        const scroller = this.closest('#starlight__sidebar');
        if (scroller instanceof HTMLElement) scroller.scrollTop = this.#scrollBeforeFilter;
      }
      this.#scrollBeforeFilter = null;
      this.#filtering = false;
    }
  }

  if (!customElements.get('forge-sidebar-filter')) {
    customElements.define('forge-sidebar-filter', ForgeSidebarFilter);
  }
}

if (typeof window !== 'undefined') registerSidebarFilter();
