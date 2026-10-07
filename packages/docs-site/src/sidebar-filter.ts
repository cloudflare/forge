/** Debounce for queries narrow enough to filter cheaply. */
export const FILTER_DEBOUNCE_MS = 100;
/** Longer debounce for one-character queries, which match most of the tree. */
export const BROAD_FILTER_DEBOUNCE_MS = 250;

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
