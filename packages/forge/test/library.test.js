import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse } from '../plugin/index.js';

/** A document with a group, a method with path and query parameters and a body, and a model. */
const pets = {
  openapi: '3.1.0',
  info: { title: 'Pets', version: '2' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/pets/{pet_id}': {
      patch: {
        'x-forge-group-name': 'pets',
        'x-forge-method-name': 'update',
        'x-forge-availability': 'beta',
        'x-example': { a: [1, 2] },
        summary: 'Update a pet',
        parameters: [
          { name: 'pet_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'notify', in: 'query', schema: { type: 'boolean' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
        },
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          404: { description: 'missing' },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        description: 'A pet.',
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, age: { type: 'integer', format: 'int32' } },
      },
    },
  },
};

/** A document with one method, `GET /` in `group`. */
function oneMethod(group, version = '1') {
  return {
    openapi: '3.1.0',
    info: { title: group, version },
    paths: {
      '/': {
        get: { 'x-forge-group-name': group, 'x-forge-method-name': 'get', responses: { 200: { description: 'ok' } } },
      },
    },
  };
}

test('parse reads a document into the forge plugins see', () => {
  using forge = parse(JSON.stringify(pets));

  assert.equal(forge.version, '2');
  assert.equal(forge.baseUrl, 'https://api.example.com/v1');
  // The root, which every other group is inside, comes first.
  assert.deepEqual(
    forge.groups.map((group) => group.path.map((name) => name.kebab()).join('.')),
    ['', 'pets'],
  );
  const [method] = forge.groups[1].methods;
  assert.equal(method.name.camel(), 'update');
  assert.equal(method.httpMethod, 'PATCH');
  assert.equal(method.path, '/pets/{pet_id}');
  assert.equal(method.summary, 'Update a pet');
  assert.equal(method.availability, 'beta');
  assert.deepEqual(method.extension('x-example'), { a: [1, 2] });
  assert.deepEqual(
    method.responses.map((r) => r.status),
    ['200'],
  );
  assert.deepEqual(
    method.errors.map((r) => r.status),
    ['404'],
  );

  const body = method.body?.json?.type;
  assert.equal(body?.kind, 'model');
  assert.equal(body.model.schemaName, 'Pet');
  assert.equal(body.model.description, 'A pet.');
  assert.deepEqual(
    body.model.type.fields.map((f) => [f.wireName, f.required, f.type]),
    [
      ['name', true, { kind: 'scalar', scalar: 'string' }],
      ['age', false, { kind: 'scalar', scalar: 'number', number: 'int32' }],
    ],
  );
});

test('the parameters of a method say where they are sent', () => {
  using forge = parse(JSON.stringify(pets));
  const [method] = forge.groups[1].methods;

  // The request is the parameters and the body, intersected.
  const request = method.request;
  assert.equal(request?.kind, 'intersection');
  const params = request.members[0];
  assert.equal(params.kind, 'object');
  assert.deepEqual(
    params.fields.map((field) => [field.wireName, method.location(field)]),
    [
      ['pet_id', { in: 'path' }],
      ['notify', { in: 'query', exploded: true }],
    ],
  );
  assert.deepEqual(params.fields[0].type, { kind: 'scalar', scalar: 'uuid' });
});

test('a part read twice is the same object', () => {
  using forge = parse(JSON.stringify(pets));
  const method = forge.groups[1].methods[0];
  assert.equal(forge.groups[1].methods[0], method);
  assert.equal(method.group, forge.groups[1]);
  assert.equal(method.group.parent, forge.groups[0]);
  assert.equal(method.body?.json?.type.model, method.responses[0].json?.type.model);
});

test('a document forge does not read throws with forge’s message', () => {
  assert.throws(() => parse(JSON.stringify({ openapi: '2.0' })), {
    name: 'Error',
    message: /only OpenAPI 3\.0, 3\.1 and 3\.2/,
  });
  assert.throws(() => parse('{'), Error);
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 't', version: '1' },
          paths: {
            '/a': { get: { 'x-forge-group-name': 'g', 'x-forge-method-name': 'get', responses: {} } },
            '/b': { get: { 'x-forge-group-name': 'g', 'x-forge-method-name': 'get', responses: {} } },
          },
        }),
      ),
    /method "get" is also GET \/a in the same group/,
  );
});

test('documents parsed side by side stay apart', () => {
  using a = parse(JSON.stringify(oneMethod('alpha', '1')));
  using b = parse(JSON.stringify(oneMethod('beta', '2')));
  assert.deepEqual([a.version, a.groups[1].name.kebab()], ['1', 'alpha']);
  assert.deepEqual([b.version, b.groups[1].name.kebab()], ['2', 'beta']);
});

test('a disposed document keeps what was read, and fails on what was not', () => {
  const forge = parse(JSON.stringify(pets));
  const group = forge.groups[1];
  assert.equal(group.name.kebab(), 'pets');
  forge.dispose();

  assert.equal(group.name.kebab(), 'pets');
  assert.throws(() => group.methods[0].name, /not a valid "Forge" resource/i);
});

/** A document that names its method only with Fern's extensions. */
const fern = {
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/pets': {
      get: {
        'x-fern-sdk-group-name': ['pets'],
        'x-fern-sdk-method-name': 'list',
        'x-fern-availability': 'beta',
        responses: { 200: { description: 'ok' } },
      },
    },
  },
};

test('the fern adapter reads Fern’s extensions as Forge’s own', () => {
  using plain = parse(JSON.stringify(fern));
  assert.deepEqual(
    plain.groups.flatMap((group) => group.methods),
    [],
  );

  using adapted = parse(JSON.stringify(fern), { adapters: ['fern'] });
  const methods = adapted.groups.flatMap((group) => group.methods);
  assert.deepEqual(
    methods.map((m) => [m.group.path.map((name) => name.kebab()).join('.'), m.name.camel(), m.availability]),
    [['pets', 'list', 'beta']],
  );
});

test('an adapter forge has not is an error', () => {
  assert.throws(() => parse(JSON.stringify(fern), { adapters: ['swagger'] }), /unknown adapter "swagger"/);
});

test('an aliased operation is a method, and its aliases link to it', () => {
  using forge = parse(
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Observability', version: '1' },
      paths: {
        '/destinations': {
          get: {
            'x-forge-group-name': 'observability.destinations',
            'x-forge-method-name': 'list',
            'x-forge-aliases': [{ 'x-forge-group-name': 'o11y.destinations', 'x-forge-method-name': 'list' }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    }),
  );
  const address = (m) => [...m.group.path.map((name) => name.kebab()), m.name.kebab()].join('.');
  const [own, alias] = ['observability', 'o11y'].map((top) =>
    forge.groups.flatMap((g) => g.methods).find((m) => m.group.path[0]?.kebab() === top),
  );

  assert.equal(address(own), 'observability.destinations.list');
  assert.equal(own.aliasOf, undefined);
  assert.deepEqual(own.aliases.map(address), ['o11y.destinations.list']);
  assert.equal(alias.aliasOf, own);
  assert.deepEqual(alias.aliases, []);
});
