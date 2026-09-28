import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderLlmsIndex } from './agents/index.ts';
import { enrichOperationEntry } from './content-collections.ts';
import { discoverFernProducts } from './content/build.ts';
import type { OpenApiDocumentSchema } from './content/openapi.ts';
import { contentCatalogSchema } from './content/schema.ts';
import { defineFernManifest } from './manifest.ts';
import { buildFernContent, defineFernProject } from './project.ts';
import {
  composeFernPage,
  composeFernProject,
  composeFernRoutePlan,
  type FernDeploymentConfig,
  type FernProjectData,
} from './route-plan.ts';
import { type AgentScope, type AstroFernAgentsOptions, resolveRuntimeConfig } from './runtime-config.ts';
import { getMarkdownStaticPaths } from './routing.ts';
import { createSnippetProvider } from './snippets/index.ts';
import { fixtureExtension, fixtureSnippets, testProject, widgetsProduct, widgetsSpec } from './test-fixture.ts';

function project(
  agents?: AstroFernAgentsOptions,
  snapshots?: Array<{ id: string }>,
  deployment?: FernDeploymentConfig,
) {
  return testProject(
    {
      source: snapshots
        ? { kind: 'snapshots', snapshots: snapshots.map((snapshot) => ({ ...snapshot, source: widgetsSpec })) }
        : widgetsSpec,
      snippets: fixtureSnippets,
      manifest: defineFernManifest({
        products: [widgetsProduct],
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
        ],
      }),
    },
    { routing: { target: 'path' }, ...(agents ? { agents } : {}) },
    undefined,
    deployment,
  );
}

function visibilitySpec(includeVisible: boolean): OpenApiDocumentSchema {
  return {
    paths: {
      '/widgets/hidden': {
        get: {
          operationId: 'widgets_hidden',
          summary: 'Hidden widget operation',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets',
          'x-fern-sdk-method-name': 'hidden',
          'x-test-hidden': true,
        },
      },
      ...(includeVisible
        ? {
            '/widgets/visible': {
              get: {
                operationId: 'widgets_visible',
                summary: 'Visible widget operation',
                tags: ['Widget Management'],
                'x-fern-sdk-group-name': 'widgets',
                'x-fern-sdk-method-name': 'visible',
              },
            },
          }
        : {}),
    },
  };
}

function visibilityProject(source: OpenApiDocumentSchema, product = 'widgets', tag = 'Widget Management') {
  return testProject({
    source,
    isOperationHidden: (operation) => operation['x-test-hidden'] === true,
    manifest: defineFernManifest({
      products: [{ id: product, sections: [{ id: 'management', tag }] }],
      targets: [],
    }),
  });
}

const llmsHref = (page: FernProjectData['pages'][number], scope: string): string | undefined =>
  page.agentLinks.llms.find((link) => link.scope === scope)?.href;

async function compositionFixture() {
  const content = defineFernProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: widgetsSpec },
        { id: 'v2', source: widgetsSpec },
      ],
    },
    snippets: fixtureSnippets,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [
        { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
        { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
      ],
    }),
  }).getData();
  const operations = await Promise.all(
    content.operations.map(async (source) => ({
      snapshotId: source.snapshotId,
      operation: await enrichOperationEntry(source, async (markdown) => ({ markdown, html: `<p>${markdown}</p>` })),
    })),
  );
  const runtime = resolveRuntimeConfig({ routing: { target: 'path' } });
  const deployment = { base: '/developers', site: 'https://docs.example.com' } satisfies FernDeploymentConfig;
  const metadata = content.catalog.description
    ? { description: { markdown: content.catalog.description, html: `<p>${content.catalog.description}</p>` } }
    : {};
  return { content, operations, runtime, deployment, metadata };
}

test('composeFernRoutePlan matches every metadata surface from composeFernProject', async () => {
  const { content, operations, runtime, deployment, metadata: catalogMetadata } = await compositionFixture();
  const project = composeFernProject(content.catalog, operations, runtime, deployment, catalogMetadata);
  const { pages: _pages, ...projectMetadata } = project;
  const plan = composeFernRoutePlan(content.catalog, runtime, deployment, catalogMetadata);

  assert.deepEqual(plan, projectMetadata);
  assert.equal(plan.catalog.description?.markdown, content.catalog.description);
  assert.equal('pages' in plan, false);
});

