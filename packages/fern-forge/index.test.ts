import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFernContent, defineFernManifest, getOperationExtensionData } from 'astro-fern';
import { buildDocsModel, discoverFernProducts, type OpenApiDocumentSchema } from 'astro-fern/content';
import { forgeDocumentSchema, forgeExtension, hoistForgeCommands } from './index.ts';

const product = {
  id: 'widgets',
  sdkGroup: 'widgets',
  sections: [{ id: 'management', tag: 'Widget Management' }],
};

function operation(overrides: Record<string, unknown> = {}): OpenApiDocumentSchema {
  return {
    paths: {
      '/widgets/{widget_id}': {
        patch: {
          operationId: 'widgets_update',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'update',
          ...overrides,
        },
      },
    },
  };
}

function captureWarnings(run: () => void): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('validates and exposes every known operation-level Forge field', () => {
  const source = operation({
    'x-fern-availability': 'deprecated',
    'x-fern-ignore': false,
    'x-forge-hidden': true,
    'x-forge-internal': true,
    'x-forge-globals': [{ name: 'account-id', type: 'string', required: true, description: 'Account ID' }],
    'x-forge-epilogue': 'Additional guidance.',
    'x-forge-args': [{ options: [{ name: 'force', type: 'boolean', required: { default: false } }] }],
    'x-forge-params': {
      widget_id: {
        description: 'Widget ID',
        hidden: false,
        required: true,
        choices: ['one', 'two'],
        array: false,
        positional: true,
        fromFile: { format: 'json' },
      },
    },
    'x-forge-require-confirmation': 'This operation removes the widget.',
  });
  const model = buildDocsModel({ source, products: [product], extensions: [forgeExtension()] });
  const result = model.products[0]?.sections[0]?.operations[0];
  assert.ok(result);
  assert.equal(result.requireConfirmation, 'This operation removes the widget.');
  const forge = getOperationExtensionData(result, 'forge');
  assert.equal(forge?.hidden, true);
  assert.equal(forge?.internal, true);
  assert.equal(forge?.sdkGroupName, 'widgets.items');
  assert.equal(forge?.availability, 'deprecated');
  assert.equal(forge?.availabilityMessage, undefined);
  assert.equal(forge?.params?.widget_id && typeof forge.params.widget_id, 'object');
});

test('keeps Fern availability messages on the operation and on alias projections', () => {
  const source = operation({
    'x-fern-sdk-group-name': undefined,
    'x-fern-sdk-method-name': undefined,
    'x-forge-aliases': [
      {
        'x-fern-sdk-group-name': 'widgets.items',
        'x-fern-sdk-method-name': 'update',
        'x-fern-availability': { status: 'legacy', message: '  Use the v2 widgets endpoint.  ' },
      },
    ],
  });
  const model = buildDocsModel({ source, products: [product], extensions: [forgeExtension()] });
  const result = model.products[0]?.sections[0]?.operations[0];
  assert.ok(result);
  assert.deepEqual(result.availability, { status: 'legacy', message: 'Use the v2 widgets endpoint.' });
  const forge = getOperationExtensionData(result, 'forge');
  assert.equal(forge?.availability, 'legacy');
  assert.equal(forge?.availabilityMessage, 'Use the v2 widgets endpoint.');
});

test('accepts an availability object on a primary operation', () => {
  const model = buildDocsModel({
    source: operation({
      'x-fern-availability': { status: 'preview', message: 'Subject to change.' },
    }),
    products: [product],
    extensions: [forgeExtension()],
  });
  const result = model.products[0]?.sections[0]?.operations[0];
  assert.ok(result);
  assert.deepEqual(result.availability, { status: 'preview', message: 'Subject to change.' });
  assert.equal(getOperationExtensionData(result, 'forge')?.availabilityMessage, 'Subject to change.');
});

