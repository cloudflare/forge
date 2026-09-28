import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ForgeOpenApiDocument, initFromOpenApi } from './init-from-openapi.ts';
import { filterApiOverlaysForOpenApi, resolveApiOverlays } from './overlay-source.ts';
import type { ApiOverlayFile } from './overlay-types.ts';

function overlay(name: string, methods: unknown[]): ApiOverlayFile {
  return {
    name,
    overlay: {
      overlay: '1.0.0',
      info: { title: name, version: '1.0.0' },
      actions: [
        {
          target: '$',
          update: {
            'x-forge-commands': {
              [name]: { description: name, methods },
            },
          },
        },
        { target: '$.paths.*[?@.operationId=="available"]', update: { description: 'available' } },
        { target: '$.paths.*[?@.operationId=="missing"]', update: { description: 'missing' } },
      ],
    },
  };
}

test('filters unavailable operations from overlays applied to a public OpenAPI', () => {
  const available = {
    operationId: 'available',
    'x-fern-sdk-method-name': 'get',
    'x-fern-availability': 'generally-available',
  };
  const missing = {
    operationId: 'missing',
    'x-fern-sdk-method-name': 'create',
    'x-fern-availability': 'generally-available',
  };
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: { '/available': { get: { operationId: 'available', responses: {} } } },
  };

  const result = filterApiOverlaysForOpenApi(
    [overlay('mixed', [available, { 'x-fern-sdk-group-name': 'nested', description: 'nested', methods: [missing] }])],
    source,
  );

  assert.equal(result.length, 1);
  const actions = result[0]?.overlay.actions ?? [];
  assert.equal(actions.length, 2);
  assert.equal(
    actions.some((action) => action.target.includes('"missing"')),
    false,
  );
  const firstAction = actions[0];
  assert.ok(firstAction);
  const update = firstAction.update as { 'x-forge-commands': Record<string, { methods: unknown[] }> };
  assert.deepEqual(update['x-forge-commands'].mixed?.methods, [available]);
});

test('drops command overlays that have no operations in the source OpenAPI', () => {
  const result = filterApiOverlaysForOpenApi(
    [
      overlay('missing', [
        {
          operationId: 'missing',
          'x-fern-sdk-method-name': 'get',
          'x-fern-availability': 'generally-available',
        },
      ]),
    ],
    { openapi: '3.0.3', info: { title: 'public', version: '1' }, paths: {} },
  );

  assert.deepEqual(result, []);
});

test('external overlay resolution does not require internal description coverage', async () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: {
          operationId: 'available',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: { schemas: {} },
  };
  const available = {
    operationId: 'available',
    'x-fern-sdk-method-name': 'get',
    'x-fern-availability': 'generally-available',
  };

  await assert.doesNotReject(() =>
    resolveApiOverlays([overlay('public', [available])], source, {
      allowMissingOperations: true,
      writeArtifacts: false,
    }),
  );
});

test('external overlay output does not recreate unavailable command groups', async () => {
  const available = overlay('available-command', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'generally-available',
    },
  ]);
  const missing = overlay('missing-command', [
    {
      operationId: 'missing',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'generally-available',
    },
  ]);
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: {
          operationId: 'available',
          summary: 'Available',
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  };

  const { overlaidOpenApi } = await resolveApiOverlays([available, missing], source, {
    allowMissingOperations: true,
    writeArtifacts: false,
  });
  const forge = initFromOpenApi(overlaidOpenApi as ForgeOpenApiDocument);

  assert.deepEqual([...forge.commands.keys()], ['available-command']);
});

test('loads command and group descriptions from the OpenAPI command catalogue', () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/accounts/tokens': {
        get: {
          operationId: 'list-account-tokens',
          summary: 'List account tokens',
          description: 'Lists account tokens.',
          'x-fern-availability': 'generally-available',
          'x-fern-sdk-group-name': 'accounts.tokens',
          'x-fern-sdk-method-name': 'list',
          responses: {},
        },
      },
    },
    components: { schemas: {} },
    'x-forge-commands': {
      accounts: {
        description: 'Manage Cloudflare accounts',
        groups: {
          tokens: {
            description: 'Create and manage scoped API tokens',
          },
        },
      },
    },
  };

  const forge = initFromOpenApi(source as ForgeOpenApiDocument);
  const command = forge.commands.get('accounts');
  const tokens = command?.methods.find((method) => method.name === 'tokens');

  assert.equal(command?.description, 'Manage Cloudflare accounts');
  assert.equal(tokens?.description, 'Create and manage scoped API tokens');
});