test('composeFernPage matches each corresponding page from composeFernProject', async () => {
  const { content, operations, runtime, deployment, metadata } = await compositionFixture();
  const project = composeFernProject(content.catalog, operations, runtime, deployment, metadata);

  for (const expected of project.pages) {
    const source = operations.find(
      (candidate) => candidate.snapshotId === expected.snapshot.id && candidate.operation.id === expected.entryId,
    );
    assert.ok(source);
    assert.deepEqual(
      composeFernPage(content.catalog, source.operation, expected.snapshot.id, runtime, deployment),
      expected,
    );
  }
});

test('composeFernPage keeps aliased operations scoped to their catalog product', async () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/shared': {
        get: {
          operationId: 'get-shared',
          tags: ['Shared Operations'],
          'x-fern-sdk-group-name': 'first.items',
          'x-fern-sdk-method-name': 'get',
          'x-test-aliases': [
            {
              'x-fern-sdk-group-name': 'second.items',
              'x-fern-sdk-method-name': 'get',
            },
          ],
        },
      },
    },
  };
  const content = defineFernProject({
    source: { kind: 'snapshots', snapshots: [{ id: 'v1', source }] },
    extensions: [fixtureExtension],
    manifest: defineFernManifest({
      products: discoverFernProducts(source, { extensions: [fixtureExtension] }),
    }),
  }).getData();
  const operations = await Promise.all(
    content.operations.map((operation) =>
      enrichOperationEntry(operation, async (markdown) => ({ markdown, html: `<p>${markdown}</p>` })),
    ),
  );
  const runtime = resolveRuntimeConfig({});
  const pages = operations.map((operation) => composeFernPage(content.catalog, operation, 'v1', runtime));

  assert.deepEqual(
    pages.map((page) => page.product.id),
    ['first', 'second'],
  );
  assert.equal(new Set(pages.map((page) => page.entryId)).size, 2);
});

test('same-product aliases retain distinct artifact identities and canonical routes', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/shared': {
        get: {
          operationId: 'get-shared',
          tags: ['Shared Operations'],
          'x-fern-sdk-group-name': 'first.items',
          'x-fern-sdk-method-name': 'get',
          'x-test-aliases': [
            {
              'x-fern-sdk-group-name': 'first.legacy_items',
              'x-fern-sdk-method-name': 'fetch',
            },
          ],
        },
      },
    },
  };
  const content = buildFernContent({
    source,
    extensions: [fixtureExtension],
    manifest: defineFernManifest({
      products: discoverFernProducts(source, { extensions: [fixtureExtension] }),
    }),
  });
  const operations = content.catalog.products[0]?.snapshots[0]?.sections[0]?.operations;
  assert.ok(operations);
  assert.equal(new Set(operations.map((operation) => operation.entryId)).size, 2);
  assert.deepEqual(
    operations.map((operation) => ({ projectionId: operation.placement?.projectionId, slug: operation.slug })),
    [
      { projectionId: 'primary', slug: 'items/methods/get' },
      { projectionId: 'fixture:alias-1', slug: 'legacy-items/methods/fetch' },
    ],
  );

  const plan = composeFernRoutePlan(content.catalog, resolveRuntimeConfig({ routing: { base: '/' } }), {
    base: '/api',
  });
  assert.equal(new Set(plan.humanRoutes.map((route) => route.pageId)).size, 2);
  assert.deepEqual(
    plan.humanRoutes.map((route) => route.pathname),
    ['/api/first/items/methods/get/', '/api/first/legacy-items/methods/fetch/'],
  );
});

