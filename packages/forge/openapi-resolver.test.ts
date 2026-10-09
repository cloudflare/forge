import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Forge } from './forge.ts';
import { populateOperationMap, resolveOperation } from './openapi-resolver.ts';

test('response metadata preserves inline and referenced headers', () => {
  populateOperationMap({
    paths: {
      '/uploads': {
        post: {
          operationId: 'create-upload',
          responses: {
            '201': { $ref: '#/components/responses/UploadCreated' },
            '204': { description: 'No content' },
          },
        },
      },
    },
    components: {
      schemas: { UploadUrl: { type: 'string', format: 'uri' } },
      headers: {
        UploadLocation: {
          description: 'Upload URL',
          required: true,
          schema: { $ref: '#/components/schemas/UploadUrl' },
        },
      },
      responses: {
        UploadCreated: {
          description: 'Created',
          headers: {
            Location: { $ref: '#/components/headers/UploadLocation' },
            'Upload-Version': { schema: { type: 'string' } },
          },
        },
      },
    },
  });

  const operation = resolveOperation('create-upload');
  assert.ok(operation);
  assert.deepEqual(operation.responses['201'], {
    description: 'Created',
    content: {},
    headers: {
      Location: {
        description: 'Upload URL',
        required: true,
        schema: { type: 'string', format: 'uri' },
      },
      'Upload-Version': { schema: { type: 'string' } },
    },
  });
  assert.deepEqual(operation.responses['204'], { description: 'No content', content: {} });
});

test('parameter metadata separates resolved type from schema identity', () => {
  populateOperationMap({
    paths: {
      '/zones/{zone_id}': {
        get: {
          operationId: 'get-zone',
          parameters: [
            {
              name: 'zone_id',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/ZoneIdentifierAlias' },
            },
            {
              name: 'numeric_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'statuses',
              in: 'query',
              schema: { type: 'array', items: { type: 'string', enum: ['active', 'pending'] } },
            },
            {
              name: 'alias',
              in: 'path',
              required: true,
              schema: {
                oneOf: [{ $ref: '#/components/schemas/ZoneIdentifier' }, { type: 'string' }],
              },
            },
            {
              name: 'exampleOnly',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/ExampleOnly' },
            },
            {
              name: 'status',
              in: 'query',
              schema: { $ref: '#/components/schemas/Status' },
            },
            {
              name: 'missing',
              in: 'query',
              schema: { $ref: '#/components/schemas/Missing' },
            },
            {
              name: 'cycle',
              in: 'query',
              schema: { $ref: '#/components/schemas/CycleA' },
            },
          ],
        },
      },
    },
    components: {
      schemas: {
        ZoneIdentifier: {
          type: 'string',
          description: 'Zone identifier.',
        },
        ZoneIdentifierAlias: {
          allOf: [{ $ref: '#/components/schemas/ZoneIdentifier' }, { readOnly: true, type: 'string' }],
        },
        ExampleOnly: { example: 'identifier' },
        Status: {
          type: 'string',
          enum: ['active', 'pending'],
        },
        CycleA: { $ref: '#/components/schemas/CycleB' },
        CycleB: { $ref: '#/components/schemas/CycleA' },
      },
    },
  });

  const operation = resolveOperation('get-zone');
  assert.ok(operation);
  assert.deepEqual(operation.pathParams[0], {
    name: 'zone_id',
    required: true,
    type: 'string',
    schemaRef: 'ZoneIdentifierAlias',
    description: 'Zone identifier.',
  });
  assert.deepEqual(operation.pathParams.slice(1), [
    { name: 'numeric_id', required: true, type: 'string' },
    { name: 'alias', required: true, type: 'string', composed: true, description: 'Zone identifier.' },
    { name: 'exampleOnly', required: true, type: 'string', schemaRef: 'ExampleOnly' },
  ]);
  assert.deepEqual(operation.queryParams, [
    {
      name: 'tags',
      required: false,
      type: 'array',
      itemType: 'string',
    },
    {
      name: 'statuses',
      required: false,
      type: 'array',
      itemType: 'string',
      itemEnumValues: ['active', 'pending'],
    },
    {
      name: 'status',
      required: false,
      type: 'string',
      schemaRef: 'Status',
      enumValues: ['active', 'pending'],
    },
    {
      name: 'missing',
      required: false,
      type: 'unknown',
      schemaRef: 'Missing',
    },
    {
      name: 'cycle',
      required: false,
      type: 'unknown',
      schemaRef: 'CycleA',
    },
  ]);
});

