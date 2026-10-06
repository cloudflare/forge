import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ForgeOpenApiDocument } from './init-from-openapi.ts';
import { createOpenApiLoaders, type OpenApiLoader, type OpenApiSourceDocument } from './openapi-source.ts';

function document(title: string): ForgeOpenApiDocument {
  return { openapi: '3.0.3', info: { title, version: '1' }, paths: {} };
}

type FixtureSource = { format: 'fixture'; titles: string[] };
type OtherSource = { format: 'other'; location: string };

const fixtureLoader: OpenApiLoader<FixtureSource> = {
  format: 'fixture',
  load: async ({ titles }) =>
    titles.map((title): OpenApiSourceDocument => ({ name: title, document: document(title) })),
};

const otherLoader: OpenApiLoader<OtherSource> = {
  format: 'other',
  load: async ({ location }) => [{ name: location, document: document(location) }],
};

test('dispatches each source to the loader for its format', async () => {
  const loaders = createOpenApiLoaders(fixtureLoader, otherLoader);

  const fixtures = await loaders.load({ format: 'fixture', titles: ['a', 'b'] });
  const others = await loaders.load({ format: 'other', location: 'other:c' });

  assert.deepEqual(
    fixtures.map((entry) => entry.name),
    ['a', 'b'],
  );
  assert.deepEqual(
    others.map((entry) => entry.name),
    ['other:c'],
  );
});

test('accepts only the sources of registered loaders', async () => {
  const loaders = createOpenApiLoaders(fixtureLoader);
  // Not an object literal at the call, so only the source type, not excess-property checks, can reject it.
  const unregistered = { format: 'other', location: 'other:c' } as const;

  // @ts-expect-error `other` is not a registered format, so its source does not type-check.
  await assert.rejects(loaders.load(unregistered), /No OpenAPI loader reads format "other"[\s\S]*- fixture/);
});

test('requires each loader to declare a single literal format', () => {
  const inferred: OpenApiLoader<{ format: string; location: string }> = {
    // @ts-expect-error A format typed as `string` would let any source type-check.
    format: 'inferred',
    load: async ({ location }) => [{ name: location, document: document(location) }],
  };
  const union: OpenApiLoader<{ format: 'yaml' | 'yml'; location: string }> = {
    // @ts-expect-error A union format would accept sources for formats the registry does not know.
    format: 'yaml',
    load: async ({ location }) => [{ name: location, document: document(location) }],
  };

  assert.deepEqual([inferred.format, union.format], ['inferred', 'yaml']);
});

test('requires at least one loader', () => {
  // @ts-expect-error A registry without loaders accepts no sources.
  assert.throws(() => createOpenApiLoaders(), /At least one OpenAPI loader is required/);
});

test('rejects two loaders for the same format', () => {
  assert.throws(
    () => createOpenApiLoaders(fixtureLoader, otherLoader, fixtureLoader),
    /registered more than once:\n- fixture/,
  );
});

test('loadOne returns the only document', async () => {
  const loaders = createOpenApiLoaders(fixtureLoader);

  const loaded = await loaders.loadOne({ format: 'fixture', titles: ['only'] });

  assert.equal(loaded.info.title, 'only');
});

test('loadOne names every document when a source defines several', async () => {
  const loaders = createOpenApiLoaders(fixtureLoader);

  await assert.rejects(
    loaders.loadOne({ format: 'fixture', titles: ['first', 'second'] }),
    /defines 2 documents; narrow it to one of:\n- first\n- second/,
  );
});

test('loadOne rejects a source with no documents', async () => {
  const loaders = createOpenApiLoaders(fixtureLoader);

  await assert.rejects(loaders.loadOne({ format: 'fixture', titles: [] }), /defines no documents/);
});
