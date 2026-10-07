import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRuntimeConfig } from './runtime-config.ts';

test('the catalog collection defaults to apiReference', () => {
  assert.equal(resolveRuntimeConfig({}).collection, 'apiReference');
});

test('the catalog collection name is configurable', () => {
  assert.equal(resolveRuntimeConfig({ collection: '_fernCatalog' }).collection, '_fernCatalog');
});

test('blank or padded catalog collection names are rejected', () => {
  for (const collection of ['', '  ', ' apiReference']) {
    assert.throws(() => resolveRuntimeConfig({ collection }), /collection must be a non-empty name/);
  }
});
