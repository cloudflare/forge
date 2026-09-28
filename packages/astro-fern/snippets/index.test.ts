import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBodyExample,
  createSnippetProvider,
  interpolatePath,
  placeholderValue,
  toEnvVar,
  type SnippetInput,
  type SnippetOperation,
} from './index.ts';

function op(partial: Partial<SnippetOperation> = {}): SnippetOperation {
  return {
    path: '/widgets/{widget_id}',
    method: 'get',
    pathParams: [{ name: 'widget_id', required: true, type: 'string' }],
    queryParams: [],
    ...partial,
  };
}

const input: SnippetInput = { op: op(), accessorPath: ['widgets', 'items'], methodName: 'list' };

test('toEnvVar upcases and separates on non-alphanumerics', () => {
  assert.equal(toEnvVar('widget_id'), 'WIDGET_ID');
  assert.equal(toEnvVar('a-b.c'), 'A_B_C');
});

test('interpolatePath replaces slots with $ENV by default and honours a custom replacer', () => {
  assert.equal(interpolatePath('/widgets/{widget_id}'), '/widgets/$WIDGET_ID');
  assert.equal(
    interpolatePath('/widgets/{widget_id}', (name) => `:${name}`),
    '/widgets/:widget_id',
  );
});

test('placeholderValue prefers enum, then default, then a type-appropriate value', () => {
  assert.equal(placeholderValue({ name: 'type', required: true, type: 'string', enumValues: ['A', 'AAAA'] }), 'A');
  assert.equal(placeholderValue({ name: 'ttl', required: true, type: 'number', enumValues: [600, 1800] }), 600);
  assert.equal(placeholderValue({ name: 'ttl', required: false, type: 'number', default: 120 }), 120);
  assert.equal(placeholderValue({ name: 'count', required: true, type: 'number' }), 0);
  assert.equal(placeholderValue({ name: 'on', required: true, type: 'boolean' }), true);
  assert.equal(placeholderValue({ name: 'name', required: true, type: 'string' }), '<name>');
});

test('buildBodyExample nests required leaves by apiFieldPath and skips optionals', () => {
  const body = buildBodyExample([
    { name: 'name', required: true, type: 'string', apiFieldPath: ['name'] },
    { name: 'nested', required: true, type: 'string', apiFieldPath: ['meta', 'nested'] },
    { name: 'comment', required: false, type: 'string', apiFieldPath: ['comment'] },
  ]);
  assert.deepEqual(body, { name: '<name>', meta: { nested: '<nested>' } });
});

test('buildBodyExample preserves required nested objects and arrays', () => {
  const body = buildBodyExample([
    {
      name: 'settings',
      required: true,
      type: 'object',
      children: [
        { name: 'enabled', required: true, type: 'boolean' },
        { name: 'note', required: false, type: 'string' },
      ],
    },
    {
      name: 'rules',
      required: true,
      type: 'array',
      items: {
        name: '',
        required: false,
        type: 'object',
        children: [{ name: 'action', required: true, type: 'string', enumValues: ['block'] }],
      },
    },
  ]);

  assert.deepEqual(body, { settings: { enabled: true }, rules: [{ action: 'block' }] });
});

test('createSnippetProvider renders each target in order with tab metadata', () => {
  const provider = createSnippetProvider(
    {
      curl: { label: 'curl', syntax: 'bash', render: ({ op }) => `GET ${op.path}` },
      ts: {
        label: 'TypeScript',
        syntax: 'ts',
        render: ({ accessorPath, methodName }) => `${[...accessorPath, methodName].join('.')}()`,
      },
    },
    ['curl', 'ts'],
  );
  const snippets = provider(input);
  assert.deepEqual(
    snippets.map((snippet) => snippet.targetId),
    ['curl', 'ts'],
  );
  assert.deepEqual(
    snippets.map((snippet) => snippet.label),
    ['curl', 'TypeScript'],
  );
  assert.equal(snippets[0]?.code, 'GET /widgets/{widget_id}');
  assert.equal(snippets[1]?.code, 'widgets.items.list()');
});

test('a renderer that returns null or throws yields a coming-soon tab (code: null)', () => {
  const provider = createSnippetProvider({
    empty: { label: 'Empty', syntax: 'text', render: () => null },
    boom: {
      label: 'Boom',
      syntax: 'text',
      render: () => {
        throw new Error('nope');
      },
    },
  });
  const snippets = provider(input);
  assert.equal(snippets.find((snippet) => snippet.targetId === 'empty')?.code, null);
  assert.equal(snippets.find((snippet) => snippet.targetId === 'boom')?.code, null);
});

test('an order id with no matching renderer is emitted as a null tab', () => {
  const provider = createSnippetProvider({ curl: { label: 'curl', syntax: 'bash', render: () => 'x' } }, [
    'curl',
    'ghost',
  ]);
  const snippets = provider(input);
  assert.deepEqual(
    snippets.map((snippet) => snippet.targetId),
    ['curl', 'ghost'],
  );
  assert.equal(snippets.find((snippet) => snippet.targetId === 'ghost')?.code, null);
});