test('aliases participate in product discovery and retain projection-specific data', () => {
  const source = operation({
    'x-fern-sdk-group-name': undefined,
    'x-fern-sdk-method-name': undefined,
    'x-forge-aliases': [
      {
        'x-fern-sdk-group-name': 'first.items',
        'x-fern-sdk-method-name': 'get',
        'x-forge-hidden': true,
      },
      {
        'x-fern-sdk-group-name': 'second.items',
        'x-fern-sdk-method-name': 'fetch',
        'x-forge-require-confirmation': 'Fetch the shared item?',
      },
    ],
  });
  const extension = forgeExtension();
  const products = discoverFernProducts(source, { extensions: [extension] });
  const model = buildDocsModel({ source, products, extensions: [extension] });

  assert.deepEqual(
    model.products.map(({ name }) => name),
    ['first', 'second'],
  );
  const first = model.products[0]?.sections[0]?.operations[0];
  const second = model.products[1]?.sections[0]?.operations[0];
  assert.ok(first && second);
  assert.equal(getOperationExtensionData(first, 'forge')?.hidden, true);
  assert.equal(getOperationExtensionData(second, 'forge')?.sdkMethodName, 'fetch');
  assert.equal(second.requireConfirmation, 'Fetch the shared item?');
});

test('x-forge-hidden records approval state without hiding documentation', () => {
  const model = buildDocsModel({
    source: operation({ 'x-forge-hidden': true }),
    products: [product],
    extensions: [forgeExtension()],
  });
  assert.equal(model.products[0]?.sections[0]?.operations.length, 1);
});

test('x-forge-hidden only breaks SDK route collisions against one approved operation', () => {
  const source = operation({ 'x-forge-hidden': true });
  if (!source.paths) source.paths = {};
  source.paths['/widgets/approved'] = {
    get: {
      operationId: 'widgets_update_approved',
      tags: ['Widget Management'],
      'x-fern-sdk-group-name': 'widgets.items',
      'x-fern-sdk-method-name': 'update',
      'x-forge-hidden': false,
    },
  };
  let model: ReturnType<typeof buildDocsModel> | undefined;
  const warnings = captureWarnings(() => {
    model = buildDocsModel({ source, products: [product], extensions: [forgeExtension()] });
  });

  assert.deepEqual(
    model?.products[0]?.sections[0]?.operations.map((operation) => operation.operationId),
    ['widgets_update_approved'],
  );
  assert.deepEqual(warnings, []);
});

test('SDK route collisions with no approved winner hide every candidate', () => {
  const source = operation({ 'x-forge-hidden': true });
  if (!source.paths) source.paths = {};
  source.paths['/widgets/also-hidden'] = {
    get: {
      operationId: 'widgets_update_also_hidden',
      tags: ['Widget Management'],
      'x-fern-sdk-group-name': 'widgets.items',
      'x-fern-sdk-method-name': 'update',
      'x-forge-hidden': true,
    },
  };
  let model: ReturnType<typeof buildDocsModel> | undefined;
  const warnings = captureWarnings(() => {
    model = buildDocsModel({ source, products: [product], extensions: [forgeExtension()] });
  });

  assert.deepEqual(model?.products, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Result: no page was generated/);
});

test('x-forge-aliases can place one operation at multiple routes in the same product', () => {
  const model = buildDocsModel({
    source: operation({
      'x-forge-aliases': [
        {
          'x-fern-sdk-group-name': 'widgets.legacy_items',
          'x-fern-sdk-method-name': 'edit',
        },
      ],
    }),
    products: [product],
    extensions: [forgeExtension()],
  });

  assert.deepEqual(
    model.products[0]?.sections[0]?.operations.map((entry) => ({
      projectionId: entry.placement?.projectionId,
      slug: entry.slug,
    })),
    [
      { projectionId: 'primary', slug: 'items/methods/update' },
      { projectionId: 'forge:alias:widgets.legacy_items/edit', slug: 'legacy-items/methods/edit' },
    ],
  );
});