test('explicit snapshot sources preserve independent products, sections, operations, and slugs', () => {
  const legacy: OpenApiDocumentSchema = {
    info: { description: 'Legacy snapshot.' },
    paths: {
      '/widgets/shared': {
        get: {
          operationId: 'widgets_read',
          summary: 'Read a legacy widget',
          tags: ['Widget Archive'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'read',
        },
      },
      '/widgets/removed': {
        delete: {
          operationId: 'widgets_remove',
          summary: 'Remove a legacy widget',
          tags: ['Widget Archive'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'remove',
        },
      },
      '/retired/status': {
        get: {
          operationId: 'retired_status',
          summary: 'Read retired status',
          tags: ['Retired API'],
          'x-fern-sdk-group-name': 'retired.status',
          'x-fern-sdk-method-name': 'get',
        },
      },
    },
  };
  const current: OpenApiDocumentSchema = {
    info: { description: 'Current snapshot.' },
    paths: {
      '/widgets/shared': {
        get: {
          operationId: 'widgets_read',
          summary: 'Read a current widget',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'read',
        },
      },
      '/widgets/new': {
        post: {
          operationId: 'widgets_create',
          summary: 'Create a widget',
          tags: ['Widget Management'],
          'x-fern-sdk-group-name': 'widgets.items',
          'x-fern-sdk-method-name': 'create',
        },
      },
    },
  };
  const data = defineFernProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'legacy', source: legacy },
        { id: 'current', source: current, default: true },
      ],
    },
    manifest: defineFernManifest({
      products: [
        {
          id: 'widgets',
          sections: [
            { id: 'archive', tag: 'Widget Archive' },
            { id: 'management', tag: 'Widget Management' },
          ],
        },
        {
          id: 'retired',
          pathPrefixes: ['/retired'],
          sections: [{ id: 'status', tag: 'Retired API' }],
        },
      ],
    }),
  }).getData();

  assert.equal(data.catalog.description, 'Current snapshot.');
  assert.deepEqual(
    data.catalog.snapshots.map(({ id }) => id),
    ['legacy', 'current'],
  );
  const widgets = data.catalog.products.find((product) => product.id === 'widgets');
  const retired = data.catalog.products.find((product) => product.id === 'retired');
  assert.ok(widgets && retired);
  assert.deepEqual(
    widgets.snapshots.map((snapshot) => [snapshot.id, snapshot.sections.map((section) => section.id)]),
    [
      ['legacy', ['archive']],
      ['current', ['management']],
    ],
  );
  assert.deepEqual(
    retired.snapshots.map(({ id }) => id),
    ['legacy'],
  );

  const legacyRead = widgets.snapshots[0]?.sections[0]?.operations.find(
    (operation) => operation.operationId === 'widgets_read',
  );
  const currentRead = widgets.snapshots[1]?.sections[0]?.operations.find(
    (operation) => operation.operationId === 'widgets_read',
  );
  assert.ok(legacyRead && currentRead);
  assert.equal(legacyRead.entryId, currentRead.entryId, 'semantic identity stays stable across snapshots');
  assert.equal(legacyRead.slug, 'sections/archive/operations/widgets-read');
  assert.equal(currentRead.slug, 'sections/management/operations/widgets-read');
  assert.deepEqual(
    data.operations.map((source) => [source.snapshotId, source.operation.operationId, source.operation.title]),
    [
      ['legacy', 'widgets_read', 'Read a legacy widget'],
      ['legacy', 'widgets_remove', 'Remove a legacy widget'],
      ['legacy', 'retired_status', 'Read retired status'],
      ['current', 'widgets_create', 'Create a widget'],
      ['current', 'widgets_read', 'Read a current widget'],
    ],
  );
});

test('snapshot configuration rejects ambiguous identities and defaults', () => {
  const manifest = defineFernManifest({ products: [widgetsProduct] });
  const build = (snapshots: Array<{ id: string; source: OpenApiDocumentSchema; slug?: string; default?: boolean }>) =>
    defineFernProject({ source: { kind: 'snapshots', snapshots }, manifest }).getData();

  assert.throws(() => build([]), /snapshot source set is empty; add at least one/);
  assert.throws(
    () =>
      build([
        { id: 'v1', source: widgetsSpec },
        { id: 'v1', source: widgetsSpec },
      ]),
    /duplicate snapshot ID "v1"/,
  );
  assert.throws(() => build([{ id: '', source: widgetsSpec }]), /snapshot at index 0 has an empty ID/);
  assert.throws(
    () =>
      build([
        { id: 'v1', source: widgetsSpec, default: true },
        { id: 'v2', source: widgetsSpec, default: true },
      ]),
    /more than one default snapshot/,
  );
  assert.throws(() => build([{ id: 'v1', slug: 'dated/v1', source: widgetsSpec }]), /invalid URL slug/);
  for (const slug of ['.', '..']) {
    assert.throws(() => build([{ id: 'v1', slug, source: widgetsSpec }]), /invalid URL slug/);
  }
  assert.throws(
    () =>
      build([
        { id: 'v1', slug: 'stable', source: widgetsSpec },
        { id: 'v2', slug: 'stable', source: widgetsSpec },
      ]),
    /duplicate snapshot URL slug "stable"/,
  );
});

