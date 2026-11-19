import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareForgeApi, TERRAFORM_EXTENSION } from './forge-api.ts';
import { readContent } from './forge-content.ts';
import type { TerraformIndex } from './terraform-extension.ts';
import { canonicalTerraformEndpoint } from './terraform.ts';

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
      patch: operation('alpha.settings.edit', ['alpha', 'settings'], 'edit'),
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

const terraform: TerraformIndex = new Map([
  [
    canonicalTerraformEndpoint('post', '/beta/zones'),
    [
      {
        kind: 'resource',
        name: 'cloudflare_zone',
        example: 'resource "cloudflare_zone" "x" {}',
        importExample: "$ terraform import cloudflare_zone.x '<zone_id>'",
        roles: ['create'],
        required: [],
        optional: [],
        computed: [],
      },
      {
        kind: 'data-source',
        name: 'cloudflare_zone',
        example: 'data "cloudflare_zone" "x" {}',
        roles: ['read'],
        required: [],
        optional: [],
        computed: [],
      },
      {
        kind: 'resource',
        name: 'cloudflare_zone_setting',
        importExample:
          "# One setting at a time.\n$ terraform import cloudflare_zone_setting.x '<zone_id>/<setting_id>'",
        roles: ['update'],
        required: [],
        optional: [],
        computed: [],
      },
    ],
  ],
]);

function prepare(source: Record<string, unknown> = spec, sdkSnippets?: Map<string, Record<string, string>>) {
  return prepareForgeApi(source, terraform, sdkSnippets);
}

const ops = (doc: Record<string, unknown>) =>
  Object.entries(doc.paths as Record<string, Record<string, { operationId?: string }>>).flatMap(([, item]) =>
    Object.values(item).map((op) => op.operationId),
  );

test('an operation without an operationId gets its page, and the spec gets the id derived from its SDK address', () => {
  const source = structuredClone(spec);
  const { operationId: _operationId, ...apps } = operation('alpha.apps.list', ['alpha', 'apps'], 'list');
  (source.paths as Record<string, unknown>)['/{account_or_zone}/{account_or_zone_id}/alpha/apps'] = { get: apps };
  const { document, operations } = prepare(source);
  assert.equal(operations['alpha.apps.list'], 'alpha/apps/methods/list');
  const paths = document.paths as Record<string, Record<string, { operationId?: string }>>;
  assert.equal(paths['/{account_or_zone}/{account_or_zone_id}/alpha/apps']?.get?.operationId, 'alpha.apps.list');
});

test('a derived id in a product Nimbus keeps is renamed as the product slug is; a written one stays', () => {
  const source = structuredClone(spec);
  const { operationId: _operationId, ...resources } = operation('tags.resources.list', ['tags', 'resources'], 'list');
  (source.paths as Record<string, unknown>)['/{account_or_zone}/{account_or_zone_id}/tags'] = { get: resources };
  const { document, operations } = prepare(source);
  assert.equal(operations['tagging.resources.list'], 'tagging/resources/methods/list');
  assert.equal(operations['tags.resources.list'], undefined);
  // The spec's own id is the author's, so Nimbus reports it instead.
  assert.equal(operations['tags.keys.list'], 'tagging/keys/methods/list');
  const paths = document.paths as Record<string, Record<string, { operationId?: string }>>;
  assert.equal(paths['/{account_or_zone}/{account_or_zone_id}/tags']?.get?.operationId, 'tagging.resources.list');
});

test('keeps exactly the operations Forge gives a page, keyed by operationId', () => {
  const { document, operations } = prepare();
  const kept = ops(document).sort();
  assert.deepEqual(kept, Object.keys(operations).sort());
  assert.deepEqual(
    kept,
    readContent(spec, () => undefined)
      .operations.filter((entry) => !entry.alias)
      .map((entry) => entry.operationId)
      .sort(),
  );
  assert.ok(!kept.includes('alpha.retired.list'), 'hidden operation');
  assert.equal((document.paths as Record<string, unknown>)['/alpha/retired'], undefined);
  assert.equal((document.paths as Record<string, unknown>)['/alpha/anonymous'], undefined, 'operation without an id');
  assert.equal(operations['alpha.misc'], 'alpha/methods/misc', 'an operationId names an operation without SDK names');
  assert.ok(kept.includes('alpha.settings.get'));
  assert.ok(kept.includes('alpha.settings.update') && kept.includes('alpha.settings.edit'));
});

test("routes are today's URLs, with moved product slugs", () => {
  const { operations, redirects } = prepare();
  assert.equal(operations['alpha.items.notes.list'], 'alpha/items/notes/methods/list');
  assert.equal(operations['beta.zones.update'], 'beta/zones/methods/update');
  assert.equal(operations['tags.keys.list'], 'tagging/keys/methods/list');
  assert.equal(redirects['/tags/keys/methods/list/'], '/tagging/keys/methods/list/');
});

