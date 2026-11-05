import { encodePath, OPERATION, type Tool } from '../src/tool.js';

/** Tools as the generator writes them. */
export const tools: readonly Tool[] = [
  {
    name: 'pets_list',
    title: 'List pets',
    description: 'Lists the pets of a store.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { store_id: { type: 'string' } },
          required: ['store_id'],
          additionalProperties: false,
        },
        query: {
          type: 'object',
          properties: { tag: { type: 'array' }, sort: { type: 'object' } },
          additionalProperties: false,
        },
        headers: { type: 'object', properties: { 'x-trace': { type: 'string' } }, additionalProperties: false },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'array',
      items: { $ref: '#/$defs/Pet' },
      $defs: { Pet: { type: 'object', properties: { id: { type: 'string' } } } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    [OPERATION]: {
      method: 'GET',
      path: '/stores/{store_id}/pets',
      pathOf: encodePath`/stores/${'store_id'}/pets`,
      query: [
        { name: 'tag', explode: true },
        { name: 'sort', explode: false },
      ],
      headers: ['x-trace'],
      extensions: { 'x-api-token-group': ['Pets Read'] },
      responses: {
        schemas: { '200': { type: 'array', items: { $ref: '#/$defs/Pet' } }, '4XX': null },
        $defs: { Pet: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    },
  },
  {
    name: 'pets_create',
    description: 'Adds a pet.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { store_id: { type: 'string' } },
          required: ['store_id'],
          additionalProperties: false,
        },
        query: {
          type: 'object',
          properties: { dry_run: { type: 'boolean' } },
          required: ['dry_run'],
          additionalProperties: false,
        },
        body: {},
      },
      required: ['path', 'query', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    [OPERATION]: {
      method: 'POST',
      path: '/stores/{store_id}/pets',
      pathOf: encodePath`/stores/${'store_id'}/pets`,
      query: [{ name: 'dry_run', explode: true }],
      body: { mediaTypes: ['application/json'] },
    },
  },
];
