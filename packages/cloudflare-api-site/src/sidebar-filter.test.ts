import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSidebarFilter, normalizeSidebarFilterText, type SidebarFilterEntry } from './sidebar-filter.ts';

const entries: SidebarFilterEntry[] = [
  { searchText: 'reference', parentIndex: null, descendantEndIndex: 5, isGroup: true },
  { searchText: 'overview', parentIndex: 0, descendantEndIndex: 2, isGroup: false },
  { searchText: 'dns records', parentIndex: 0, descendantEndIndex: 5, isGroup: true },
  { searchText: 'overview', parentIndex: 2, descendantEndIndex: 4, isGroup: false },
  { searchText: 'list records', parentIndex: 2, descendantEndIndex: 5, isGroup: false },
];

test('sidebar filter normalizes case and whitespace', () => {
  assert.equal(normalizeSidebarFilterText('  DNS   Records\n'), 'dns records');
  assert.deepEqual(computeSidebarFilter(entries, ' LIST   RECORDS '), {
    visible: [true, false, true, false, true],
    expanded: [true, false, true, false, false],
  });
});

test('sidebar filter reveals a matching group subtree and its ancestors', () => {
  assert.deepEqual(computeSidebarFilter(entries, 'dns records'), {
    visible: [true, false, true, true, true],
    expanded: [true, false, true, false, false],
  });
});

test('sidebar filter does not expand nested groups solely because an ancestor matches', () => {
  assert.deepEqual(computeSidebarFilter(entries, 'reference'), {
    visible: [true, true, true, true, true],
    expanded: [true, false, false, false, false],
  });
});

test('sidebar filter combines multiple matching branches', () => {
  assert.deepEqual(computeSidebarFilter(entries, 'overview'), {
    visible: [true, true, true, true, false],
    expanded: [true, false, true, false, false],
  });
});

test('sidebar filter matches a query across nested group labels', () => {
  const commandEntries: SidebarFilterEntry[] = [
    { searchText: 'd1', parentIndex: null, descendantEndIndex: 5, isGroup: true },
    { searchText: 'info', parentIndex: 0, descendantEndIndex: 2, isGroup: false },
    { searchText: 'developer tooling', parentIndex: 0, descendantEndIndex: 5, isGroup: true },
    { searchText: 'migrations', parentIndex: 2, descendantEndIndex: 5, isGroup: true },
    { searchText: 'apply', parentIndex: 3, descendantEndIndex: 5, isGroup: false },
  ];

  assert.deepEqual(computeSidebarFilter(commandEntries, 'd1 m'), {
    visible: [true, false, true, true, true],
    expanded: [true, false, true, true, false],
  });
});

test('sidebar filter hides every entry when nothing matches', () => {
  assert.deepEqual(computeSidebarFilter(entries, 'missing'), {
    visible: [false, false, false, false, false],
    expanded: [false, false, false, false, false],
  });
});

test('sidebar filter restores full visibility for an empty query', () => {
  assert.deepEqual(computeSidebarFilter(entries, '   '), {
    visible: [true, true, true, true, true],
    expanded: [false, false, false, false, false],
  });
});