test('a scalar source produces one implicit current snapshot', () => {
  const snippetSnapshots = new Set<string | undefined>();
  const data = defineFernProject({
    source: widgetsSpec,
    snippets: (input) => {
      snippetSnapshots.add(input.snapshotId);
      return [];
    },
    manifest: defineFernManifest({ products: [widgetsProduct] }),
  }).getData();

  assert.deepEqual(data.catalog.snapshots, [
    { id: 'current', slug: 'current', label: 'Current', default: true, targets: [] },
  ]);
  assert.deepEqual(
    data.catalog.products[0]?.snapshots.map(({ id, slug, label, default: isDefault }) => ({
      id,
      slug,
      label,
      default: isDefault,
    })),
    [{ id: 'current', slug: 'current', label: 'Current', default: true }],
  );
  assert.deepEqual([...snippetSnapshots], ['current']);
});

test('snapshot metadata and targets override manifest fallbacks', () => {
  const curl = { id: 'curl', kind: 'http', label: 'curl', language: 'bash' } as const;
  const python = { id: 'python', kind: 'sdk', label: 'Python', language: 'python' } as const;
  const global = { id: 'global', kind: 'tool', label: 'Global', language: 'text' } as const;
  const data = defineFernProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'legacy', source: widgetsSpec, slug: 'v1', label: 'Legacy', targets: [curl] },
        { id: 'current', source: widgetsSpec, default: true },
      ],
    },
    manifest: defineFernManifest({
      products: [{ ...widgetsProduct, targets: [python] }],
      targets: [global],
    }),
  }).getData();

  assert.deepEqual(
    data.catalog.snapshots.map((snapshot) => [
      snapshot.id,
      snapshot.slug,
      snapshot.label,
      snapshot.default,
      snapshot.targets.map(({ id }) => id),
    ]),
    [
      ['legacy', 'v1', 'Legacy', false, ['curl']],
      ['current', 'current', 'current', true, ['global']],
    ],
  );
  assert.deepEqual(
    data.catalog.products[0]?.snapshots.map((snapshot) => [snapshot.id, snapshot.targets.map(({ id }) => id)]),
    [
      ['legacy', ['curl']],
      ['current', ['python']],
    ],
  );
});

test('catalog validation rejects product snapshot metadata that contradicts the global registry', () => {
  const catalog = defineFernProject({
    source: { kind: 'snapshots', snapshots: [{ id: 'v1', source: widgetsSpec }] },
    manifest: defineFernManifest({ products: [widgetsProduct] }),
  }).getData().catalog;
  const inconsistent = structuredClone(catalog);
  const snapshot = inconsistent.products[0]?.snapshots[0];
  assert.ok(snapshot);
  snapshot.label = 'Contradictory label';

  assert.throws(
    () => contentCatalogSchema.parse(inconsistent),
    /has label metadata that differs from catalog\.snapshots; copy the global value/,
  );
});

test('default agents advertise aggregate and per-target Markdown with matching routes', () => {
  const data = project().getData();
  const [page] = data.pages;
  assert.ok(page, 'expected a page');
  assert.deepEqual(page.agentLinks.markdown, {
    href: '/api/widgets/sections/management/operations/widgets-update.md',
    mediaType: 'text/markdown',
  });
  for (const target of page.targets) {
    assert.ok(target.markdownHref, `${target.id} carries a markdownHref`);
    assert.equal(target.markdownHref, `${target.href.slice(0, -1)}.md`, `${target.id} Markdown mirrors its page`);
  }
  assert.equal(getMarkdownStaticPaths(data).length, 3);
});

test('markdown:false drops every Markdown link and route', () => {
  const data = project({ markdown: false }).getData();
  for (const page of data.pages) {
    assert.equal(page.agentLinks.markdown, undefined, 'no aggregate Markdown link');
    for (const target of page.targets) {
      assert.equal(target.markdownHref, undefined, `${target.id} advertises no markdownHref`);
    }
  }
  assert.equal(getMarkdownStaticPaths(data).length, 0, 'no Markdown routes emitted');
  assert.equal(
    data.agentRoutes.some((route) => route.kind === 'page-markdown'),
    false,
    'no page-markdown agent routes',
  );
});

