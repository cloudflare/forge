import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverFernProducts, loadOpenApiDocument, openApiDocumentSchema, parseOpenApiDocument } from './build.ts';
import {
  buildDocsModel,
  classifyResponseStatus,
  preferredResponse,
  preferredResponseRepresentation,
  responsePayloadSchema,
  type BuildOptions,
  type DocOperation,
  type OpenApiDocumentSchema,
  type SchemaNode,
  unknownRecordSchema,
} from './index.ts';
import { fixtureExtension, fixtureSnippets, widgetsProduct, widgetsSpec } from '../test-fixture.ts';
import type { SnippetInput } from '../snippets/index.ts';
import { defineFernExtension } from '../extensions.ts';

// Unit: builds against the product-agnostic in-memory fixture (no registry,
// no Cloudflare data). Product-specific behaviour is covered in cloudflare-api-site.
const model = buildDocsModel({ source: widgetsSpec, products: [widgetsProduct], snippets: fixtureSnippets });

function ops(): DocOperation[] {
  const product = model.products[0];
  assert.ok(product);
  return product.sections.flatMap((section) => section.operations);
}
const find = (slug: string): DocOperation | undefined => ops().find((operation) => operation.slug === slug);

function requestSchema(operation: DocOperation, mediaType = 'application/json'): SchemaNode | undefined {
  return (
    operation.requestBody?.representations.find((representation) => representation.mediaType === mediaType)?.schema ??
    undefined
  );
}

test('builds the manifest-owned product and OpenAPI-tag section', () => {
  assert.equal(model.description, 'Welcome to the **Widgets API**. Read the [guide](https://example.com/widgets).');
  assert.equal(model.products.length, 1);
  const product = model.products[0];
  assert.ok(product);
  assert.equal(product.name, 'widgets');
  assert.equal(product.title, 'Widgets');
  assert.equal(product.description, 'Widgets API');
  assert.deepEqual(
    product.sections.map(({ id, tag, title }) => ({ id, tag, title })),
    [{ id: 'management', tag: 'Widget Management', title: 'Widget Management' }],
  );
});

test('discovers products from top-level Fern SDK groups and sections from primary tags', () => {
  assert.deepEqual(discoverFernProducts(widgetsSpec), [
    {
      id: 'widgets',
      sdkGroup: 'widgets',
      sections: [{ id: 'widget-management', tag: 'Widget Management' }],
    },
  ]);
});

test('discovered alias groups may expose one operation under multiple products', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/shared': {
        get: {
          operationId: 'get-shared',
          tags: ['Shared Operations'],
          deprecated: true,
          'x-fern-sdk-group-name': 'first.items',
          'x-fern-sdk-method-name': 'get',
          'x-test-confirmation': 'This operation removes the shared item.',
          'x-test-aliases': [
            {
              'x-fern-sdk-group-name': 'second.items',
              'x-fern-sdk-method-name': 'get',
              'x-test-confirmation': 'This operation removes the second shared item.',
            },
          ],
        },
      },
    },
  };
  const discovered = buildDocsModel({
    source,
    products: discoverFernProducts(source, { extensions: [fixtureExtension] }),
    extensions: [fixtureExtension],
  });

  assert.deepEqual(
    discovered.products.map((product) => ({
      id: product.name,
      operations: product.sections.flatMap((section) =>
        section.operations.map((operation) => ({
          id: operation.operationId,
          deprecated: operation.deprecated,
          requireConfirmation: operation.requireConfirmation,
        })),
      ),
    })),
    [
      {
        id: 'first',
        operations: [
          {
            id: 'get-shared',
            deprecated: true,
            requireConfirmation: 'This operation removes the shared item.',
          },
        ],
      },
      {
        id: 'second',
        operations: [
          {
            id: 'get-shared',
            deprecated: true,
            requireConfirmation: 'This operation removes the second shared item.',
          },
        ],
      },
    ],
  );
});

test('rejects malformed document and extension presentation metadata', () => {
  assert.throws(() => parseOpenApiDocument({ ...widgetsSpec, info: { description: 42 } }), /info\.description/);

  const badConfirmation = structuredClone(widgetsSpec);
  const update = badConfirmation.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(update);
  update['x-test-confirmation'] = '';
  assert.throws(
    () => buildDocsModel({ source: badConfirmation, products: [widgetsProduct], extensions: [fixtureExtension] }),
    /fixture.*widgets_update/,
  );
});

test('rejects malformed availability through the source schema', () => {
  const source = structuredClone(widgetsSpec);
  const update = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(update);
  update['x-fern-availability'] = { message: 'Missing status' };
  assert.throws(() => buildDocsModel({ source, products: [widgetsProduct] }), /status/);
});

test('normalizes standard and Fern deprecation', () => {
  const standardSource = structuredClone(widgetsSpec);
  const standardUpdate = standardSource.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(standardUpdate);
  standardUpdate.deprecated = true;
  const standard = buildDocsModel({
    source: standardSource,
    products: [widgetsProduct],
    extensions: [fixtureExtension],
  }).products[0]?.sections[0]?.operations[0];
  assert.ok(standard);
  assert.equal(standard.deprecated, true);
  assert.deepEqual(standard.availability, { status: 'generally-available' });
  const fernSource = structuredClone(widgetsSpec);
  const fernUpdate = fernSource.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(fernUpdate);
  fernUpdate['x-fern-availability'] = 'deprecated';
  const fern = buildDocsModel({ source: fernSource, products: [widgetsProduct] }).products[0]?.sections[0]
    ?.operations[0];
  assert.ok(fern);
  assert.equal(fern.deprecated, true);
});

test('resolves slug, verb, path, path params and snippets for the update operation', () => {
  const update = find('sections/management/operations/widgets-update');
  assert.ok(update, 'expected the widgets items update operation');
  assert.equal(update.httpMethod, 'PATCH');
  assert.equal(update.path, '/widgets/{widget_id}');
  assert.ok(update.pathParams.some((param) => param.name === 'widget_id'));
  assert.equal(update.requestBody?.required, true);
  assert.deepEqual(
    update.snippets.map((snippet) => snippet.targetId),
    ['curl', 'python'],
  );
  assert.equal(typeof update.snippets.find((snippet) => snippet.targetId === 'curl')?.code, 'string');
  // Fern's `x-fern-availability` is normalised to `{ status }`.
  assert.deepEqual(update.availability, { status: 'generally-available' });
});

