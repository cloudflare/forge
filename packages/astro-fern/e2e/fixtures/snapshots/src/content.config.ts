import { createSnippetProvider, defineFernManifest, type FernContentOptions } from 'astro-fern';
import { defineFernCollections } from 'astro-fern/collections';
import type { OpenApiDocumentSchema } from 'astro-fern/content';

const legacy: OpenApiDocumentSchema = {
  info: { description: 'Legacy API snapshot.' },
  paths: {
    '/widgets/{widget_id}': {
      get: {
        operationId: 'widgets_read',
        summary: 'Read legacy widget',
        description: 'Returns the legacy widget representation.',
        tags: ['Widget Archive'],
        parameters: [{ name: 'widget_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'A legacy widget.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { legacy_name: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
    '/widgets/{widget_id}/remove': {
      delete: {
        operationId: 'widgets_remove',
        summary: 'Remove legacy widget',
        tags: ['Widget Archive'],
      },
    },
    '/retired/status': {
      get: {
        operationId: 'retired_status',
        summary: 'Read retired status',
        tags: ['Retired Status'],
      },
    },
  },
};

const current: OpenApiDocumentSchema = {
  info: { description: 'Current API snapshot.' },
  paths: {
    '/widgets/{widget_id}': {
      get: {
        operationId: 'widgets_read',
        summary: 'Read current widget',
        description: 'Returns the current widget representation.',
        tags: ['Widget Management'],
        parameters: [{ name: 'widget_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'A current widget.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { current_name: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
    '/widgets': {
      post: {
        operationId: 'widgets_create',
        summary: 'Create current widget',
        tags: ['Widget Management'],
      },
    },
  },
};

const snippets = createSnippetProvider(
  {
    curl: {
      label: 'curl',
      syntax: 'bash',
      render: ({ op, snapshotId }) => `curl ${snapshotId ?? 'implicit-current'} ${op.path}`,
    },
  },
  ['curl'],
);

export const collections = defineFernCollections({
  source: {
    kind: 'snapshots',
    snapshots: [
      { id: 'legacy', slug: 'v1', label: 'Legacy', source: legacy },
      { id: 'current', slug: 'current', label: 'Current', default: true, source: current },
    ],
  },
  manifest: defineFernManifest({
    products: [
      {
        id: 'widgets',
        title: 'Widgets',
        sections: [
          { id: 'archive', tag: 'Widget Archive' },
          { id: 'management', tag: 'Widget Management' },
        ],
      },
      {
        id: 'retired',
        title: 'Retired API',
        pathPrefixes: ['/retired'],
        sections: [{ id: 'status', tag: 'Retired Status' }],
      },
    ],
    targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
  }),
  snippets,
} satisfies FernContentOptions);