test('the product llms link omits the snapshot slug on a non-default snapshot', () => {
  const data = project(undefined, [{ id: 'v1' }, { id: 'v2' }]).getData();
  const defaultPage = data.pages.find((page) => page.snapshot.default);
  const otherPage = data.pages.find((page) => !page.snapshot.default);
  assert.ok(defaultPage && otherPage, 'expected a default and a non-default snapshot page');

  assert.equal(llmsHref(defaultPage, 'product'), '/api/widgets/llms.txt');
  assert.equal(llmsHref(defaultPage, 'snapshot'), undefined);

  assert.equal(llmsHref(otherPage, 'product'), '/api/widgets/llms.txt');
  assert.equal(llmsHref(otherPage, 'snapshot'), '/api/widgets/v2/llms.txt');
  assert.notEqual(llmsHref(otherPage, 'product'), llmsHref(otherPage, 'snapshot'));
});

test('every product llms link matches the product-scoped llms route', () => {
  const data = project(undefined, [{ id: 'v1' }, { id: 'v2' }]).getData();
  const productRoute = data.agentRoutes.find(
    (route) => route.kind === 'llms-index' && route.scopeKind === 'product' && route.scope?.product === 'widgets',
  );
  assert.ok(productRoute, 'expected a product-scoped llms route');
  for (const page of data.pages) {
    assert.equal(llmsHref(page, 'product'), productRoute.pathname);
  }
});

test('historical-only products do not advertise an ungenerated product llms route', async () => {
  const { content, operations, runtime } = await compositionFixture();
  const sparseCatalog = structuredClone(content.catalog);
  const product = sparseCatalog.products[0];
  assert.ok(product);
  product.snapshots = product.snapshots.filter((snapshot) => !snapshot.default);

  const data = composeFernProject(sparseCatalog, operations, runtime);
  const page = data.pages[0];
  assert.ok(page);
  assert.equal(llmsHref(page, 'product'), undefined);
  assert.equal(llmsHref(page, 'snapshot'), '/api/widgets/v2/llms.txt');
  assert.equal(
    data.agentRoutes.some((route) => route.scopeKind === 'product' && route.scope?.product === 'widgets'),
    false,
  );
  const siteRoute = data.agentRoutes.find((route) => route.scopeKind === 'site');
  assert.ok(siteRoute);
  const siteIndex = renderLlmsIndex(data, siteRoute).body;
  assert.match(siteIndex, /- Widgets:/);
  assert.doesNotMatch(siteIndex, /widgets\/llms\.txt/);
});

test('each llms scope can be configured independently', () => {
  const cases: Array<[AgentScope, number]> = [
    ['site', 1],
    ['product', 1],
    ['snapshot', 2],
    ['target', 4],
  ];

  for (const [scope, expectedRoutes] of cases) {
    const data = project({ llms: { scopes: [scope] } }, [{ id: 'v1' }, { id: 'v2' }]).getData();
    const routes = data.agentRoutes.filter((route) => route.kind === 'llms-index');
    assert.equal(routes.length, expectedRoutes, `${scope} route count`);
    assert.deepEqual(new Set(routes.map((route) => route.scopeKind)), new Set([scope]));
  }

  const snapshotOnly = project({ llms: { scopes: ['snapshot'] } }, [{ id: 'v1' }, { id: 'v2' }]).getData();
  assert.deepEqual(
    snapshotOnly.agentRoutes.filter((route) => route.kind === 'llms-index').map((route) => route.pathname),
    ['/api/widgets/llms.txt', '/api/widgets/v2/llms.txt'],
  );
  const defaultPage = snapshotOnly.pages.find((page) => page.snapshot.default);
  assert.ok(defaultPage);
  assert.equal(llmsHref(defaultPage, 'snapshot'), '/api/widgets/llms.txt');
  assert.equal(llmsHref(defaultPage, 'product'), undefined);
});

test('Astro base and site prefix every public route and absolute agent link', () => {
  const data = project(undefined, undefined, {
    base: '/developers',
    site: 'https://docs.example.com',
  }).getData();
  const [page] = data.pages;
  assert.ok(page, 'expected a page');

  assert.equal(data.routing.base, '/developers/api');
  assert.equal(page.pathname, '/developers/api/widgets/sections/management/operations/widgets-update/');
  assert.equal(
    page.agentLinks.markdown?.href,
    'https://docs.example.com/developers/api/widgets/sections/management/operations/widgets-update.md',
  );
  assert.equal(llmsHref(page, 'site'), 'https://docs.example.com/developers/llms.txt');
  assert.ok(data.agentRoutes.some((route) => route.pathname === '/developers/llms.txt'));
});