test('preserves raw Markdown in descriptions (operation and nested schema nodes)', () => {
  const update = find('sections/management/operations/widgets-update');
  assert.ok(update);
  // The source model carries raw Markdown; the operations loader is what
  // enriches it to HTML, so here it must survive verbatim.
  assert.equal(update.description, 'Updates a [widget](https://example.com/widgets) by ID.');
  assert.equal(update.requestBody?.description, 'Fields to update on the [widget](https://example.com/widgets).');
  const name = requestSchema(update)?.children?.find((child) => child.name === 'name');
  assert.ok(name?.description?.includes('[name](https://example.com/naming)'));
  const widgetId = update.pathParams.find((param) => param.name === 'widget_id');
  assert.ok(widgetId?.description?.includes('[widget](https://example.com/widgets)'));
});

test('preserves request-body requiredness, description, media types, and schemas', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets/import': {
        post: {
          operationId: 'widgets_import',
          tags: ['Widget Management'],
          requestBody: {
            required: false,
            description: 'Import a **widget** from one of the supported representations.',
            content: {
              '': { schema: { type: 'string' } },
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
              },
              'application/merge-patch+json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
              'application/octet-stream': {},
            },
          },
        },
      },
    },
  };

  const operation = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0];
  assert.ok(operation?.requestBody);
  assert.equal(operation.requestBody.required, false);
  assert.equal(operation.requestBody.description, 'Import a **widget** from one of the supported representations.');
  assert.deepEqual(
    operation.requestBody.representations.map(({ mediaType, schema }) => ({ mediaType, type: schema?.type ?? null })),
    [
      { mediaType: 'multipart/form-data', type: 'object' },
      { mediaType: 'application/merge-patch+json', type: 'object' },
      { mediaType: 'application/octet-stream', type: null },
    ],
  );
  assert.equal(requestSchema(operation, 'multipart/form-data')?.children?.[0]?.required, true);
});

test('keeps full array response schemas and generates a bounded fallback', () => {
  const arraySpec: OpenApiDocumentSchema = {
    paths: {
      '/widgets': {
        get: {
          operationId: 'widgets_list',
          summary: 'List widgets',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'list',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const listModel = buildDocsModel({ source: arraySpec, products: [widgetsProduct] });
  const list = listModel.products[0]?.sections[0]?.operations.find(
    (operation) => operation.operationId === 'widgets_list',
  );
  assert.ok(list, 'expected the widgets items list operation');
  const response = list.responses[0];
  const representation = response?.representations[0];
  assert.ok(response && representation);
  assert.equal(response.status, '200');
  assert.equal(representation.schema?.type, 'object[]');
  assert.ok(
    representation.schema?.items?.children?.some((child) => child.name === 'id'),
    'expected the element schema tree',
  );
  assert.deepEqual(representation.generatedExample, [{ id: 'id' }]);
  assert.deepEqual(responsePayloadSchema(representation), {
    schema: representation.schema?.items,
    isArray: true,
  });
});

test('bounds schema-generated response fallback hints', () => {
  const example = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`field${index}`, index]));
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets/large': {
        get: {
          operationId: 'widgets_large_response',
          tags: ['Widget Management'],
          responses: {
            '200': {
              content: {
                'application/json': { schema: { type: 'object', example } },
              },
            },
          },
        },
      },
    },
  };
  const generated = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0]
    ?.responses[0]?.representations[0]?.generatedExample;
  const parsed = unknownRecordSchema.safeParse(generated);
  assert.ok(parsed.success);
  assert.equal(Object.keys(parsed.data).length, 100);
  assert.equal(parsed.data.field99, 99);
  assert.equal(parsed.data.field100, undefined);
});

