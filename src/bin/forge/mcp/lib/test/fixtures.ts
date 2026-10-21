import { pathParam, type Tool } from '../src/index.js';

/** Tools as the generator writes them. */
export const tools: readonly Tool[] = [
  {
    name: 'pets_list',
    title: 'List pets',
    description: 'Lists the pets of a store.',
    inputSchema: {
      type: 'object',
      properties: { store_id: { type: 'string' }, tag: { type: 'array' }, sort: { type: 'object' } },
      required: ['store_id'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    method: 'GET',
    path: '/stores/{store_id}/pets',
    extensions: { 'x-api-token-group': ['Pets Read'] },
    responses: {
      schemas: { '200': { type: 'array', items: { $ref: '#/$defs/Pet' } }, '4XX': null },
      $defs: { Pet: { type: 'object', properties: { id: { type: 'string' } } } },
    },
    request: (args) => ({
      path: `/stores/${pathParam(args, 'store_id')}/pets`,
      query: [
        ['tag', args['tag'], true],
        ['sort', args['sort'], false],
      ],
      headers: [['X-Trace', args['x_trace']]],
    }),
  },
  {
    name: 'pets_create',
    description: 'Adds a pet.',
    inputSchema: {
      type: 'object',
      properties: { store_id: { type: 'string' }, body: {} },
      required: ['store_id', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    method: 'POST',
    path: '/stores/{store_id}/pets',
    request: (args) => ({
      path: `/stores/${pathParam(args, 'store_id')}/pets`,
      body: { value: args['body'], mediaType: 'application/json' },
    }),
  },
];
