import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFernContent,
  defineFernExtension,
  defineFernManifest,
  type FernContentProjectData,
  type FernManifestProvider,
  type FernSourceOperation,
} from 'astro-fern';
import { forgeExtension, hasRemovedForgeOperationFields } from 'fern-forge';
import {
  CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
  CLOUDFLARE_TARGETS,
  cloudflareFormatIdentifier,
  cloudflareOperationRoutingPreference,
  cloudflareSnippets,
} from './cloudflare.ts';
import { prepareForgeApi, TERRAFORM_EXTENSION } from './forge-api.ts';
import { TERRAFORM_EXTENSION_NAME, terraformOperationDataSchema } from './terraform.ts';

const SNAPSHOT = '2026-11-30.air';

function operation(id: string, group: string[], method: string, extra: Record<string, unknown> = {}) {
  return {
    operationId: id,
    summary: id,
    tags: [group[0]!],
    'x-fern-sdk-group-name': group,
    'x-fern-sdk-method-name': method,
    responses: {
      '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
      '4XX': {
        description: 'error',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { success: { type: 'boolean', enum: [false] } },
              required: ['success'],
            },
          },
        },
      },
    },
    ...extra,
  };
}

const spec: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'Fixture', description: 'Fixture API.' },
  components: {
    responses: {
      NotFound: {
        description: 'missing',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { code: { type: 'integer' } }, required: ['code'] },
          },
        },
      },
    },
  },
  paths: {
    '/alpha/items': {
      get: operation('alpha.items.list', ['alpha', 'items'], 'list'),
      post: operation('alpha.items.create', ['alpha', 'items'], 'create', {
        deprecated: false,
        'x-fern-availability': 'deprecated',
      }),
    },
    '/alpha/items/{id}': {
      get: operation('alpha.items.get', ['alpha', 'items'], 'get', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, secret: { type: 'string', writeOnly: true } },
                  required: ['id', 'secret'],
                },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
        'x-forge-aliases': [
          { 'x-fern-sdk-group-name': ['legacy', 'items'], 'x-fern-sdk-method-name': 'get' },
          { 'x-fern-sdk-group-name': ['alpha', 'legacy-items'], 'x-fern-sdk-method-name': 'get' },
        ],
      }),
      delete: operation('alpha.items.delete', ['alpha', 'items'], 'delete', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        'x-forge-require-confirmation': 'This deletes the item.',
      }),
    },
    '/alpha/items/{id}/notes': {
      get: operation('alpha.items.notes.list', ['alpha', 'items', 'notes'], 'list', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    '/alpha/settings': {
      get: operation('alpha.settings.get', ['alpha', 'settings'], 'get', {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' }, example: { ok: true } } },
          },
        },
      }),
      put: operation('alpha.settings.update', ['alpha', 'settings'], 'update'),
      patch: operation('alpha.settings.edit', ['alpha', 'settings'], 'update'),
    },
    '/alpha/retired': {
      get: operation('alpha.retired.list', ['alpha', 'retired'], 'list', { 'x-forge-sunset': '2026-01-01' }),
    },
    '/alpha/anonymous': { get: { summary: 'No id', tags: ['alpha'], responses: { '200': { description: 'ok' } } } },
    '/alpha/misc': {
      get: {
        operationId: 'alpha.misc',
        summary: 'Unplaced',
        tags: ['alpha'],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/beta/items': {
      get: operation('beta.items.list', ['beta', 'items'], 'list'),
      post: operation('beta.items.create', ['beta', 'items'], 'create'),
    },
    '/beta/items/{id}': {
      get: operation('beta.items.get', ['beta', 'items'], 'get', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    '/beta/items/export': { get: operation('beta.items.export', ['beta', 'items'], 'export') },
    '/beta/zones': {
      get: operation('beta.zones.list', ['beta', 'zones'], 'list'),
      post: operation('beta.zones.create', ['beta', 'zones'], 'create'),
    },
    '/beta/zones/{id}': {
      get: operation('beta.zones.get', ['beta', 'zones'], 'get', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      put: operation('beta.zones.update', ['beta', 'zones'], 'update', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    '/tags/keys': { get: operation('tags.keys.list', ['tags', 'keys'], 'list') },
    '/tags/values': { get: operation('tags.values.list', ['tags', 'values'], 'list') },
  },
};

const terraform = defineFernExtension({
  name: TERRAFORM_EXTENSION_NAME,
  schema: terraformOperationDataSchema,
  prepare: () => undefined,
  operation: ({ path, method }) =>
    path === '/beta/zones' && method === 'post'
      ? {
          data: {
            declarations: [
              {
                kind: 'resource',
                name: 'cloudflare_zone',
                example: 'resource "cloudflare_zone" "x" {}',
                roles: ['create'],
                required: [],
                optional: [],
                computed: [],
              },
              {
                kind: 'data-source',
                name: 'cloudflare_zone',
                roles: ['read'],
                required: [],
                optional: [],
                computed: [],
              },
            ],
          },
        }
      : undefined,
});

const manifest: FernManifestProvider = (_openapi, { discoverProducts }) =>
  defineFernManifest({ targets: CLOUDFLARE_TARGETS, products: discoverProducts() });

function prepare() {
  const data = buildFernContent({
    source: { kind: 'snapshots', snapshots: [{ id: SNAPSHOT, source: spec as never, default: true }] },
    manifest,
    responsePayloadKey: CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
    formatIdentifier: cloudflareFormatIdentifier,
    operationRoutingPreference: cloudflareOperationRoutingPreference,
    isOperationHidden: hasRemovedForgeOperationFields,
    snippets: cloudflareSnippets,
    extensions: [forgeExtension(), terraform],
    onWarning: () => {},
  });
  return { ...prepareForgeApi(spec, data, SNAPSHOT), data };
}

const ops = (doc: Record<string, unknown>) =>
  Object.entries(doc.paths as Record<string, Record<string, { operationId?: string }>>).flatMap(([, item]) =>
    Object.values(item).map((op) => op.operationId),
  );

/** A hand-built astro-fern entry for the cases `buildFernContent` never produces. */
function entry(
  id: string,
  product: string,
  slug: string,
  operation: Record<string, unknown> = {},
  resourcePath: { id: string; slug: string }[] = [],
): FernSourceOperation {
  return {
    id: `${product}:${id}`,
    snapshotId: SNAPSHOT,
    product: { id: product, slug: product, title: product, description: '' },
    section: { id: product, tag: product, title: product },
    operation: {
      operationId: id,
      slug,
      placement: {
        projectionId: 'primary',
        method: 'list',
        resourcePath: resourcePath.map((s) => ({ ...s, title: s.slug })),
      },
      ...operation,
    } as never,
    snippets: [],
  };
}

function prepareEntries(...entries: FernSourceOperation[]) {
  const products = [...new Set(entries.map((e) => e.product.id))].map((id) => ({
    id,
    slug: id,
    title: id,
    description: '',
    snapshots: [],
  }));
  const data = { catalog: { products }, operations: entries } as unknown as FernContentProjectData;
  return prepareForgeApi({ paths: {} }, data, SNAPSHOT);
}

test('keeps exactly the operations astro-fern gives a primary page, keyed by operationId', () => {
  const { document, operations, data } = prepare();
  const kept = ops(document).sort();
  assert.deepEqual(kept, Object.keys(operations).sort());
  assert.deepEqual(
    kept,
    data.operations
      .filter((entry) => (entry.operation.placement?.projectionId ?? 'primary') === 'primary')
      .map((entry) => entry.operation.operationId)
      .sort(),
  );
  assert.ok(!kept.includes('alpha.retired.list'), 'hidden operation');
  assert.equal((document.paths as Record<string, unknown>)['/alpha/retired'], undefined);
  assert.equal((document.paths as Record<string, unknown>)['/alpha/anonymous'], undefined, 'operation without an id');
  assert.equal((document.paths as Record<string, unknown>)['/alpha/misc'], undefined, 'operation without an SDK group');
  assert.ok(kept.includes('alpha.settings.get'));
  assert.ok(
    !kept.includes('alpha.settings.update') && !kept.includes('alpha.settings.edit'),
    'astro-fern drops both of a colliding pair the routing preference cannot split',
  );
});

test("routes are today's URLs, with moved product slugs", () => {
  const { operations, redirects } = prepare();
  assert.equal(operations['alpha.items.notes.list'], 'alpha/items/notes/methods/list');
  assert.equal(operations['beta.zones.update'], 'beta/zones/methods/update');
  assert.equal(operations['tags.keys.list'], 'tagging/keys/methods/list');
  assert.equal(redirects['/tags/keys/methods/list/'], '/tagging/keys/methods/list/');
});

test('alias projections redirect to the primary page, in and outside its product', () => {
  const { operations, redirects, document } = prepare();
  assert.equal(operations['alpha.items.get'], 'alpha/items/methods/get');
  assert.equal(operations['legacy.items.get'], undefined);
  assert.equal(redirects['/legacy/items/methods/get/'], '/alpha/items/methods/get/');
  assert.equal(redirects['/alpha/legacy-items/methods/get/'], '/alpha/items/methods/get/');
  assert.equal(redirects['/alpha/legacy-items/'], '/alpha/items/');
  assert.ok(!(document.tags as { name: string }[]).some((tag) => tag.name === 'alpha-legacy-items'));
});

test('tags nest product → resource and resources with one name stay apart by product', () => {
  const { document } = prepare();
  const tags = document.tags as { name: string; parent?: string; 'x-displayName': string }[];
  const byName = new Map(tags.map((tag) => [tag.name, tag]));
  assert.equal(byName.get('alpha')?.parent, undefined);
  assert.equal(byName.get('alpha-items')?.parent, 'alpha');
  assert.equal(byName.get('alpha-items-notes')?.parent, 'alpha-items');
  assert.equal(byName.get('beta-items')?.parent, 'beta');
  assert.equal(byName.get('alpha-items')?.['x-displayName'], 'Items');
  const paths = document.paths as Record<string, Record<string, { tags: string[] }>>;
  assert.deepEqual(paths['/alpha/items/{id}/notes']!.get!.tags, ['alpha-items-notes']);
  assert.deepEqual(paths['/beta/items']!.get!.tags, ['beta-items']);
});

test("landing pages are Nimbus's section pages; section ids and moved products redirect", () => {
  const { redirects, tagSegments } = prepare();
  assert.equal(redirects['/alpha/'], undefined);
  assert.equal(redirects['/alpha/items/'], undefined);
  assert.equal(redirects['/alpha/items/notes/'], undefined);
  assert.equal(redirects['/tags/'], '/tagging/');
  assert.equal(redirects['/tags/keys/'], '/tagging/keys/');
  assert.deepEqual(tagSegments, { tags: 'tagging' });
  const unplaced = prepareEntries(entry('a.misc', 'a', 'misc/methods/list', { placement: undefined }));
  assert.equal(unplaced.redirects['/a/sections/a/'], '/a/');
  assert.equal(unplaced.operations['a.misc'], 'a/misc/methods/list');
});

test('an alias path that is also a real section keeps the real page', () => {
  const items = [{ id: 'items', slug: 'items' }];
  const alias = { projectionId: 'alias', method: 'list', resourcePath: items.map((s) => ({ ...s, title: s.slug })) };
  const { redirects } = prepareEntries(
    entry('a.items.list', 'a', 'items/methods/list', {}, items),
    entry('b.items.get', 'b', 'items/methods/get', {}, items),
    entry('a.items.list', 'b', 'items/methods/list', { placement: alias }),
  );
  assert.equal(redirects['/b/items/methods/list/'], '/a/items/methods/list/');
  assert.equal(redirects['/b/'], undefined);
  assert.equal(redirects['/b/items/'], undefined);
});

test('samples cover every target, with placeholders, HCL per declaration with an example, and an example per JSON response; Terraform data rides the extension', () => {
  const { document } = prepare();
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const create = paths['/beta/zones']!.post!;
  const samples = create['x-codeSamples'] as { lang: string; label: string; source: string }[];
  assert.deepEqual(
    samples.map((sample) => [sample.lang, sample.label]),
    [
      ['cf', 'cf CLI'],
      ['curl', 'curl'],
      ['hcl', 'resource cloudflare_zone'],
    ],
  );
  assert.match(samples[1]!.source, /curl .*\/beta\/zones/s);
  assert.equal(samples.at(-1)!.source, 'resource "cloudflare_zone" "x" {}');
  const extension = create[TERRAFORM_EXTENSION] as { declarations: unknown[] };
  assert.equal(extension.declarations.length, 2);
  const list = paths['/beta/zones']!.get!;
  const listSamples = list['x-codeSamples'] as { lang: string; source: string }[];
  assert.deepEqual(
    listSamples.map((sample) => sample.lang),
    ['cf', 'curl', 'hcl'],
  );
  assert.equal(listSamples.at(-1)!.source, '# A Terraform example is not available yet.');
  assert.equal(list[TERRAFORM_EXTENSION], undefined);
  type Responses = Record<string, { content?: Record<string, { example?: unknown }> }>;
  const example = (responses: Responses, code: string) => responses[code]!.content!['application/json']!.example;
  assert.deepEqual(example(list.responses as Responses, '200'), {});
  assert.deepEqual(example(list.responses as Responses, '4XX'), { success: false });
  assert.deepEqual(example(paths['/alpha/items/{id}']!.get!.responses as Responses, '200'), { id: 'string' });
  assert.deepEqual(example(paths['/alpha/settings']!.get!.responses as Responses, '200'), { ok: true });
  assert.deepEqual(example((document.components as { responses: Responses }).responses, 'NotFound'), { code: 0 });
});

test('lifecycle methods get x-nimbus-order; others get none', () => {
  const { document } = prepare();
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const order = (path: string, method: string) => paths[path]![method]!['x-nimbus-order'];
  assert.equal(order('/alpha/items', 'get'), 1);
  assert.equal(order('/alpha/items/{id}', 'get'), 2);
  assert.equal(order('/alpha/items', 'post'), 3);
  assert.equal(order('/beta/zones/{id}', 'put'), 4);
  assert.equal(order('/alpha/items/{id}', 'delete'), 6);
  assert.equal(order('/alpha/items/{id}/notes', 'get'), 1);
  assert.equal(order('/beta/items/export', 'get'), undefined);
});

test('availability deprecation becomes OAS deprecated; Forge notices stay', () => {
  const { document } = prepare();
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  assert.equal(paths['/alpha/items']!.post!.deprecated, true);
  assert.equal(paths['/alpha/items']!.post!['x-fern-availability'], 'deprecated');
  assert.equal(paths['/alpha/items/{id}']!.delete!['x-forge-require-confirmation'], 'This deletes the item.');
  assert.equal(paths['/alpha/items']!.get!.deprecated, undefined);
});

test('products list what the command pages need', () => {
  const { products } = prepare();
  assert.deepEqual(
    products.map((product) => product.slug),
    ['alpha', 'beta', 'tags'],
  );
  assert.equal(products[0]!.title, 'Alpha');
});

test('the source document is left untouched', () => {
  const before = JSON.stringify(spec);
  prepare();
  assert.equal(JSON.stringify(spec), before);
});

test('a product that exists only through aliases gets redirects, not pages', () => {
  const { document, products, redirects } = prepare();
  const tags = (document.tags as { name: string }[]).map((tag) => tag.name);
  assert.ok(!tags.includes('legacy'));
  assert.ok(!products.some((product) => product.slug === 'legacy'));
  assert.equal(redirects['/legacy/'], '/alpha/');
  assert.equal(redirects['/legacy/items/'], '/alpha/items/');
});

test('refuses data that would give two pages one URL or one tag two meanings', () => {
  const items = [{ id: 'items', slug: 'items' }];
  assert.throws(
    () => prepareEntries(entry('a.list', 'a', 'items/methods/list'), entry('a.list', 'a', 'items/methods/list')),
    /two primary placements/,
  );
  assert.throws(
    () =>
      prepareEntries(
        entry('a.list', 'a', 'items/methods/list', {}, items),
        entry('a.list-v2', 'a', 'items-v2/methods/list', {}, [{ id: 'items-v2', slug: 'items' }]),
      ),
    /produced by both/,
  );
  assert.throws(
    () => prepareEntries(entry('a.list', 'a', 'items/methods/list'), entry('a.index', 'a', 'items/methods/list')),
    /both route to/,
  );
  assert.throws(
    () =>
      prepareEntries(
        entry('a.get', 'a', 'items/methods/get', { placement: { projectionId: 'legacy', resourcePath: [] } }),
      ),
    /has no primary page/,
  );
  assert.throws(() => prepareEntries(entry('a.get', 'a', 'Items/methods/get')), /not lowercase kebab-case/);
});

test('the prepared spec is titled for the API home', () => {
  assert.equal((prepare().document.info as { title: string }).title, 'API Reference');
});
