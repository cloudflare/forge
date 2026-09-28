import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RenderedOperationSchema } from 'astro-fern/content';
import { operationView, sectionNodes } from './operation-sections.ts';

const richText = (markdown: string) => ({ markdown, html: `<p>${markdown}</p>` });

test('selects and unwraps the preferred response schema for Returns', () => {
  const operation: RenderedOperationSchema = {
    operationId: 'create-widget',
    slug: 'create-widget',
    title: 'Create widget',
    httpMethod: 'POST',
    path: '/widgets',
    description: richText('Creates a widget.'),
    deprecated: false,
    extensions: {},
    pathParams: [],
    queryParams: [],
    requestBody: null,
    responses: [
      {
        status: '4XX',
        description: richText('Request failed.'),
        representations: [],
      },
      {
        status: '200',
        description: richText('Request succeeded.'),
        representations: [
          {
            mediaType: 'application/json',
            payloadKey: 'result',
            examples: [],
            schema: {
              type: 'object',
              required: false,
              children: [
                {
                  name: 'result',
                  type: 'widget[]',
                  required: true,
                  items: {
                    type: 'widget',
                    required: false,
                    children: [{ name: 'id', type: 'string', required: true }],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const view = operationView(operation);
  assert.equal(view.responseStatus?.status, '200');
  assert.equal(view.responseRepresentation?.mediaType, 'application/json');
  assert.equal(view.responseIsArray, true);
  assert.equal(view.response?.type, 'widget');
  assert.deepEqual(
    sectionNodes(operation, 'response').map(({ name }) => name),
    ['id'],
  );
});
