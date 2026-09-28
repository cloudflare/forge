import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'astro/zod';
import type { JsonValueSchema } from './content/schema.ts';
import {
  createOperationExtensionDataAccessor,
  defineFernExtension,
  getOperationExtensionData,
  prepareFernExtensions,
} from './extensions.ts';
import { defineFernManifest } from './manifest.ts';
import { defineFernProject } from './project.ts';
import { widgetsProduct, widgetsSpec } from './test-fixture.ts';

test('prepare state is shared by manifest discovery and operation generation', () => {
  let prepareCalls = 0;
  let operationCalls = 0;
  const extension = defineFernExtension<JsonValueSchema, { marker: string }>({
    name: 'stateful',
    schema: z.json(),
    prepare() {
      prepareCalls++;
      return { marker: 'prepared' };
    },
    operation(_context, state) {
      operationCalls++;
      return { data: { marker: state.marker } };
    },
  });
  const project = defineFernProject({
    source: widgetsSpec,
    extensions: [extension],
    manifest: (_source, { discoverProducts }) => defineFernManifest({ products: discoverProducts() }),
  }).getData();

  assert.equal(prepareCalls, 1);
  assert.equal(operationCalls, 2, 'discovery and generation use the same prepared state');
  assert.deepEqual(project.operations[0]?.operation.extensions, { stateful: { marker: 'prepared' } });
});

test('generic accessors query multiple isolated extension namespaces', () => {
  const first = defineFernExtension<JsonValueSchema>({ name: 'first', schema: z.json() });
  const second = defineFernExtension({
    name: 'second',
    schema: z.object({ enabled: z.boolean() }),
  });
  const operation = { extensions: { first: 'value', second: { enabled: true } } };

  assert.equal(getOperationExtensionData(operation, first.name, first.schema), 'value');
  assert.deepEqual(getOperationExtensionData(operation, second.name, second.schema), { enabled: true });
  assert.deepEqual(getOperationExtensionData(operation, 'second'), { enabled: true });
  assert.equal(createOperationExtensionDataAccessor(second.name, second.schema)(operation)?.enabled, true);
});

test('extension names must be non-empty and unique', () => {
  const extension = defineFernExtension<JsonValueSchema>({ name: 'duplicate', schema: z.json() });
  assert.throws(() => prepareFernExtensions([extension, extension], widgetsSpec), /duplicate extension name/);
  const unnamed = defineFernExtension<JsonValueSchema>({ name: '', schema: z.json() });
  assert.throws(() => prepareFernExtensions([unnamed], widgetsSpec), /must start with a lowercase letter/);
});

test('operations always expose an extensions record when no extensions are configured', () => {
  const operation = defineFernProject({
    source: widgetsSpec,
    manifest: defineFernManifest({ products: [widgetsProduct] }),
  }).getData().operations[0]?.operation;
  assert.deepEqual(operation?.extensions, {});
});
