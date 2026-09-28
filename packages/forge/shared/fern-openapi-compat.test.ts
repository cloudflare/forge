import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ForgeOpenApiDocument } from '../init-from-openapi.ts';
import { applyFernCompatibilityFixes } from './fern-openapi-compat.ts';

function fixture(): ForgeOpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'test', version: '1' },
    paths: {},
    components: {
      parameters: {
        parentFilter: {
          in: 'query',
          name: 'parent.id',
          schema: {
            anyOf: [{ $ref: '#/components/schemas/EntityId' }, { type: 'string', enum: ['none'] }],
          },
        },
      },
      schemas: {
        EntityId: {
          type: 'string',
          example: '0123456789abcdef',
          pattern: '^[a-f0-9]+$',
        },
      },
    },
  } as ForgeOpenApiDocument;
}

function addUndiscriminatedUnionRequest(openapi: ForgeOpenApiDocument): Record<string, unknown> {
  const schema = {
    type: 'object',
    description: 'Navigate to either a URL or supplied HTML.',
    additionalProperties: false,
    properties: {
      html: { type: 'string', minLength: 1 },
      url: { type: 'string', format: 'uri' },
      viewport: {
        type: 'object',
        properties: { width: { type: 'integer', minimum: 1 } },
        required: ['width'],
      },
    },
    required: ['viewport'],
    oneOf: [
      {
        type: 'object',
        properties: {
          html: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['url'],
      },
      {
        type: 'object',
        properties: {
          html: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['html'],
      },
    ],
  };
  (openapi.paths as Record<string, unknown>)['/render'] = {
    post: {
      requestBody: {
        content: { 'application/json': { schema } },
      },
      responses: { '200': { description: 'ok' } },
    },
  };
  return schema;
}

function addMapArrayResponse(openapi: ForgeOpenApiDocument): void {
  (openapi.paths as Record<string, unknown>)['/widgets'] = {
    get: {
      operationId: 'list_widgets',
      responses: {
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  by_month: {
                    description: 'Values grouped by month.',
                    type: 'object',
                    minProperties: 1,
                    additionalProperties: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        description: 'Monthly value.',
                        properties: {
                          total: {
                            type: 'integer',
                            minimum: 0,
                          },
                        },
                        required: ['total'],
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
}

test('drops a referenced example incompatible with an anyOf literal', () => {
  const openapi = fixture();

  assert.deepEqual(applyFernCompatibilityFixes(openapi), {
    incompatibleExamples: 1,
    undiscriminatedUnionCommonProperties: 0,
    mapArrayValueSchemas: 0,
  });
  assert.deepEqual(openapi.components?.schemas?.EntityId, {
    type: 'string',
    pattern: '^[a-f0-9]+$',
  });
});

test('leaves semantically different anyOf examples unchanged', () => {
  const openapi = fixture();
  const parameters = openapi.components?.parameters;
  assert.ok(parameters);
  const parentFilter = parameters.parentFilter as unknown as {
    schema: { anyOf: Array<Record<string, unknown>> };
  };
  parentFilter.schema.anyOf.push({ type: 'null' });

  assert.deepEqual(applyFernCompatibilityFixes(openapi), {
    incompatibleExamples: 0,
    undiscriminatedUnionCommonProperties: 0,
    mapArrayValueSchemas: 0,
  });
  const schemas = openapi.components?.schemas;
  assert.ok(schemas);
  assert.equal((schemas.EntityId as { example?: unknown }).example, '0123456789abcdef');
});

test('incompatible example repair is idempotent', () => {
  const openapi = fixture();
  applyFernCompatibilityFixes(openapi);

  assert.deepEqual(applyFernCompatibilityFixes(openapi), {
    incompatibleExamples: 0,
    undiscriminatedUnionCommonProperties: 0,
    mapArrayValueSchemas: 0,
  });
});

test('distributes safe oneOf common properties into every object branch', () => {
  const openapi = fixture();
  const schema = addUndiscriminatedUnionRequest(openapi);

  const fixes = applyFernCompatibilityFixes(openapi);
  assert.equal(fixes.undiscriminatedUnionCommonProperties, 1);
  assert.equal(schema['type'], 'object');
  assert.equal(schema['description'], 'Navigate to either a URL or supplied HTML.');
  assert.equal(Object.hasOwn(schema, 'properties'), false);
  assert.equal(Object.hasOwn(schema, 'required'), false);
  assert.equal(Object.hasOwn(schema, 'additionalProperties'), false);

  const branches = schema['oneOf'] as Array<Record<string, unknown>>;
  assert.deepEqual(branches[0], {
    type: 'object',
    additionalProperties: false,
    properties: {
      html: { type: 'string', minLength: 1 },
      url: { type: 'string', format: 'uri' },
      viewport: {
        type: 'object',
        properties: { width: { type: 'integer', minimum: 1 } },
        required: ['width'],
      },
    },
    required: ['viewport', 'url'],
  });
  assert.deepEqual(branches[1]?.['required'], ['viewport', 'html']);
});

test('leaves constrained oneOf property intersections unchanged', () => {
  const openapi = fixture();
  const schema = addUndiscriminatedUnionRequest(openapi);
  const branches = schema['oneOf'] as Array<{
    properties: Record<string, unknown>;
  }>;
  const firstBranch = branches[0];
  assert.ok(firstBranch);
  firstBranch.properties['url'] = { type: 'string', minLength: 5 };

  const fixes = applyFernCompatibilityFixes(openapi);
  assert.equal(fixes.undiscriminatedUnionCommonProperties, 0);
  assert.equal((schema['properties'] as Record<string, Record<string, unknown>>)['url']?.['format'], 'uri');
  assert.equal(Object.hasOwn(firstBranch, 'additionalProperties'), false);
});

test('undiscriminated oneOf repair is idempotent', () => {
  const openapi = fixture();
  addUndiscriminatedUnionRequest(openapi);
  applyFernCompatibilityFixes(openapi);

  assert.deepEqual(applyFernCompatibilityFixes(openapi), {
    incompatibleExamples: 0,
    undiscriminatedUnionCommonProperties: 0,
    mapArrayValueSchemas: 0,
  });
});

test('extracts map-of-array values without dropping nested constraints', () => {
  const openapi = fixture();
  addMapArrayResponse(openapi);
  const baseName = 'FernCompatibilityListWidgetsResponse200ApplicationJsonByMonthMapValue';
  const schemas = openapi.components?.schemas;
  assert.ok(schemas);
  schemas[baseName] = { type: 'string' };

  const fixes = applyFernCompatibilityFixes(openapi);
  assert.equal(fixes.mapArrayValueSchemas, 1);

  const operation = (openapi.paths as Record<string, Record<string, unknown>>)['/widgets']?.['get'] as {
    responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
  };
  const properties = operation.responses['200']?.content['application/json']?.schema['properties'] as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(properties['by_month'], {
    description: 'Values grouped by month.',
    type: 'object',
    minProperties: 1,
    additionalProperties: {
      $ref: `#/components/schemas/${baseName}2`,
    },
  });
  assert.deepEqual(schemas[baseName], { type: 'string' });
  assert.deepEqual(schemas[`${baseName}2`], {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      description: 'Monthly value.',
      properties: { total: { type: 'integer', minimum: 0 } },
      required: ['total'],
    },
  });
});

test('map-of-array repair is idempotent', () => {
  const openapi = fixture();
  addMapArrayResponse(openapi);
  applyFernCompatibilityFixes(openapi);

  assert.deepEqual(applyFernCompatibilityFixes(openapi), {
    incompatibleExamples: 0,
    undiscriminatedUnionCommonProperties: 0,
    mapArrayValueSchemas: 0,
  });
});