test('preserves empty hints and only generates examples compatible with the representation', () => {
  const source: OpenApiDocumentSchema = {
    components: {
      examples: {
        Collision: { value: { resolvedFromWrongNamespace: true } },
      },
    },
    paths: {
      '/widgets/examples': {
        get: {
          operationId: 'widgets_response_examples',
          tags: ['Widget Management'],
          responses: {
            '200': {
              content: {
                'application/json': {
                  examples: { unresolved: { $ref: '#/components/schemas/Collision' } },
                  schema: { type: 'object', example: {} },
                },
                'application/problem+json': { schema: { type: 'array', example: [] } },
                'text/event-stream': {
                  schema: { type: 'object', properties: { event: { type: 'string' } } },
                },
                'text/plain': { schema: { type: 'string', example: '' } },
              },
            },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  const representations = operation.responses[0]?.representations;
  assert.ok(representations);

  assert.deepEqual(representations[0]?.examples, []);
  assert.deepEqual(representations[0]?.generatedExample, {});
  assert.deepEqual(representations[1]?.generatedExample, []);
  assert.equal(representations[2]?.generatedExample, undefined);
  assert.equal(representations[3]?.generatedExample, '');
});

test('normalizes ordered plural responses, representations, examples, payload keys, and fallbacks', () => {
  const source: OpenApiDocumentSchema = {
    components: {
      examples: {
        ReferencedCreated: {
          summary: 'Referenced creation',
          description: 'Created from a **component example**.',
          value: { success: true, result: { id: 'referenced' } },
        },
        ExternalCreated: {
          summary: 'External creation',
          externalValue: 'https://example.com/examples/created.json',
        },
      },
      schemas: {
        Identifier: { type: 'string', example: '023e105f4ecef8ad9ca31a8372d0c353' },
        Envelope: {
          type: 'object',
          required: ['success', 'result'],
          properties: {
            result: {
              type: 'object',
              required: ['id'],
              properties: { id: { $ref: '#/components/schemas/Identifier' } },
            },
            success: { type: 'boolean', example: true },
          },
        },
        AcceptedEnvelope: {
          type: 'object',
          required: ['result'],
          properties: {
            result: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
            },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          properties: {
            result: { type: 'string', example: 'must remain wrapped' },
            error: { type: 'string', example: 'invalid request' },
          },
        },
      },
      responses: {
        AcceptedAlias: { $ref: '#/components/responses/Accepted' },
        Accepted: {
          description: 'The request was accepted and queued.',
          content: {
            'application/x-ndjson': { schema: { type: 'string' } },
            'application/json': { schema: { $ref: '#/components/schemas/AcceptedEnvelope' } },
          },
        },
      },
    },
    paths: {
      '/registrar/widgets': {
        post: {
          operationId: 'widgets_register',
          tags: ['Widget Management'],
          responses: {
            '201': {
              description: 'The registrar created the **widget**.',
              content: {
                'application/vnd.widgets+json': {
                  example: { success: true, result: { id: 'singular' } },
                  examples: {
                    referenced: { $ref: '#/components/examples/ReferencedCreated' },
                    null: { value: null },
                    emptyObject: { value: {} },
                    emptyArray: { value: [] },
                    external: { $ref: '#/components/examples/ExternalCreated' },
                  },
                  schema: { $ref: '#/components/schemas/Envelope' },
                },
                'text/plain': { example: '', schema: { type: 'string' } },
                'application/pdf': { schema: { type: 'string', format: 'binary' } },
                'image/png': { schema: { type: 'string' } },
                'application/octet-stream': { schema: { type: 'string' } },
                'application/zip': { schema: { type: 'string' } },
                'application/xml': {},
              },
            },
            '202': { $ref: '#/components/responses/AcceptedAlias' },
            '204': { description: 'The operation completed without a response body.' },
            '4XX': {
              description: 'A registrar error.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
            },
            default: { description: 'No response body is returned for an unspecified status.' },
            '2xX': {
              description: 'A successful wildcard response.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
            },
          },
        },
      },
    },
  };

  const operation = buildDocsModel({ source, products: [widgetsProduct], responsePayloadKey: 'result' }).products[0]
    ?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.deepEqual(
    operation.responses.map(({ status }) => status),
    ['201', '202', '204', '4XX', 'default', '2xX'],
  );

  const created = operation.responses[0];
  const createdJson = created?.representations[0];
  assert.ok(created && createdJson);
  assert.equal(created.description, 'The registrar created the **widget**.');
  assert.equal(createdJson.payloadKey, 'result');
  assert.deepEqual(
    createdJson.schema?.children?.map(({ name }) => name),
    ['result', 'success'],
  );
  assert.deepEqual(createdJson.examples, [
    { value: { success: true, result: { id: 'singular' } } },
    {
      name: 'referenced',
      summary: 'Referenced creation',
      description: 'Created from a **component example**.',
      value: { success: true, result: { id: 'referenced' } },
    },
    { name: 'null', value: null },
    { name: 'emptyObject', value: {} },
    { name: 'emptyArray', value: [] },
    {
      name: 'external',
      summary: 'External creation',
      externalValue: 'https://example.com/examples/created.json',
    },
  ]);
  assert.equal(createdJson.generatedExample, undefined, 'explicit examples suppress generated fallbacks');
  assert.deepEqual(created.representations[1]?.examples, [{ value: '' }]);
  assert.equal(created.representations[2]?.schema?.format, 'binary');
  for (const representation of created.representations.slice(2, 6)) {
    assert.equal(representation.generatedExample, undefined);
  }
  assert.deepEqual(created.representations[6], {
    mediaType: 'application/xml',
    schema: null,
    examples: [],
  });

  const accepted = operation.responses[1];
  assert.equal(accepted?.description, 'The request was accepted and queued.');
  assert.deepEqual(
    accepted?.representations.map(({ mediaType }) => mediaType),
    ['application/x-ndjson', 'application/json'],
  );
  const acceptedJson = accepted?.representations[1];
  assert.ok(acceptedJson);
  assert.equal(acceptedJson.payloadKey, 'result');
  assert.deepEqual(acceptedJson.generatedExample, { result: [{ id: 'id' }] });

  assert.deepEqual(operation.responses[2]?.representations, []);
  const errorJson = operation.responses[3]?.representations[0];
  assert.ok(errorJson);
  assert.equal(errorJson.payloadKey, undefined);
  assert.deepEqual(errorJson.generatedExample, { result: 'must remain wrapped', error: 'invalid request' });
  assert.deepEqual(operation.responses[4]?.representations, []);
  assert.equal(operation.responses[5]?.representations[0]?.payloadKey, 'result');

  assert.equal(preferredResponse(operation.responses)?.status, '201');
  assert.equal(preferredResponseRepresentation(accepted.representations)?.mediaType, 'application/json');
  assert.equal(
    preferredResponseRepresentation([
      { mediaType: 'application/json', schema: null },
      { mediaType: 'text/plain', schema: {} },
    ])?.mediaType,
    'text/plain',
  );
  assert.equal(
    preferredResponseRepresentation([
      { mediaType: 'text/plain', schema: null },
      { mediaType: 'application/problem+json', schema: null },
    ])?.mediaType,
    'application/problem+json',
  );
  const payload = responsePayloadSchema(acceptedJson);
  assert.equal(payload.isArray, true);
  assert.equal(payload.schema?.children?.[0]?.name, 'id');
  assert.deepEqual(['100', '2XX', '302', '4xx', '503', 'default'].map(classifyResponseStatus), [
    'informational',
    'success',
    'redirect',
    'client-error',
    'server-error',
    'default',
  ]);
  assert.equal(preferredResponse([{ status: '2XX' }, { status: '204' }, { status: '200' }])?.status, '200');
  assert.equal(preferredResponse([{ status: 'default' }, { status: '2xx' }])?.status, '2xx');
  assert.equal(preferredResponse([{ status: 'default' }, { status: '404' }])?.status, 'default');
});

test('collapses scalar enum unions into one enum', () => {
  const unionSpec: OpenApiDocumentSchema = {
    paths: {
      '/widgets': {
        get: {
          operationId: 'widgets_list_by_ttl',
          tags: ['Widget Management'],
          parameters: [
            {
              in: 'query',
              name: 'cache_ttl',
              schema: {
                anyOf: [
                  { type: 'number', enum: [600] },
                  { type: 'number', enum: [1800] },
                ],
              },
            },
          ],
          responses: {
            '200': {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
  const unionModel = buildDocsModel({ source: unionSpec, products: [widgetsProduct] });
  const operation = unionModel.products[0]?.sections[0]?.operations[0];
  const cacheTtl = operation?.queryParams.find((param) => param.name === 'cache_ttl');

  assert.equal(cacheTtl?.type, 'number');
  assert.deepEqual(cacheTtl?.enumValues, [600, 1800]);
  assert.equal(cacheTtl?.variants, undefined);
});

test('keeps Fern SDK property names separate from OpenAPI wire names', () => {
  const inputs: SnippetInput[] = [];
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets/{account_id}': {
        post: {
          operationId: 'widgets_create_for_account',
          tags: ['Widget Management'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['account_id'],
                  properties: {
                    account_id: {
                      type: 'number',
                      'x-fern-property-name': 'account_id_body',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({
    source,
    products: [widgetsProduct],
    snippets: (input) => {
      inputs.push(input);
      return [];
    },
  }).products[0]?.sections[0]?.operations[0];
  const property = operation && requestSchema(operation)?.children?.[0];

  assert.deepEqual(
    { name: property?.name, sdkName: property?.sdkName, apiFieldPath: property?.apiFieldPath },
    { name: 'account_id', sdkName: 'account_id_body', apiFieldPath: ['account_id'] },
  );
  assert.deepEqual(
    {
      name: inputs[0]?.op.requestBody?.representations[0]?.schema?.children?.[0]?.name,
      sdkName: inputs[0]?.op.requestBody?.representations[0]?.schema?.children?.[0]?.sdkName,
      apiFieldPath: inputs[0]?.op.requestBody?.representations[0]?.schema?.children?.[0]?.apiFieldPath,
    },
    { name: 'account_id', sdkName: 'account_id_body', apiFieldPath: ['account_id'] },
  );
});

test('applies Fern ignore to inherited parameters, schemas, properties, and examples', () => {
  const source: OpenApiDocumentSchema = {
    components: {
      parameters: {
        InternalBase: { name: 'internal', in: 'query', schema: { type: 'string' } },
        Internal: { $ref: '#/components/parameters/InternalBase', 'x-fern-ignore': true },
      },
      schemas: {
        Hidden: {
          type: 'object',
          'x-fern-ignore': true,
          properties: { value: { type: 'string' } },
        },
      },
    },
    paths: {
      '/widgets': {
        parameters: [{ name: 'mode', in: 'query', schema: { type: 'string' } }],
        post: {
          operationId: 'widgets_create_visible',
          tags: ['Widget Management'],
          parameters: [
            { name: 'mode', in: 'query', 'x-fern-ignore': true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/Internal' },
          ],
          'x-fern-examples': [
            {
              'query-parameters': { mode: 'hidden', internal: 'hidden' },
              request: { visible: 'request', secret: 'hidden' },
              response: { body: { visible: 'response', secret: 'hidden' } },
            },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['visible', 'secret'],
                  example: { visible: 'request', secret: 'hidden' },
                  properties: {
                    visible: { type: 'string' },
                    secret: { type: 'string', 'x-fern-ignore': true },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      visible: { type: 'string' },
                      secret: { type: 'string', 'x-fern-ignore': true },
                    },
                  },
                  example: { visible: 'response', secret: 'hidden' },
                },
              },
            },
            '204': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Hidden' } } } },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.deepEqual(operation.queryParams, []);
  assert.deepEqual(
    requestSchema(operation)?.children?.map(({ name }) => name),
    ['visible'],
  );
  assert.deepEqual(
    operation.responses[0]?.representations[0]?.schema?.children?.map(({ name }) => name),
    ['visible'],
  );
  assert.deepEqual(operation.responses[0]?.representations[0]?.examples, [{ value: { visible: 'response' } }]);
  assert.equal(operation.responses[1]?.representations[0]?.schema, null);
  assert.deepEqual(operation.examples, [
    {
      request: { queryParameters: {}, body: { visible: 'request' } },
      response: { body: { visible: 'response' } },
      codeSamples: [],
    },
  ]);
});

test('prunes ignored union fields without truncating deeply nested authored examples', () => {
  const deepValue = {
    level1: { level2: { level3: { level4: { level5: { level6: { level7: { retained: 'value' } } } } } } },
  };
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgets_create_deep_example',
          tags: ['Widget Management'],
          'x-fern-examples': [{ request: { choice: { visible: 'yes', secret: 'hidden' }, deep: deepValue } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    choice: {
                      oneOf: [
                        {
                          type: 'object',
                          properties: {
                            visible: { type: 'string' },
                            secret: { type: 'string', 'x-fern-ignore': true },
                          },
                        },
                        { type: 'object', properties: { visible: { type: 'string' } } },
                      ],
                    },
                    deep: {
                      type: 'object',
                      properties: {
                        level1: {
                          type: 'object',
                          properties: {
                            level2: {
                              type: 'object',
                              properties: {
                                level3: {
                                  type: 'object',
                                  properties: {
                                    level4: {
                                      type: 'object',
                                      properties: {
                                        level5: {
                                          type: 'object',
                                          properties: {
                                            level6: {
                                              type: 'object',
                                              properties: {
                                                level7: {
                                                  type: 'object',
                                                  properties: { retained: { type: 'string' } },
                                                },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0];

  assert.deepEqual(operation?.examples?.[0]?.request?.body, {
    choice: { visible: 'yes' },
    deep: deepValue,
  });
});

test('retains non-JSON media types on associated example bodies', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgets_upload_example',
          tags: ['Widget Management'],
          'x-fern-examples': [{ request: 'plain request', response: { body: '%PDF-response' } }],
          requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
          responses: {
            '200': { content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0];

  assert.deepEqual(operation?.examples, [
    {
      request: { body: 'plain request', bodyMediaType: 'text/plain' },
      response: { body: '%PDF-response', mediaType: 'application/pdf' },
      codeSamples: [],
    },
  ]);
});

test('retains Fern enum descriptions and per-value deprecation on wire values', () => {
  const source: OpenApiDocumentSchema = {
    components: {
      schemas: {
        StateBase: {
          type: 'string',
          enum: ['active', 'retired'],
          'x-fern-enum': { active: { description: 'Base description.' } },
        },
        StateAlias: {
          $ref: '#/components/schemas/StateBase',
          'x-fern-enum': { retired: { description: 'Use `active` instead.', deprecated: true } },
        },
      },
    },
    paths: {
      '/widgets': {
        get: {
          operationId: 'widgets_list_by_state',
          tags: ['Widget Management'],
          parameters: [
            {
              name: 'state',
              in: 'query',
              schema: {
                $ref: '#/components/schemas/StateAlias',
                'x-fern-enum': {
                  active: { description: 'Currently **available**.', name: 'Active' },
                  unknown: { description: 'Not an allowed value.' },
                },
              },
            },
          ],
        },
      },
    },
  };
  const state = buildDocsModel({ source, products: [widgetsProduct] }).products[0]?.sections[0]?.operations[0]
    ?.queryParams[0];

  assert.deepEqual(state?.enumValues, ['active', 'retired']);
  assert.deepEqual(state?.enumValueMetadata, [
    { value: 'active', description: 'Currently **available**.' },
    { value: 'retired', description: 'Use `active` instead.', deprecated: true },
  ]);
});

test('normalizes associated Fern examples without mixing them with generated snippets or native examples', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets/{widget_id}': {
        post: {
          operationId: 'widgets_create_example',
          tags: ['Widget Management'],
          'x-fern-examples': [
            {
              name: 'Create a widget',
              'path-parameters': { widget_id: 'widget-1' },
              'query-parameters': { dry_run: false },
              headers: { 'X-Trace': 'trace-1' },
              request: { enabled: true },
              response: { body: { id: 'widget-1' } },
              'code-samples': [
                { sdk: 'nodets', code: 'await client.widgets.create();' },
                { language: 'Elixir', install: 'mix deps.get', code: 'Widgets.create()' },
              ],
            },
          ],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const operation = buildDocsModel({ source, products: [widgetsProduct], snippets: fixtureSnippets }).products[0]
    ?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.deepEqual(operation.examples, [
    {
      name: 'Create a widget',
      request: {
        pathParameters: { widget_id: 'widget-1' },
        queryParameters: { dry_run: false },
        headers: { 'X-Trace': 'trace-1' },
        body: { enabled: true },
      },
      response: { body: { id: 'widget-1' } },
      codeSamples: [
        { kind: 'sdk', sdk: 'typescript', code: 'await client.widgets.create();' },
        { kind: 'language', language: 'Elixir', install: 'mix deps.get', code: 'Widgets.create()' },
      ],
    },
  ]);
  assert.equal(operation.responses[0]?.representations[0]?.generatedExample, undefined);
  assert.equal(operation.snippets.length, 2);
});

test('preserves titles on unnamed union variants', () => {
  const unionSpec: OpenApiDocumentSchema = {
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgets_create_variant',
          tags: ['Widget Management'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      title: 'Hosted Widget',
                      type: 'object',
                      properties: { domain: { type: 'string' } },
                    },
                    {
                      title: 'Bookmark Widget',
                      type: 'object',
                      properties: { url: { type: 'string' } },
                    },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
  const unionModel = buildDocsModel({ source: unionSpec, products: [widgetsProduct] });
  const operation = unionModel.products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  const variants = requestSchema(operation)?.variants;

  assert.deepEqual(
    variants?.map(({ title, type }) => ({ title, type })),
    [
      { title: 'Hosted Widget', type: 'object' },
      { title: 'Bookmark Widget', type: 'object' },
    ],
  );
});

test('resolves referenced request bodies and responses from components', () => {
  const referencedSpec: OpenApiDocumentSchema = {
    components: {
      requestBodies: {
        WidgetInputAlias: { $ref: '#/components/requestBodies/WidgetInput' },
        WidgetInput: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['settings'],
                properties: {
                  settings: {
                    type: 'object',
                    required: ['enabled'],
                    properties: { enabled: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        WidgetResponseAlias: { $ref: '#/components/responses/WidgetResponse' },
        WidgetResponse: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
      },
    },
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgets_create',
          tags: ['Widget Management'],
          requestBody: { $ref: '#/components/requestBodies/WidgetInputAlias' },
          responses: { '201': { $ref: '#/components/responses/WidgetResponseAlias' } },
        },
      },
    },
  };

  const referenced = buildDocsModel({ source: referencedSpec, products: [widgetsProduct] });
  const operation = referenced.products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.ok(operation.requestBody);
  assert.equal(requestSchema(operation)?.children?.[0]?.name, 'settings');
  assert.equal(requestSchema(operation)?.children?.[0]?.children?.[0]?.name, 'enabled');
  const response = operation.responses[0];
  assert.equal(response?.status, '201');
  assert.equal(response?.representations[0]?.schema?.children?.[0]?.name, 'id');
  assert.deepEqual(response?.representations[0]?.generatedExample, { id: 'id' });
});

test('cyclic request-body and response references stop safely', () => {
  const cyclicSpec: OpenApiDocumentSchema = {
    components: {
      requestBodies: {
        First: { $ref: '#/components/requestBodies/Second' },
        Second: { $ref: '#/components/requestBodies/First' },
      },
      responses: {
        First: { $ref: '#/components/responses/Second' },
        Second: { $ref: '#/components/responses/First' },
      },
    },
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgets_create',
          tags: ['Widget Management'],
          requestBody: { $ref: '#/components/requestBodies/First' },
          responses: { '200': { $ref: '#/components/responses/First' } },
        },
      },
    },
  };

  const cyclic = buildDocsModel({ source: cyclicSpec, products: [widgetsProduct] });
  const operation = cyclic.products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.deepEqual(operation.requestBody, { required: false, representations: [] });
  assert.deepEqual(operation.responses, [{ status: '200', description: '', representations: [] }]);
});

test('snippet inputs preserve root array and union request bodies', () => {
  const rootBodies: OpenApiDocumentSchema = {
    paths: {
      '/widgets/batch': {
        post: {
          operationId: 'widgets_batch',
          tags: ['Widget Management'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/widgets/import': {
        post: {
          operationId: 'widgets_import',
          tags: ['Widget Management'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['source'],
                      properties: { source: { type: 'string' } },
                    },
                    { type: 'string' },
                  ],
                },
              },
            },
          },
        },
      },
    },
  };
  const inputs = new Map<string, unknown>();
  buildDocsModel({
    source: rootBodies,
    products: [widgetsProduct],
    snippets: ({ op }) => {
      inputs.set(op.path, op.requestBody);
      return [];
    },
  });

  assert.deepEqual(inputs.get('/widgets/batch'), {
    required: true,
    representations: [
      {
        mediaType: 'application/json',
        schema: {
          name: '',
          required: true,
          type: 'object[]',
          items: {
            name: '',
            required: false,
            type: 'object',
            children: [{ name: 'id', required: true, type: 'string' }],
          },
        },
      },
    ],
  });
  assert.deepEqual(inputs.get('/widgets/import'), {
    required: true,
    representations: [
      {
        mediaType: 'application/json',
        schema: {
          name: '',
          required: true,
          type: 'object | string',
          variants: [
            {
              name: '',
              required: false,
              type: 'object',
              children: [{ name: 'source', required: true, type: 'string' }],
            },
            { name: '', required: false, type: 'string' },
          ],
        },
      },
    ],
  });
});

test('omitting a snippet provider yields no snippets', () => {
  const bare = buildDocsModel({ source: widgetsSpec, products: [widgetsProduct] });
  const update = bare.products[0]?.sections[0]?.operations.find(
    (operation) => operation.operationId === 'widgets_update',
  );
  assert.deepEqual(update?.snippets, []);
});

test('the visibility policy omits operations before snippet rendering', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/widgets/hidden': {
        get: {
          operationId: 'widgets_hidden',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'hidden',
          'x-test-hidden': true,
        },
      },
      '/widgets/false-value': {
        get: {
          operationId: 'widgets_false_value',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'falseValue',
          'x-test-hidden': false,
        },
      },
      '/widgets/string-value': {
        get: {
          operationId: 'widgets_string_value',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'stringValue',
          'x-test-hidden': 'true',
        },
      },
    },
  };
  const snippetCalls: string[] = [];
  const visibilityModel = buildDocsModel({
    source,
    products: [widgetsProduct],
    isOperationHidden: (operation) => operation['x-test-hidden'] === true,
    snippets: ({ methodName }) => {
      snippetCalls.push(methodName);
      return [];
    },
  });

  assert.deepEqual(
    visibilityModel.products[0]?.sections[0]?.operations.map((operation) => operation.operationId),
    ['widgets_false_value', 'widgets_string_value'],
  );
  assert.deepEqual(snippetCalls.sort(), ['falseValue', 'stringValue']);
});

test('a custom formatIdentifier overrides product titles without changing section labels', () => {
  const upper = buildDocsModel({
    source: widgetsSpec,
    products: [widgetsProduct],
    formatIdentifier: (identifier) => identifier.toUpperCase(),
  });
  const product = upper.products[0];
  const section = product?.sections[0];
  assert.ok(product && section);
  assert.equal(product.title, 'WIDGETS');
  assert.equal(section.title, 'Widget Management');
});

test('products without sdkGroup use manifest section IDs and operationIds in routes', () => {
  const all = ops();
  assert.equal(all.length, 1);
  const operation = all[0];
  assert.ok(operation);
  assert.equal(operation.slug, 'sections/management/operations/widgets-update');
  assert.equal(
    operation.snippets.find((snippet) => snippet.targetId === 'python')?.code,
    'client.widgets.items.update()',
  );
});

test('SDK metadata does not affect routes for products without sdkGroup', () => {
  const changed: OpenApiDocumentSchema = structuredClone(widgetsSpec);
  const patch = changed.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(patch);
  patch['x-fern-sdk-group-name'] = ['different', 'sdk', 'shape'];
  patch['x-fern-sdk-method-name'] = 'renamed-method';
  const changedModel = buildDocsModel({ source: changed, products: [widgetsProduct], snippets: fixtureSnippets });
  const operation = changedModel.products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.equal(operation.slug, 'sections/management/operations/widgets-update');
  assert.equal(
    operation.snippets.find((snippet) => snippet.targetId === 'python')?.code,
    'client.different.sdk.shape.renamed-method()',
  );
});

const sdkProduct = {
  id: 'zero-trust',
  sdkGroup: 'zero_trust',
  sections: [{ id: 'devices', tag: 'Devices' }],
};

const routingPriorityExtension = defineFernExtension({
  name: 'test-routing-priority',
  schema: unknownRecordSchema,
  operation({ operation }) {
    const priority = operation['x-test-routing-priority'];
    return typeof priority === 'number'
      ? { data: { priority }, presentation: { routingPriority: priority } }
      : undefined;
  },
});

test('SDK products derive resource and method routes from the full Fern SDK address', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/devices': {
        get: {
          operationId: 'devices_list',
          tags: ['Devices'],
          'x-fern-sdk-group-name': 'zero_trust.devices.ip_profiles',
          'x-fern-sdk-method-name': 'listAll',
        },
      },
    },
  };
  const sdk = buildDocsModel({ source, products: [sdkProduct] });
  const product = sdk.products[0];
  const operation = product?.sections[0]?.operations[0];
  assert.ok(product && operation);
  assert.equal(product.slug, 'zero-trust');
  assert.equal(operation.slug, 'devices/ip-profiles/methods/list-all');
  assert.deepEqual(operation.placement, {
    projectionId: 'primary',
    resourcePath: [
      { id: 'devices', slug: 'devices', title: 'Devices' },
      { id: 'ip_profiles', slug: 'ip-profiles', title: 'Ip Profiles' },
    ],
    method: { id: 'listAll', slug: 'list-all' },
  });
});

test('SDK aliases in the same product generate independent placements', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/devices': {
        get: {
          operationId: 'devices_list',
          tags: ['Devices'],
          'x-fern-sdk-group-name': 'zero_trust.devices',
          'x-fern-sdk-method-name': 'list',
          'x-test-aliases': [
            {
              'x-fern-sdk-group-name': ['zero_trust', 'device_settings'],
              'x-fern-sdk-method-name': 'listAll',
            },
          ],
        },
      },
    },
  };
  const sdk = buildDocsModel({ source, products: [sdkProduct], extensions: [fixtureExtension] });
  assert.deepEqual(
    sdk.products[0]?.sections[0]?.operations.map((operation) => ({
      projection: operation.placement?.projectionId,
      slug: operation.slug,
    })),
    [
      { projection: 'primary', slug: 'devices/methods/list' },
      { projection: 'fixture:alias-1', slug: 'device-settings/methods/list-all' },
    ],
  );
});

test('SDK route collisions keep one preferred projection and suppress ambiguous ties', () => {
  const source = (priorities: [number, number]): OpenApiDocumentSchema => ({
    paths: Object.fromEntries(
      priorities.map((priority, index) => [
        `/devices/${index}`,
        {
          get: {
            operationId: `devices_list_${index}`,
            tags: ['Devices'],
            'x-fern-sdk-group-name': 'zero_trust.devices',
            'x-fern-sdk-method-name': 'list',
            'x-test-routing-priority': priority,
          },
        },
      ]),
    ),
  });
  const preferredWarnings: string[] = [];
  const preferred = buildDocsModel({
    source: source([-1, 0]),
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    onWarning: (warning) => preferredWarnings.push(warning),
  });
  assert.deepEqual(
    preferred.products[0]?.sections[0]?.operations.map((operation) => operation.operationId),
    ['devices_list_1'],
  );
  assert.deepEqual(preferredWarnings, []);

  const tiedWarnings: string[] = [];
  const tied = buildDocsModel({
    source: source([0, 0]),
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    onWarning: (warning) => tiedWarnings.push(warning),
  });
  assert.deepEqual(tied.products, []);
  assert.equal(tiedWarnings.length, 1);
  assert.match(
    tiedWarnings[0] ?? '',
    /Result: no page was generated because 2 mappings remained tied after applying extension routing priorities/,
  );
  assert.match(tiedWarnings[0] ?? '', /Fix: give each operation a unique x-fern-sdk-group-name/);
});

test('consumer routing preference breaks only extension-priority ties', () => {
  const source = (accountPriority: number, zonePriority: number): OpenApiDocumentSchema => ({
    paths: {
      '/accounts/{account_id}/devices': {
        get: {
          operationId: 'account_devices_list',
          tags: ['Devices'],
          'x-fern-sdk-group-name': 'zero_trust.devices',
          'x-fern-sdk-method-name': 'list',
          'x-test-routing-priority': accountPriority,
        },
      },
      '/zones/{zone_id}/devices': {
        get: {
          operationId: 'zone_devices_list',
          tags: ['Devices'],
          'x-fern-sdk-group-name': 'zero_trust.devices',
          'x-fern-sdk-method-name': 'list',
          'x-test-routing-priority': zonePriority,
        },
      },
    },
  });
  const accountPreference: NonNullable<BuildOptions['operationRoutingPreference']> = ({ path }) =>
    path.startsWith('/accounts/') ? 1 : 0;

  const preferredWarnings: string[] = [];
  const preferred = buildDocsModel({
    source: source(0, 0),
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    operationRoutingPreference: accountPreference,
    onWarning: (warning) => preferredWarnings.push(warning),
  });
  assert.equal(preferred.products[0]?.sections[0]?.operations[0]?.operationId, 'account_devices_list');
  assert.deepEqual(preferredWarnings, []);

  const extensionPriorityWins = buildDocsModel({
    source: source(-1, 0),
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    operationRoutingPreference: accountPreference,
    onWarning: () => {},
  });
  assert.equal(extensionPriorityWins.products[0]?.sections[0]?.operations[0]?.operationId, 'zone_devices_list');

  const tiedWarnings: string[] = [];
  const tied = buildDocsModel({
    source: source(0, 0),
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    operationRoutingPreference: () => 1,
    onWarning: (warning) => tiedWarnings.push(warning),
  });
  assert.deepEqual(tied.products, []);
  assert.match(
    tiedWarnings[0] ?? '',
    /2 mappings remained tied after applying extension routing priorities and the configured operation routing preference/,
  );

  assert.throws(
    () =>
      buildDocsModel({
        source: source(0, 0),
        products: [sdkProduct],
        extensions: [routingPriorityExtension],
        operationRoutingPreference: () => Number.NaN,
      }),
    /operation routing preference .* must be a finite number/,
  );
});

test('a unique low-priority SDK operation remains documented', () => {
  const warnings: string[] = [];
  const sdk = buildDocsModel({
    source: {
      paths: {
        '/devices': {
          get: {
            operationId: 'devices_list',
            tags: ['Devices'],
            'x-fern-sdk-group-name': 'zero_trust.devices',
            'x-fern-sdk-method-name': 'list',
            'x-test-routing-priority': -1,
          },
        },
      },
    },
    products: [sdkProduct],
    extensions: [routingPriorityExtension],
    onWarning: (warning) => warnings.push(warning),
  });
  assert.equal(sdk.products[0]?.sections[0]?.operations[0]?.operationId, 'devices_list');
  assert.deepEqual(warnings, []);
});

test('product path ownership and section tags are independent of SDK metadata', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/accounts/{account_id}/items': {
        get: {
          operationId: 'account_operation',
          tags: ['Shared'],
          'x-fern-sdk-group-name': 42,
        },
      },
      '/zones/{zone_id}/hidden': {
        get: {
          operationId: 'hidden_zone_operation',
          tags: ['Shared'],
          'x-fern-sdk-group-name': 42,
          'x-test-hidden': true,
        },
      },
      '/zones/{zone_id}/items': {
        get: {
          operationId: 'zone_operation',
          tags: ['Shared'],
          'x-fern-sdk-method-name': 'sdkOnlyName',
        },
      },
    },
  };
  let snippetAccessor: string[] | undefined;
  const owned = buildDocsModel({
    source,
    products: [{ id: 'zones', pathPrefixes: ['/zones'], sections: [{ id: 'shared', tag: 'Shared' }] }],
    isOperationHidden: (operation) => operation['x-test-hidden'] === true,
    snippets: ({ accessorPath }) => {
      snippetAccessor = accessorPath;
      return [];
    },
  });
  const operations = owned.products[0]?.sections[0]?.operations;
  assert.ok(operations);

  assert.deepEqual(
    operations.map((operation) => operation.operationId),
    ['zone_operation'],
  );
  assert.equal(operations[0]?.title, 'Zone Operation');
  assert.deepEqual(snippetAccessor, []);
});

test('path ownership disambiguates a tag shared by multiple products', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/accounts/{account_id}/settings': {
        get: { operationId: 'account_settings', tags: ['Settings'] },
      },
      '/zones/{zone_id}/settings': {
        get: { operationId: 'zone_settings', tags: ['Settings'] },
      },
    },
  };
  const scoped = buildDocsModel({
    source,
    products: [
      { id: 'accounts', pathPrefixes: ['/accounts'], sections: [{ id: 'settings', tag: 'Settings' }] },
      { id: 'zones', pathPrefixes: ['/zones'], sections: [{ id: 'settings', tag: 'Settings' }] },
    ],
  });

  assert.deepEqual(
    scoped.products.map((product) => {
      const section = product.sections[0];
      assert.ok(section);
      return {
        product: product.name,
        operations: section.operations.map((operation) => operation.operationId),
      };
    }),
    [
      { product: 'accounts', operations: ['account_settings'] },
      { product: 'zones', operations: ['zone_settings'] },
    ],
  );
});

test('an operation cannot belong to multiple configured tag sections', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/ambiguous': {
        get: {
          operationId: 'ambiguous',
          tags: ['First', 'Second'],
          'x-fern-sdk-method-name': 'get',
        },
      },
    },
  };
  assert.throws(
    () =>
      buildDocsModel({
        source,
        products: [
          {
            id: 'example',
            sections: [
              { id: 'first', tag: 'First' },
              { id: 'second', tag: 'Second' },
            ],
          },
        ],
      }),
    /operation "ambiguous" matches more than one configured section/,
  );
});

test('tag ownership supports root SDK methods and product IDs unrelated to SDK groups', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/send': {
        post: {
          operationId: 'send-message',
          summary: 'Send message',
          tags: ['Messages'],
          'x-fern-sdk-method-name': 'send',
        },
      },
    },
  };
  let accessorPath: string[] | undefined;
  const root = buildDocsModel({
    source,
    products: [{ id: 'communications', sections: [{ id: 'messages', tag: 'Messages' }] }],
    snippets: (input) => {
      accessorPath = input.accessorPath;
      return [];
    },
  });
  const operation = root.products[0]?.sections[0]?.operations[0];
  assert.ok(operation);
  assert.deepEqual(accessorPath, []);
  assert.equal(operation.slug, 'sections/messages/operations/send-message');
});

