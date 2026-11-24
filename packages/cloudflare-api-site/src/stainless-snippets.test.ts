import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { snippetsByOperation, stainlessSnippetsFileSchema, type StainlessSnippetsFile } from './stainless-snippets.ts';

const file = (snippets: StainlessSnippetsFile['snippets']): StainlessSnippetsFile => ({
  format: 1,
  source: { apiSchemasSha: 'a'.repeat(40), generatedAt: '2026-11-20T00:00:00.000Z' },
  snippets,
});

test('an operation takes the snippets of the old method page mapped to it; pages the snapshot lacks are dropped', () => {
  const { byOperation, shared } = snippetsByOperation(
    { methods: { '/resources/zones/methods/list/': 'zones-get' } },
    file({
      '/resources/zones/methods/list/': { typescript: 'ts', python: 'py' },
      '/resources/gone/methods/list/': { go: 'go' },
    }),
  );
  assert.deepEqual([...byOperation], [['zones-get', { typescript: 'ts', python: 'py' }]]);
  assert.deepEqual(shared, []);
});

test('when several old pages map to one operation, the first by path wins and the operation is reported', () => {
  const { byOperation, shared } = snippetsByOperation(
    {
      methods: {
        '/resources/zones/subresources/b/methods/get/': 'get',
        '/resources/accounts/subresources/b/methods/get/': 'get',
      },
    },
    file({
      '/resources/zones/subresources/b/methods/get/': { go: 'zone' },
      '/resources/accounts/subresources/b/methods/get/': { go: 'account' },
    }),
  );
  assert.deepEqual(byOperation.get('get'), { go: 'account' });
  assert.deepEqual(shared, ['get']);
});

test('the committed snippets file matches the schema and only keys old method pages', () => {
  const committed = stainlessSnippetsFileSchema.parse(
    JSON.parse(readFileSync(new URL('./stainless-snippets.json', import.meta.url), 'utf8')),
  );
  const snapshot = JSON.parse(readFileSync(new URL('./stainless-redirects.json', import.meta.url), 'utf8')) as {
    methods: Record<string, string>;
  };
  const strays = Object.keys(committed.snippets).filter((page) => !(page in snapshot.methods));
  assert.deepEqual(strays, []);
});