test('page entry IDs are collision-safe and catalog identity is structured', () => {
  const source: OpenApiDocumentSchema = {
    paths: {
      '/first': { get: { operationId: 'b:c', tags: ['Items'] } },
      '/second': { get: { operationId: 'c', tags: ['Items'] } },
    },
  };
  const data = testProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'a', source },
        { id: 'a:b', source },
      ],
    },
    manifest: defineFernManifest({
      products: [{ id: 'p', sections: [{ id: 'items', tag: 'Items' }] }],
    }),
  }).getData();

  assert.equal(data.pages.length, 4);
  assert.equal(new Set(data.pages.map((page) => page.id)).size, data.pages.length);
  const product = data.catalog.products[0];
  assert.ok(product);
  for (const snapshot of product.snapshots) {
    for (const page of snapshot.pages) {
      assert.equal(data.pages.find((sourcePage) => sourcePage.id === page.id)?.operation.operationId, page.operationId);
    }
  }
});

test('each snapshot page selects snippets rendered for that snapshot', () => {
  const snippets = createSnippetProvider({
    curl: {
      label: 'curl',
      syntax: 'bash',
      render: ({ snapshotId }) => snapshotId ?? 'implicit-current',
    },
  });
  const data = testProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: widgetsSpec },
        { id: 'v2', source: widgetsSpec },
      ],
    },
    snippets,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
    }),
  }).getData();

  assert.equal(data.pages.find((page) => page.snapshot.id === 'v1')?.targets[0]?.code, 'v1');
  assert.equal(data.pages.find((page) => page.snapshot.id === 'v2')?.targets[0]?.code, 'v2');
});

test('hidden operations are absent from every generated project surface', () => {
  const data = visibilityProject(visibilitySpec(true)).getData();

  assert.deepEqual(
    data.catalog.products[0]?.snapshots[0]?.pages.map((operation) => operation.operationId),
    ['widgets_visible'],
  );
  assert.deepEqual(
    data.pages.map((page) => page.operation.operationId),
    ['widgets_visible'],
  );
  assert.deepEqual(data.pages[0]?.section, {
    id: 'management',
    tag: 'Widget Management',
    title: 'Widget Management',
  });
  assert.equal(JSON.stringify(data).includes('widgets_hidden'), false);
});

test('all-hidden products are omitted without masking unknown manifest products', () => {
  const source = visibilitySpec(false);
  const data = visibilityProject(source).getData();

  assert.deepEqual(data.catalog.products, []);
  assert.deepEqual(data.pages, []);
  assert.deepEqual(data.humanRoutes, []);
  assert.deepEqual(data.agentRoutes, [
    { id: 'llms:site', pathname: '/llms.txt', kind: 'llms-index', scopeKind: 'site', scope: {} },
  ]);
  assert.throws(
    () => visibilityProject(source, 'missing-product', 'Missing Tag').getData(),
    /section "missing-product.management" did not match OpenAPI tag "Missing Tag"/,
  );
});

test('manifest section ownership is explicit and URL-safe', () => {
  assert.throws(
    () => defineFernManifest({ products: [{ id: 'empty', sections: [] }] }),
    /must contain at least one section/,
  );
  assert.throws(
    () =>
      defineFernManifest({
        products: [{ id: 'bad', sections: [{ id: 'Not Valid', tag: 'Bad' }] }],
      }),
    /must be lowercase kebab-case/,
  );
  assert.throws(
    () =>
      defineFernManifest({
        products: [
          {
            id: 'one',
            sections: [
              { id: 'first', tag: 'Shared' },
              { id: 'second', tag: 'Shared' },
            ],
          },
        ],
      }),
    /OpenAPI tag "Shared" is assigned to both one.first and one.second/,
  );
  assert.throws(
    () =>
      defineFernManifest({
        products: [{ id: 'bad-scope', pathPrefixes: [], sections: [{ id: 'shared', tag: 'Shared' }] }],
      }),
    /must not have an empty path-prefix list/,
  );
  assert.throws(
    () =>
      defineFernManifest({
        products: [{ id: 'bad-scope', pathPrefixes: ['zones/'], sections: [{ id: 'shared', tag: 'Shared' }] }],
      }),
    /has invalid path prefix "zones\/"/,
  );
  assert.doesNotThrow(() =>
    defineFernManifest({
      products: [
        { id: 'accounts', pathPrefixes: ['/accounts'], sections: [{ id: 'shared', tag: 'Shared' }] },
        { id: 'zones', pathPrefixes: ['/zones'], sections: [{ id: 'shared', tag: 'Shared' }] },
      ],
    }),
  );
});