test('alias projection identities remain stable when aliases are reordered', () => {
  const aliases = [
    {
      'x-fern-sdk-group-name': 'widgets.legacy_items',
      'x-fern-sdk-method-name': 'fetch',
    },
    {
      'x-fern-sdk-group-name': 'widgets.archived_items',
      'x-fern-sdk-method-name': 'read',
    },
  ];
  const projections = (orderedAliases: typeof aliases) => {
    const model = buildDocsModel({
      source: operation({ 'x-forge-aliases': orderedAliases }),
      products: [product],
      extensions: [forgeExtension()],
    });
    return (model.products[0]?.sections[0]?.operations ?? [])
      .map((entry) => ({ projectionId: entry.placement?.projectionId, slug: entry.slug }))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  };

  const reordered = [...aliases].reverse();
  reordered[1] = {
    ...reordered[1],
    'x-fern-sdk-group-name': ' widgets . legacy_items ',
    'x-fern-sdk-method-name': ' fetch ',
  };
  assert.deepEqual(projections(aliases), projections(reordered));
  assert.deepEqual(projections(aliases), [
    { projectionId: 'forge:alias:widgets.archived_items/read', slug: 'archived-items/methods/read' },
    { projectionId: 'primary', slug: 'items/methods/update' },
    { projectionId: 'forge:alias:widgets.legacy_items/fetch', slug: 'legacy-items/methods/fetch' },
  ]);

  const content = buildFernContent({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: operation({ 'x-forge-aliases': aliases }) },
        { id: 'v2', source: operation({ 'x-forge-aliases': reordered }), default: true },
      ],
    },
    manifest: defineFernManifest({ products: [product] }),
    extensions: [forgeExtension()],
  });
  const identities = content.catalog.products[0]?.snapshots.map((snapshot) =>
    snapshot.sections
      .flatMap((section) => section.operations)
      .map((entry) => ({ entryId: entry.entryId, projectionId: entry.placement?.projectionId, slug: entry.slug }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  );
  assert.equal(identities?.length, 2);
  assert.deepEqual(identities?.[0], identities?.[1]);
});

test('Forge extension state remains isolated between OpenAPI snapshots', () => {
  const content = buildFernContent({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'legacy', source: operation({ 'x-forge-hidden': true }) },
        { id: 'current', source: operation({ 'x-forge-hidden': false }), default: true },
      ],
    },
    manifest: defineFernManifest({ products: [product] }),
    extensions: [forgeExtension()],
  });
  const legacy = content.operations.find((entry) => entry.snapshotId === 'legacy');
  const current = content.operations.find((entry) => entry.snapshotId === 'current');
  assert.ok(legacy && current);
  assert.equal(getOperationExtensionData(legacy.operation, 'forge')?.hidden, true);
  assert.equal(getOperationExtensionData(current.operation, 'forge')?.hidden, false);
});

test('temporarily permits missing required metadata on ignored operations with a warning', () => {
  const source = operation({
    'x-fern-ignore': true,
    'x-fern-sdk-group-name': undefined,
  });
  const warnings = captureWarnings(() => {
    assert.deepEqual(discoverFernProducts(source, { extensions: [forgeExtension()] }), []);
  });
  assert.match(warnings.join('\n'), /x-fern-sdk-group-name.*temporarily skipped/);
});

