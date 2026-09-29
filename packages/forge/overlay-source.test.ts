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

test('loads nested and dotted group metadata from the OpenAPI command catalogue', () => {
  const operation = (operationId: string, group: string) => ({
    get: {
      operationId,
      summary: operationId,
      description: operationId,
      'x-fern-availability': 'generally-available',
      'x-fern-sdk-group-name': group,
      'x-fern-sdk-method-name': 'list',
      responses: {},
    },
  });
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/tokens/permissions': operation('list-token-permissions', 'accounts.tokens.permissions'),
      '/members/roles': operation('list-member-roles', 'accounts.members.roles'),
    },
    components: { schemas: {} },
    'x-forge-commands': {
      accounts: {
        description: 'Manage Cloudflare accounts',
        groups: {
          tokens: {
            description: 'Manage account tokens',
            'x-forge-epilogue': 'See the token security guide.',
            groups: { permissions: { description: 'Inspect token permissions' } },
          },
          'members.roles': { description: 'Manage member roles' },
        },
      },
    },
  };

  const forge = initFromOpenApi(source as ForgeOpenApiDocument);
  const groups = forge.commands.get('accounts')?.methods ?? [];
  const tokens = groups.find((method) => method.name === 'tokens');
  const members = groups.find((method) => method.name === 'members');
  assert.ok(tokens && 'methods' in tokens);
  assert.ok(members && 'methods' in members);

  assert.equal(tokens.description, 'Manage account tokens');
  assert.equal(tokens.epilogue, 'See the token security guide.');
  assert.equal(
    tokens.methods.find((method) => method.name === 'permissions')?.description,
    'Inspect token permissions',
  );
  assert.equal(members.description, 'Operations for members');
  assert.equal(members.methods.find((method) => method.name === 'roles')?.description, 'Manage member roles');
});

test('writes command and group metadata to x-forge-commands in the overlaid OpenAPI', async () => {
  const api = overlay('example', [
    {
      'x-fern-sdk-group-name': 'widgets',
      description: 'Manage widgets',
      'x-forge-epilogue': 'See the widget guide.',
      methods: [
        {
          operationId: 'available',
          'x-fern-sdk-method-name': 'get',
          'x-fern-availability': 'generally-available',
        },
      ],
    },
  ]);
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: { operationId: 'available', responses: { '200': { description: 'OK' } } },
      },
    },
    components: { schemas: {} },
  };

  const { overlaidOpenApi } = await resolveApiOverlays([api], source, {
    allowMissingOperations: true,
    writeArtifacts: false,
  });

  assert.deepEqual((overlaidOpenApi as ForgeOpenApiDocument)['x-forge-commands'], {
    example: {
      description: 'example',
      groups: {
        widgets: { description: 'Manage widgets', 'x-forge-epilogue': 'See the widget guide.' },
      },
    },
  });

  const forge = initFromOpenApi(overlaidOpenApi as ForgeOpenApiDocument);
  const widgets = forge.commands.get('example')?.methods.find((method) => method.name === 'widgets');
  assert.ok(widgets && 'methods' in widgets);
  assert.equal(widgets.description, 'Manage widgets');
  assert.equal(widgets.epilogue, 'See the widget guide.');
});

test('keeps x-forge-params as declared', () => {
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
              'x-fern-parameter-name': 'search-query',
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
    q: { required: true },
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

test('keeps legacy availability and its message through overlay resolution', async () => {
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/available': {
        get: {
          operationId: 'available',
          description: 'Lists widgets.',
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  };
  const api = overlay('widgets', [
    {
      operationId: 'available',
      'x-fern-sdk-method-name': 'list',
      'x-fern-availability': { status: 'legacy', message: 'Use the v2 widgets endpoint.' },
    },
  ]);

  const { overlaidOpenApi } = await resolveApiOverlays([api], source, {
    allowMissingOperations: true,
    writeArtifacts: false,
  });
  const operation = overlaidOpenApi.paths?.['/available']?.get as { 'x-fern-availability'?: unknown } | undefined;
  assert.deepEqual(operation?.['x-fern-availability'], {
    status: 'legacy',
    message: 'Use the v2 widgets endpoint.',
  });

  const forge = initFromOpenApi(overlaidOpenApi as ForgeOpenApiDocument);
  const method = forge.commands.get('widgets')?.methods[0];
  assert.ok(method && !('methods' in method));
  assert.equal(method.status, 'legacy');
  assert.equal(method.availabilityMessage, 'Use the v2 widgets endpoint.');
});

test('reads Fern availability objects directly from an OpenAPI document', () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/widgets': {
        get: {
          operationId: 'list-widgets',
          description: 'Lists widgets.',
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'list',
          'x-fern-availability': { status: 'preview', message: 'Subject to change.' },
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  } as ForgeOpenApiDocument;

  const forge = initFromOpenApi(source);
  const method = forge.commands.get('widgets')?.methods[0];
  assert.ok(method && !('methods' in method));
  assert.equal(method.status, 'preview');
  assert.equal(method.availabilityMessage, 'Subject to change.');
});

test('rejects an availability object with an unknown status on the OpenAPI path', () => {
  const source = {
    openapi: '3.0.3',
    info: { title: 'public', version: '1' },
    paths: {
      '/widgets': {
        get: {
          operationId: 'list-widgets',
          description: 'Lists widgets.',
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'list',
          'x-fern-availability': { status: 'stable', message: 'Ready.' },
          responses: {},
        },
      },
    },
    components: { schemas: {} },
  } as ForgeOpenApiDocument;

  assert.throws(() => initFromOpenApi(source), /list-widgets: invalid x-fern-availability stable/);
});