test('path-item parameters are inherited and operation parameters override them', () => {
  populateOperationMap({
    paths: {
      '/zones/{zone_id}/items': {
        parameters: [
          {
            name: 'zone_id',
            in: 'path',
            required: true,
            schema: { $ref: '#/components/schemas/ZoneIdentifier' },
          },
          {
            name: 'page',
            in: 'query',
            schema: { type: 'number' },
          },
        ],
        get: {
          operationId: 'list-items',
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string' },
            },
          ],
        },
      },
    },
    components: {
      schemas: {
        ZoneIdentifier: { type: 'string' },
      },
    },
  });

  const operation = resolveOperation('list-items');
  assert.ok(operation);
  assert.deepEqual(operation.pathParams, [
    {
      name: 'zone_id',
      required: true,
      type: 'string',
      schemaRef: 'ZoneIdentifier',
    },
  ]);
  assert.deepEqual(operation.queryParams, [
    {
      name: 'page',
      required: true,
      type: 'string',
    },
    {
      name: 'status',
      required: false,
      type: 'string',
    },
  ]);
});

test('object array body params are exposed as JSON-valued array parameters', () => {
  populateOperationMap({
    paths: {
      '/deployments': {
        post: {
          operationId: 'create-deployment',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    versions: {
                      type: 'array',
                      description: 'Deployment versions as JSON.',
                      'x-sensitive': true,
                      items: {
                        type: 'object',
                        properties: {
                          version_id: { type: 'string' },
                          percentage: { type: 'number' },
                          metadata: {
                            type: 'object',
                            properties: { message: { type: 'string' } },
                          },
                        },
                      },
                    },
                    tags: { type: 'array', items: { type: 'string' } },
                    union_versions: {
                      type: 'array',
                      items: {
                        oneOf: [
                          { type: 'object', properties: { version_id: { type: 'string' } } },
                          { type: 'object', properties: { percentage: { type: 'number' } } },
                        ],
                      },
                    },
                    composed_versions: {
                      type: 'array',
                      items: {
                        allOf: [
                          { type: 'object', properties: { version_id: { type: 'string' } } },
                          { type: 'object', properties: { percentage: { type: 'number' } } },
                        ],
                      },
                    },
                    version_matrix: {
                      type: 'array',
                      items: {
                        type: 'array',
                        items: { type: 'object', properties: { version_id: { type: 'string' } } },
                      },
                    },
                  },
                  required: ['versions'],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-deployment');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: true,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions as JSON.',
      sensitive: true,
      apiFieldPath: ['versions'],
    },
    {
      name: 'tags',
      required: false,
      type: 'array',
      apiFieldPath: ['tags'],
    },
    {
      name: 'union-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['union_versions'],
    },
    {
      name: 'composed-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['composed_versions'],
    },
  ]);
});

test('object array body params resolve refs only for arrays directly under the body root', () => {
  populateOperationMap({
    paths: {
      '/rollouts': {
        post: {
          operationId: 'create-rollout',
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateRollout' },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateRollout: {
          type: 'object',
          properties: {
            versions: { $ref: '#/components/schemas/Versions' },
            optional_versions: { $ref: '#/components/schemas/Versions' },
            rollout: { $ref: '#/components/schemas/Rollout' },
            version_matrix: {
              type: 'array',
              items: { $ref: '#/components/schemas/Versions' },
            },
          },
          required: ['versions', 'rollout'],
        },
        Rollout: {
          type: 'object',
          properties: {
            nested_versions: { $ref: '#/components/schemas/Versions' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['nested_versions'],
        },
        Versions: {
          type: 'array',
          description: 'Deployment versions.',
          items: { $ref: '#/components/schemas/Version' },
        },
        Version: {
          type: 'object',
          properties: {
            version_id: { type: 'string' },
            percentage: { type: 'number' },
          },
        },
      },
    },
  });

  const operation = resolveOperation('create-rollout');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: true,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions.',
      apiFieldPath: ['versions'],
    },
    {
      name: 'optional-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions.',
      apiFieldPath: ['optional_versions'],
    },
    {
      name: 'rollout-labels',
      required: false,
      type: 'array',
      apiFieldPath: ['rollout', 'labels'],
    },
  ]);
});

