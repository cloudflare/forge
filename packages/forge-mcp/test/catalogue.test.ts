import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCatalogue } from '../src/tools.ts';
import { field, forge, inPath, inQuery, integer, jsonBody, model, object, string } from './fake-forge.ts';

test('a method becomes a tool named by its group path and name', () => {
  const zoneId = field('zone_id', string, { required: true, description: 'Zone.' });
  const page = field('page', integer);
  const catalogue = buildCatalogue(
    forge({
      'dns.records': [
        {
          name: 'list',
          path: '/zones/{zone_id}/dns_records',
          summary: 'List DNS records',
          params: [
            [zoneId, inPath],
            [page, inQuery],
          ],
        },
      ],
    }),
  );

  assert.equal(catalogue.format, 'forge-mcp/1');
  assert.deepEqual(catalogue.api, { version: '1.0.0', baseUrl: 'https://api.example.com/v1' });
  assert.deepEqual(catalogue.tools, [
    {
      name: 'dns_records_list',
      title: 'List DNS records',
      description: 'List DNS records',
      inputSchema: {
        type: 'object',
        properties: {
          zone_id: { type: 'string', description: 'Zone.' },
          page: { type: 'integer' },
        },
        required: ['zone_id'],
      },
      annotations: {
        title: 'List DNS records',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      request: {
        method: 'GET',
        path: '/zones/{zone_id}/dns_records',
        params: [
          { key: 'zone_id', name: 'zone_id', in: 'path' },
          { key: 'page', name: 'page', in: 'query', explode: true },
        ],
      },
    },
  ]);
});

test('a JSON body is the body argument, and headers are arguments too', () => {
  const ifMatch = field('If-Match', string, { required: true });
  const record = object([
    field('name', string, { required: true }),
    field('id', string, { readOnly: true, required: true }),
  ]);
  const [tool] = buildCatalogue(
    forge({ records: [{ name: 'update', httpMethod: 'PUT', headers: [ifMatch], body: jsonBody(record) }] }),
  ).tools;

  assert.deepEqual(tool?.inputSchema, {
    type: 'object',
    properties: {
      if_match: { type: 'string' },
      body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    required: ['if_match', 'body'],
  });
  assert.deepEqual(tool?.request.params, [{ key: 'if_match', name: 'If-Match', in: 'header' }]);
  assert.deepEqual(tool?.request.body, { key: 'body', mediaType: 'application/json' });
  assert.equal(tool?.annotations.destructiveHint, true);
});

test('models are $defs, recursive ones included, and each tool has only the ones it reaches', () => {
  const node = model('Tree Node', () =>
    object([
      field('children', {
        kind: 'array',
        elem: { kind: 'model', model: node },
        minItems: undefined,
        maxItems: undefined,
      }),
    ]),
  );
  const unused = model('Unused', () => string);
  const [tree, other] = buildCatalogue(
    forge({
      trees: [
        { name: 'create', httpMethod: 'POST', body: jsonBody({ kind: 'model', model: node }) },
        { name: 'unrelated', httpMethod: 'POST', body: jsonBody({ kind: 'model', model: unused }) },
      ],
    }),
  ).tools;

  assert.deepEqual(tree?.inputSchema.$defs, {
    Tree_Node: {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#/$defs/Tree_Node' } } },
    },
  });
  assert.deepEqual(tree?.inputSchema.properties, { body: { $ref: '#/$defs/Tree_Node' } });
  assert.deepEqual(Object.keys(other?.inputSchema.$defs ?? {}), ['Unused']);
});

test('deprecated methods get no tool, hidden ones do, and other methods can be chosen', () => {
  const methods = {
    things: [
      { name: 'list' },
      { name: 'secret', hidden: true },
      { name: 'old', deprecated: true },
      { name: 'delete', httpMethod: 'DELETE' },
    ],
  };
  assert.deepEqual(
    buildCatalogue(forge(methods)).tools.map((tool) => tool.name),
    ['things_list', 'things_secret', 'things_delete'],
  );
  assert.deepEqual(
    buildCatalogue(forge(methods), { include: (method) => method.httpMethod === 'GET' }).tools.map((t) => t.name),
    ['things_list', 'things_secret', 'things_old'],
  );
});

test('a required body that is not JSON skips the method, with the reason', () => {
  const upload = { mediaType: 'multipart/form-data', isJson: false, description: '', type: string };
  const catalogue = buildCatalogue(
    forge({
      scripts: [
        {
          name: 'upload',
          httpMethod: 'PUT',
          path: '/scripts',
          body: { required: true, description: '', contents: [upload], json: undefined },
        },
      ],
    }),
  );

  assert.deepEqual(catalogue.tools, []);
  assert.deepEqual(catalogue.skipped, [
    { method: 'PUT', path: '/scripts', reason: 'the request body is not JSON (multipart/form-data)' },
  ]);
});

test('a second method with the same tool name is skipped', () => {
  const catalogue = buildCatalogue(
    forge({
      things: [
        { name: 'list', path: '/a' },
        { name: 'list', path: '/b' },
      ],
    }),
  );

  assert.deepEqual(
    catalogue.tools.map((tool) => tool.request.path),
    ['/a'],
  );
  assert.deepEqual(catalogue.skipped, [
    { method: 'GET', path: '/b', reason: 'another method already has the tool name things_list' },
  ]);
});

test('confirmation and availability are in the description, and confirmation makes a tool destructive', () => {
  const [tool] = buildCatalogue(
    forge({
      zones: [
        {
          name: 'purge',
          httpMethod: 'GET',
          description: 'Purge everything.',
          availability: 'beta',
          confirmation: 'This removes every cached file.',
        },
      ],
    }),
  ).tools;

  assert.equal(
    tool?.description,
    'Purge everything.\n\nThis method is beta.\n\nConfirm with the user before calling this tool. This removes every cached file.',
  );
  assert.equal(tool?.annotations.readOnlyHint, false);
  assert.equal(tool?.annotations.destructiveHint, true);
});

test('transform changes or drops a tool', () => {
  const catalogue = buildCatalogue(forge({ things: [{ name: 'list' }, { name: 'drop' }] }), {
    transform: (tool) => (tool.name === 'things_drop' ? undefined : { ...tool, description: 'Changed.' }),
  });

  assert.deepEqual(
    catalogue.tools.map((tool) => [tool.name, tool.description]),
    [['things_list', 'Changed.']],
  );
});