// --- loadOpenApiDocument / openApiDocumentSchema ---

function withTempFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'astro-fern-'));
  try {
    const file = join(dir, 'openapi.json');
    writeFileSync(file, contents);
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openApiDocumentSchema accepts a minimal and an empty document', () => {
  assert.equal(openApiDocumentSchema.safeParse({ paths: {} }).success, true);
  assert.equal(openApiDocumentSchema.safeParse({}).success, true);
});

test('parseOpenApiDocument validates without replacing source identities', () => {
  const operation = { operationId: 'getWidget', responses: {} };
  const source = { paths: { '/widgets/{id}': { get: operation } } };

  const parsed = parseOpenApiDocument(source);

  assert.equal(parsed, source);
  assert.equal(parsed.paths?.['/widgets/{id}']?.get, operation);
});

test('openApiDocumentSchema passes unmodeled top-level fields through untouched', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    'x-vendor': { anything: true },
    paths: { '/widgets': { get: { operationId: 'listWidgets' } } },
    components: { schemas: { Widget: { type: 'object' } } },
  };
  const result = openApiDocumentSchema.safeParse(doc);
  assert.equal(result.success, true);
  assert.deepEqual(result.data, doc);
});

test('openApiDocumentSchema validates consumed nested fields and preserves nested extensions', () => {
  const valid = openApiDocumentSchema.parse({
    paths: {
      '/widgets': {
        'x-path-extension': { enabled: true },
        get: {
          operationId: 'listWidgets',
          tags: ['Widgets'],
          'x-operation-extension': { enabled: true },
        },
      },
    },
  });
  assert.deepEqual(valid.paths?.['/widgets']?.['x-path-extension'], { enabled: true });
  assert.deepEqual(valid.paths?.['/widgets']?.get?.['x-operation-extension'], { enabled: true });

  const invalid = openApiDocumentSchema.safeParse({
    paths: { '/widgets': { get: { operationId: 'listWidgets', tags: 42 } } },
  });
  assert.ok(
    !invalid.success && invalid.error.issues.some((issue) => issue.path.join('.') === 'paths./widgets.get.tags'),
  );
});