test('object array body params are exposed from root oneOf variants', () => {
  const versions = {
    type: 'array',
    items: {
      type: 'object',
      properties: { version_id: { type: 'string' } },
    },
  };
  populateOperationMap({
    paths: {
      '/variant-deployments': {
        post: {
          operationId: 'create-variant-deployment',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { versions },
                      required: ['versions'],
                    },
                    {
                      type: 'object',
                      properties: { versions },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-variant-deployment');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['versions'],
    },
  ]);
});

test('operation descriptions fall back to OpenAPI summaries', () => {
  const forge = new Forge({
    openapi: '3.0.3',
    info: { title: 'test', version: '1' },
    paths: {
      '/summary-only': {
        get: {
          operationId: 'summary-only',
          summary: 'Summary-only operation',
          responses: {},
        },
      },
    },
  });

  assert.equal(forge.getOperationDescription('summary-only'), 'Summary-only operation');
  assert.equal(forge.getDescription('summary-only'), 'Summary-only operation');
});

test('oneOf merges enum values from referenced properties in every variant', () => {
  populateOperationMap({
    paths: {
      '/pipelines': {
        post: {
          operationId: 'create-pipeline',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    format: {
                      oneOf: [
                        { $ref: '#/components/schemas/JsonFormat' },
                        { $ref: '#/components/schemas/ParquetFormat' },
                      ],
                      discriminator: { propertyName: 'type' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        JsonFormat: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['json'] },
            compression: { $ref: '#/components/schemas/JsonCompression' },
          },
          required: ['type'],
        },
        ParquetFormat: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['parquet'] },
            compression: { $ref: '#/components/schemas/ParquetCompression' },
          },
          required: ['type'],
        },
        JsonCompression: {
          type: 'string',
          enum: ['uncompressed', 'gzip'],
          default: 'uncompressed',
        },
        ParquetCompression: {
          type: 'string',
          enum: ['uncompressed', 'snappy', 'gzip', 'zstd', 'lz4'],
        },
      },
    },
  });

  const operation = resolveOperation('create-pipeline');
  assert.ok(operation);
  const compression = operation.bodyParams.find((param) => param.name === 'format-compression');
  assert.deepEqual(compression, {
    name: 'format-compression',
    required: false,
    type: 'string',
    apiFieldPath: ['format', 'compression'],
    enumValues: ['uncompressed', 'gzip', 'snappy', 'zstd', 'lz4'],
    default: 'uncompressed',
  });
});

test('x-fern-parameter-name sets sdkName on path, query, header, and referenced parameters', () => {
  populateOperationMap({
    paths: {
      '/namespaces/{name}/instances/{id}': {
        parameters: [{ $ref: '#/components/parameters/Namespace' }],
        get: {
          operationId: 'get-instance',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              'x-fern-parameter-name': 'instance-id',
            },
            {
              name: 'date_start',
              in: 'query',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'start',
            },
            {
              name: 'cf-trace',
              in: 'header',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'trace',
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'number' },
            },
          ],
        },
      },
    },
    components: {
      parameters: {
        Namespace: {
          name: 'name',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          'x-fern-parameter-name': 'namespace',
        },
      },
      schemas: {},
    },
  });

  const operation = resolveOperation('get-instance');
  assert.ok(operation);
  assert.deepEqual(
    operation.pathParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [
      { name: 'name', sdkName: 'namespace' },
      { name: 'id', sdkName: 'instance-id' },
    ],
  );
  assert.deepEqual(
    operation.queryParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [
      { name: 'date_start', sdkName: 'start' },
      { name: 'page', sdkName: undefined },
    ],
  );
  assert.deepEqual(
    operation.headerParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [{ name: 'cf-trace', sdkName: 'trace' }],
  );
});