test('every operation carries its route in the spec, as x-nimbus-route', () => {
  const { document, operations } = prepare();
  const routes = Object.values(document.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap(
    (item) => Object.values(item).map((op) => [op.operationId, op['x-nimbus-route']]),
  );
  assert.ok(routes.length > 0);
  assert.deepEqual(Object.fromEntries(routes), operations);
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
  const { redirects, document } = prepare();
  assert.equal(redirects['/alpha/'], undefined);
  assert.equal(redirects['/alpha/items/'], undefined);
  assert.equal(redirects['/alpha/items/notes/'], undefined);
  assert.equal(redirects['/tags/'], '/tagging/');
  assert.equal(redirects['/tags/keys/'], '/tagging/keys/');
  const tags = document.tags as { name: string; 'x-nimbus-route'?: string }[];
  assert.deepEqual(
    tags.filter((tag) => tag['x-nimbus-route']).map((tag) => [tag.name, tag['x-nimbus-route']]),
    [['tags', 'tagging']],
    'a moved product sets its section segment on its tag',
  );
});

test('an alias path that is also a real section keeps the real page', () => {
  const op = (group: string, method: string, extra: Record<string, unknown> = {}) => ({
    operationId: `${group}.${method}`,
    tags: [group],
    'x-fern-sdk-group-name': group,
    'x-fern-sdk-method-name': method,
    responses: { '200': { description: 'ok' } },
    ...extra,
  });
  const { redirects } = prepareForgeApi(
    {
      openapi: '3.1.0',
      info: { title: 'Fixture', version: '1' },
      paths: {
        '/a/items': {
          get: op('a.items', 'list', {
            'x-forge-aliases': [{ 'x-fern-sdk-group-name': 'b.items', 'x-fern-sdk-method-name': 'list' }],
          }),
        },
        '/b/items/{id}': { get: op('b.items', 'get') },
      },
    },
    new Map(),
  );
  assert.equal(redirects['/b/items/methods/list/'], '/a/items/methods/list/');
  assert.equal(redirects['/b/'], undefined);
  assert.equal(redirects['/b/items/'], undefined);
});

test('the SDK samples are the Stainless snippets of their operation, else a comment that the SDK lacks it', () => {
  const { document } = prepare(
    spec,
    new Map([['beta.zones.list', { typescript: 'client.zones.list();', go: 'client.Zones.List()' }]]),
  );
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const sdk = (op: Record<string, unknown>) =>
    (op['x-codeSamples'] as { lang: string; source: string }[])
      .filter((sample) => ['typescript', 'python', 'go'].includes(sample.lang))
      .map((sample) => sample.source);
  assert.deepEqual(sdk(paths['/beta/zones']!.get!), [
    'client.zones.list();',
    '# This operation is not available in the Python SDK.',
    'client.Zones.List()',
  ]);
  assert.deepEqual(sdk(paths['/beta/zones']!.post!), [
    '// This operation is not available in the TypeScript SDK.',
    '# This operation is not available in the Python SDK.',
    '// This operation is not available in the Go SDK.',
  ]);
});

test('samples cover every target, with placeholders, one Terraform sample joining every declaration example and its import command, and an example per JSON response; Terraform data rides the extension', () => {
  const { document } = prepare();
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const create = paths['/beta/zones']!.post!;
  const samples = create['x-codeSamples'] as { lang: string; label: string; source: string }[];
  assert.deepEqual(
    samples.map((sample) => [sample.lang, sample.label]),
    [
      ['cf', 'cf CLI'],
      ['curl', 'curl'],
      ['typescript', 'TypeScript'],
      ['python', 'Python'],
      ['go', 'Go'],
      ['terraform', 'Terraform'],
    ],
  );
  assert.match(samples[1]!.source, /curl .*\/beta\/zones/s);
  assert.equal(
    samples.at(-1)!.source,
    [
      'resource "cloudflare_zone" "x" {}',
      "# Import an existing cloudflare_zone:\n# terraform import cloudflare_zone.x '<zone_id>'",
      'data "cloudflare_zone" "x" {}',
      '# No HCL example is available for cloudflare_zone_setting.',
      "# Import an existing cloudflare_zone_setting:\n# One setting at a time.\n# terraform import cloudflare_zone_setting.x '<zone_id>/<setting_id>'",
    ].join('\n\n'),
  );
  const extension = create[TERRAFORM_EXTENSION] as { declarations: unknown[] };
  assert.equal(extension.declarations.length, 3);
  const list = paths['/beta/zones']!.get!;
  const listSamples = list['x-codeSamples'] as { lang: string; source: string }[];
  assert.deepEqual(
    listSamples.map((sample) => sample.lang),
    ['cf', 'curl', 'typescript', 'python', 'go', 'terraform'],
  );
  assert.equal(listSamples.at(-1)!.source, '# This operation is not implemented in Terraform.');
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

test('the prepared spec is titled for the API home', () => {
  assert.equal((prepare().document.info as { title: string }).title, 'API Reference');
});