test('loads Fern parameter names as Forge parameter overrides', () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/search': {
        get: {
          operationId: 'search',
          summary: 'Search',
          description: 'Search for resources.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              description: 'The search query.',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'searchQuery',
            },
          ],
          'x-fern-availability': 'generally-available',
          'x-fern-sdk-group-name': 'example',
          'x-fern-sdk-method-name': 'search',
          'x-forge-params': {
            q: { required: true },
          },
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  };

  const forge = initFromOpenApi(source as ForgeOpenApiDocument);
  const search = forge.commands.get('example')?.methods.find((method) => method.name === 'search');

  assert.ok(search && 'operationId' in search);
  assert.deepEqual(search.params, {
    q: { flagName: 'search-query', required: true },
  });
});

test('prefers explicit Forge flag names over Fern parameter names', () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/search': {
        get: {
          operationId: 'search',
          summary: 'Search',
          description: 'Search for resources.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              description: 'The search query.',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'searchQuery',
            },
          ],
          'x-fern-availability': 'generally-available',
          'x-fern-sdk-group-name': 'example',
          'x-fern-sdk-method-name': 'search',
          'x-forge-params': {
            q: { flagName: 'term' },
          },
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  };

  const forge = initFromOpenApi(source as ForgeOpenApiDocument);
  const search = forge.commands.get('example')?.methods.find((method) => method.name === 'search');

  assert.ok(search && 'operationId' in search);
  assert.deepEqual(search.params, {
    q: { flagName: 'term' },
  });
});

test('applies root patches and operation metadata directly', async () => {
  const api = overlay('example', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'generally-available',
    },
  ]);
  const descriptionAction = api.overlay.actions.find((action) => action.target.includes('"available"'));
  assert.ok(descriptionAction);
  descriptionAction.update = { description: 'Overlay description' };
  const commandAction = api.overlay.actions.find((action) => action.target === '$');
  assert.ok(commandAction);
  commandAction.update = {
    ...(commandAction.update as Record<string, unknown>),
    components: {
      schemas: {
        Added: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  };
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: {
          operationId: 'available',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: { schemas: { Existing: { type: 'string' } } },
  };

  const { overlaidOpenApi } = await resolveApiOverlays([api], source, {
    allowMissingOperations: true,
    writeArtifacts: false,
  });
  const operation = overlaidOpenApi.paths['/available']?.get as Record<string, unknown>;

  assert.deepEqual(Object.keys(overlaidOpenApi.components?.schemas ?? {}), ['Existing', 'Added']);
  assert.equal(operation.description, 'Overlay description');
  assert.equal(operation['x-fern-sdk-group-name'], 'example');
  assert.equal(operation['x-fern-sdk-method-name'], 'get');
});

test('rejects a root patch that destroys the OpenAPI document shape', async () => {
  const api = overlay('example', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'generally-available',
    },
  ]);
  api.overlay.actions.push({ target: '$', update: { paths: [] } });
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: {
          operationId: 'available',
          description: 'Available',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };

  await assert.rejects(
    () => resolveApiOverlays([api], source, { allowMissingOperations: true, writeArtifacts: false }),
    /Combined overlay output is not a valid OpenAPI document shape/,
  );
});

test('root patches replace scalar arrays instead of appending them', async () => {
  const api = overlay('example', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'generally-available',
    },
  ]);
  const commandAction = api.overlay.actions.find((action) => action.target === '$');
  assert.ok(commandAction);
  commandAction.update = {
    ...(commandAction.update as Record<string, unknown>),
    components: {
      schemas: {
        Example: { type: 'object', required: ['replacement'] },
      },
    },
  };
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: { operationId: 'available', responses: {} },
      },
    },
    components: {
      schemas: {
        Example: { type: 'object', required: ['original'] },
      },
    },
  };

  const { overlaidOpenApi } = await resolveApiOverlays([api], source, {
    allowMissingOperations: true,
    writeArtifacts: false,
  });

  const example = overlaidOpenApi.components?.schemas?.Example as { required?: string[] };
  assert.deepEqual(example.required, ['replacement']);
});

test('rejects invalid method lifecycle metadata on the OpenAPI-only path', async () => {
  const invalidStatus = overlay('invalid-status', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'get',
      'x-fern-availability': 'stable',
    },
  ]);
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: { operationId: 'available', responses: {} },
      },
    },
  };

  await assert.rejects(
    () => resolveApiOverlays([invalidStatus], source, { writeArtifacts: false, allowMissingOperations: true }),
    /available: invalid x-fern-availability stable/,
  );
});