test('openApiDocumentSchema rejects non-object roots (valid JSON, wrong shape)', () => {
  for (const bad of [[], 42, 'x', null, true]) {
    assert.equal(openApiDocumentSchema.safeParse(bad).success, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('openApiDocumentSchema rejects non-object paths/components and reports the field path', () => {
  const badPaths = openApiDocumentSchema.safeParse({ paths: [] });
  assert.ok(!badPaths.success && badPaths.error.issues.some((issue) => issue.path[0] === 'paths'));

  const badComponents = openApiDocumentSchema.safeParse({ components: 3 });
  assert.ok(!badComponents.success && badComponents.error.issues.some((issue) => issue.path[0] === 'components'));
});

test('loadOpenApiDocument returns the parsed document for a valid file', () => {
  const doc = { openapi: '3.0.3', paths: { '/x': { get: { operationId: 'x' } } } };
  withTempFile(JSON.stringify(doc), (file) => {
    assert.deepEqual(loadOpenApiDocument(file), doc);
  });
});

test('loadOpenApiDocument throws a distinct error for invalid JSON', () => {
  withTempFile('{ not json', (file) => {
    assert.throws(() => loadOpenApiDocument(file), /not valid JSON/);
  });
});

test('loadOpenApiDocument throws a shape error for valid JSON that is not a document', () => {
  withTempFile('[]', (file) => {
    assert.throws(() => loadOpenApiDocument(file), /not a valid OpenAPI document/);
  });
});

test('loadOpenApiDocument throws a read error for a missing file', () => {
  assert.throws(() => loadOpenApiDocument(join(tmpdir(), 'astro-fern-missing-3f9c2a.json')), /Could not read/);
});