test('temporarily permits entirely unannotated operations with aggregated warnings', () => {
  const source = operation({
    'x-fern-sdk-group-name': undefined,
    'x-fern-sdk-method-name': undefined,
  });
  const warnings = captureWarnings(() => {
    assert.deepEqual(discoverFernProducts(source, { extensions: [forgeExtension()] }), []);
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /x-fern-sdk-group-name.*1 operation.*temporarily skipped/);
  assert.match(warnings[1] ?? '', /x-fern-sdk-method-name.*1 operation.*temporarily skipped/);
});

test('retains the primary projection when aliases are also configured', () => {
  const source = operation({
    'x-forge-aliases': [
      {
        'x-fern-sdk-group-name': 'secondary.items',
        'x-fern-sdk-method-name': 'update',
      },
    ],
  });
  const extension = forgeExtension();
  const products = discoverFernProducts(source, { extensions: [extension] });

  assert.deepEqual(
    products.map(({ id }) => id),
    ['secondary', 'widgets'],
  );
});

test('rejects malformed, misplaced, and unknown Forge metadata', () => {
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({
          'x-forge-aliases': [
            {
              'x-fern-sdk-group-name': 'widgets.legacy_items',
              'x-fern-sdk-method-name': 'get',
            },
            {
              'x-fern-sdk-group-name': 'widgets . legacy_items',
              'x-fern-sdk-method-name': 'get',
            },
          ],
        }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /duplicate SDK address "widgets\.legacy_items\.get"/,
  );
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({ 'x-forge-hidden': 'yes' }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /x-forge-hidden[\s\S]*expected boolean/,
  );
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({ 'x-forge-hiddden': true }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /unknown Forge extension/,
  );
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({ 'x-fern-sdk-group-name': ['widgets', 'items'] }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /x-fern-sdk-group-name[\s\S]*expected string/,
  );
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({ 'x-fern-availability': { status: 'stable', message: 'Ready.' } }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /x-fern-availability/,
  );
  assert.throws(
    () =>
      buildDocsModel({
        source: operation({ 'x-fern-availability': { status: 'legacy', message: '   ' } }),
        products: [product],
        extensions: [forgeExtension()],
      }),
    /x-fern-availability/,
  );
});

test('validates known root-level Forge metadata', () => {
  const source = operation();
  source['x-forge-commands'] = {
    widgets: {
      description: 'Widgets',
      groups: {
        items: {
          description: 'Widget operations',
          'x-forge-epilogue': 'More information.',
          groups: {
            settings: { description: 'Widget settings' },
          },
        },
        'items.labels': { description: 'Widget labels' },
      },
    },
  };
  assert.doesNotThrow(() => buildDocsModel({ source, products: [product], extensions: [forgeExtension()] }));

  source['x-forge-commandss'] = {};
  assert.throws(
    () => buildDocsModel({ source, products: [product], extensions: [forgeExtension()] }),
    /unknown Forge extension/,
  );
});

test('forgeDocumentSchema validates commands with the other document extensions', () => {
  const source = operation();
  source['x-forge-commands'] = { widgets: { description: 'Widgets' } };
  assert.equal(forgeDocumentSchema.safeParse(source).success, true);

  source['x-forge-commands'] = { widgets: { description: '' } };
  const invalid = forgeDocumentSchema.safeParse(source);
  assert.ok(!invalid.success && invalid.error.issues.some((issue) => issue.path.includes('x-forge-commands')));
});

test('hoists command metadata misplaced on path items', () => {
  const source = operation();
  source['x-forge-commands'] = {
    widgets: { description: 'Widgets' },
  };
  const pathItem = source.paths?.['/widgets/{widget_id}'];
  assert.ok(pathItem);
  pathItem['x-forge-commands'] = {
    snippets: {
      description:
        'Lightweight JavaScript snippets that run on requests before Workers — for quick header modifications and redirects',
      groups: {
        content: { description: 'Raw JavaScript source code content of individual snippets' },
        rules: { description: 'Rules that determine which requests trigger specific snippets' },
      },
    },
  };

  const normalized = hoistForgeCommands(source);

  assert.deepEqual(normalized['x-forge-commands'], {
    widgets: { description: 'Widgets' },
    snippets: {
      description:
        'Lightweight JavaScript snippets that run on requests before Workers — for quick header modifications and redirects',
      groups: {
        content: { description: 'Raw JavaScript source code content of individual snippets' },
        rules: { description: 'Rules that determine which requests trigger specific snippets' },
      },
    },
  });
  const normalizedPathItem = normalized.paths?.['/widgets/{widget_id}'];
  assert.ok(normalizedPathItem);
  assert.equal('x-forge-commands' in normalizedPathItem, false);
  assert.equal('x-forge-commands' in pathItem, true);
});

test('validates the document before hoisting command metadata', () => {
  assert.throws(() => hoistForgeCommands([]), /not a valid OpenAPI document/);
});