test('x-fern-property-name renames body flag segments at every depth', () => {
  populateOperationMap({
    paths: {
      '/configs': {
        post: {
          operationId: 'create-config',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    config_src: {
                      $ref: '#/components/schemas/ConfigSource',
                      'x-fern-property-name': 'config-source',
                    },
                    version: { type: 'number', 'x-fern-property-name': 'config-version' },
                    mtls: { $ref: '#/components/schemas/Mtls' },
                    instance_retention: {
                      type: 'object',
                      properties: {
                        success_retention: { type: 'string', 'x-fern-property-name': 'success' },
                        error_retention: { type: 'string', 'x-fern-property-name': 'error' },
                      },
                    },
                    integration: {
                      type: 'object',
                      properties: {
                        integration: { type: 'string' },
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
    components: {
      schemas: {
        ConfigSource: { type: 'string', enum: ['local', 'cloudflare'] },
        Mtls: {
          type: 'object',
          properties: {
            ca_certificate_id: { $ref: '#/components/schemas/CaCertificateId' },
            mtls_certificate_id: { type: 'string', 'x-fern-property-name': 'certificate-id' },
          },
        },
        CaCertificateId: { type: 'string', 'x-fern-property-name': 'ignored' },
      },
    },
  });

  const operation = resolveOperation('create-config');
  assert.ok(operation);
  assert.deepEqual(
    operation.bodyParams.map(({ name, apiFieldPath }) => ({ name, apiFieldPath })),
    [
      { name: 'config-source', apiFieldPath: ['config_src'] },
      { name: 'config-version', apiFieldPath: ['version'] },
      { name: 'mtls-ca-certificate-id', apiFieldPath: ['mtls', 'ca_certificate_id'] },
      { name: 'mtls-certificate-id', apiFieldPath: ['mtls', 'mtls_certificate_id'] },
      { name: 'instance-retention-success', apiFieldPath: ['instance_retention', 'success_retention'] },
      { name: 'instance-retention-error', apiFieldPath: ['instance_retention', 'error_retention'] },
      { name: 'integration-integration', apiFieldPath: ['integration', 'integration'] },
    ],
  );
});

test('single-member allOf body properties preserve scalar and array metadata', () => {
  populateOperationMap({
    paths: {
      '/configs': {
        post: {
          operationId: 'create-wrapped-config',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['client_id'],
                  properties: {
                    config_src: {
                      allOf: [{ $ref: '#/components/schemas/ConfigSource' }],
                      'x-fern-property-name': 'config-source',
                      description: 'Property-local description',
                    },
                    client_id: {
                      allOf: [{ $ref: '#/components/schemas/ClientId' }],
                      'x-fern-property-name': 'connector-id',
                    },
                    options: {
                      type: 'object',
                      required: ['enabled', 'count'],
                      properties: {
                        enabled: { allOf: [{ type: 'boolean', default: true }] },
                        count: { allOf: [{ allOf: [{ type: 'integer', default: 2 }] }], default: 3 },
                        tags: { allOf: [{ type: 'array', items: { type: 'string' } }] },
                        secret: { allOf: [{ type: 'string' }], 'x-sensitive': true },
                        ignored: { allOf: [{ type: 'string' }], readOnly: true },
                      },
                    },
                    objects: {
                      allOf: [{ type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ConfigSource: {
          type: 'string',
          enum: ['local', 'cloudflare'],
          default: 'local',
          description: 'Shared description',
        },
        ClientId: { type: 'string', 'x-sensitive': true },
      },
    },
  });

  const operation = resolveOperation('create-wrapped-config');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'config-source',
      type: 'string',
      required: false,
      apiFieldPath: ['config_src'],
      description: 'Property-local description',
      enumValues: ['local', 'cloudflare'],
      default: 'local',
    },
    { name: 'connector-id', type: 'string', required: true, apiFieldPath: ['client_id'], sensitive: true },
    { name: 'options-enabled', type: 'boolean', required: true, apiFieldPath: ['options', 'enabled'], default: true },
    { name: 'options-count', type: 'number', required: true, apiFieldPath: ['options', 'count'], default: 3 },
    { name: 'options-tags', type: 'array', required: false, apiFieldPath: ['options', 'tags'] },
    { name: 'options-secret', type: 'string', required: false, apiFieldPath: ['options', 'secret'], sensitive: true },
    { name: 'objects', type: 'array', itemType: 'object', required: false, apiFieldPath: ['objects'] },
  ]);
});

test('x-fern-property-name survives oneOf variant merges and renames conflicts', () => {
  populateOperationMap({
    paths: {
      '/sources': {
        post: {
          operationId: 'create-source',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['settings', 'bucket'],
                      properties: {
                        settings: {
                          type: 'object',
                          'x-fern-property-name': 'options',
                          properties: { max_items: { type: 'number' } },
                        },
                        bucket: { type: 'string', 'x-fern-property-name': 'bucket-name' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['settings', 'url'],
                      properties: {
                        settings: {
                          type: 'object',
                          properties: { depth: { type: 'number' } },
                        },
                        url: { type: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-source');
  assert.ok(operation);
  assert.deepEqual(
    operation.bodyParams.map(({ name, apiFieldPath, conflicts }) => ({ name, apiFieldPath, conflicts })),
    [
      { name: 'options-max-items', apiFieldPath: ['settings', 'max_items'], conflicts: ['options-depth', 'url'] },
      { name: 'options-depth', apiFieldPath: ['settings', 'depth'], conflicts: ['options-max-items', 'bucket-name'] },
      { name: 'bucket-name', apiFieldPath: ['bucket'], conflicts: ['options-depth', 'url'] },
      { name: 'url', apiFieldPath: ['url'], conflicts: ['options-max-items', 'bucket-name'] },
    ],
  );
});
