import { param, pathParam, type Tool } from '../src/tool.js';

/** Tools as the generator writes them. */
export const tools: readonly Tool[] = [
  {
    name: 'pets_list',
    title: 'List pets',
    description: 'Lists the pets of a store.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'object', properties: { store_id: { type: 'string' } }, required: ['store_id'] },
        query: { type: 'object', properties: { tag: { type: 'array' }, sort: { type: 'object' } } },
        headers: { type: 'object', properties: { 'X-Trace': { type: 'string' } } },
      },
      required: ['path'],
    },
    outputSchema: {
      type: 'array',
      items: { $ref: '#/$defs/Pet' },
      $defs: { Pet: { type: 'object', properties: { id: { type: 'string' } } } },
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
        ['tag', param(args, 'query', 'tag'), true],
        ['sort', param(args, 'query', 'sort'), false],
      ],
      headers: [['X-Trace', param(args, 'headers', 'X-Trace')]],
    }),
  },
  {
    name: 'pets_create',
    description: 'Adds a pet.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'object', properties: { store_id: { type: 'string' } }, required: ['store_id'] },
        query: { type: 'object', properties: { dry_run: { type: 'boolean' } }, required: ['dry_run'] },
        body: {},
      },
      required: ['path', 'query', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    method: 'POST',
    path: '/stores/{store_id}/pets',
    request: (args) => ({
      path: `/stores/${pathParam(args, 'store_id')}/pets`,
      query: [['dry_run', param(args, 'query', 'dry_run'), true]],
      body: { value: args['body'], mediaType: 'application/json' },
    }),
  },
];
