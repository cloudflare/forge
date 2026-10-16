import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FernRoutePlan } from 'astro-fern';
import { ApiRouter } from './api-routing.ts';

const operation = {
  entryId: 'operation:records-list',
  operationId: 'records_list',
  slug: 'sections/records/operations/records-list',
  section: { id: 'records', tag: 'Records', title: 'Records' },
  title: 'List records',
  description: 'Lists records.',
  httpMethod: 'get',
};

const plan: Pick<FernRoutePlan, 'catalog' | 'routing' | 'agents'> = {
  catalog: {
    snapshots: [
      {
        id: 'legacy',
        slug: 'legacy',
        label: 'Legacy',
        default: false,
        targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
      },
      {
        id: '2026-11-30.air',
        slug: '2026-11-30',
        label: '2026-11-30 (Air)',
        default: false,
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'typescript', kind: 'sdk', label: 'TypeScript', language: 'typescript' },
        ],
      },
      {
        id: '2027-01-31.breeze',
        slug: '2027-01-31',
        label: '2027-01-31 (Breeze)',
        default: true,
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'typescript', kind: 'sdk', label: 'TypeScript', language: 'typescript' },
        ],
      },
    ],
    products: [
      {
        id: 'dns',
        slug: 'dns',
        title: 'DNS',
        description: 'DNS API.',
        snapshots: [
          {
            id: 'legacy',
            slug: 'legacy',
            label: 'Legacy',
            default: false,
            targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
            pages: [
              {
                id: 'page:dns:legacy:records-list',
                pathname: '/api/dns/legacy/sections/records/operations/records-list/',
                ...operation,
              },
              {
                id: 'page:dns:legacy:retired-list',
                pathname: '/api/dns/legacy/sections/retired/operations/retired-list/',
                ...operation,
                entryId: 'operation:retired-list',
                operationId: 'retired_list',
                slug: 'sections/retired/operations/retired-list',
                section: { id: 'retired', tag: 'Retired', title: 'Retired' },
                title: 'List retired records',
              },
            ],
          },
          {
            id: '2026-11-30.air',
            slug: '2026-11-30',
            label: '2026-11-30 (Air)',
            default: false,
            targets: [
              { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
              { id: 'typescript', kind: 'sdk', label: 'TypeScript', language: 'typescript' },
            ],
            pages: [
              {
                id: 'page:dns:air:records-list',
                pathname: '/api/dns/2026-11-30/sections/records/operations/records-read/',
                ...operation,
                slug: 'sections/records/operations/records-read',
              },
            ],
          },
          {
            id: '2027-01-31.breeze',
            slug: '2027-01-31',
            label: '2027-01-31 (Breeze)',
            default: true,
            targets: [
              { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
              { id: 'typescript', kind: 'sdk', label: 'TypeScript', language: 'typescript' },
            ],
            pages: [
              {
                id: 'page:dns:breeze:records-list',
                pathname: '/api/dns/sections/records/operations/records-list/',
                ...operation,
              },
            ],
          },
        ],
      },
      {
        id: 'zones',
        slug: 'zones',
        title: 'Zones',
        description: 'Zones API.',
        snapshots: [
          {
            id: '2027-01-31.breeze',
            slug: '2027-01-31',
            label: '2027-01-31 (Breeze)',
            default: true,
            targets: [
              { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
              { id: 'go', kind: 'sdk', label: 'Go', language: 'go' },
            ],
            pages: [
              {
                id: 'page:zones:breeze:records-list',
                pathname: '/api/zones/sections/records/operations/records-list/',
                ...operation,
                entryId: 'operation:zones-records-list',
              },
            ],
          },
        ],
      },
    ],
  },
  routing: { base: '/api', target: 'hash' },
  agents: { injectRoutes: false, markdown: false, llms: false, directive: false },
};

const router = new ApiRouter(plan);

test('canonical operation paths use configured defaults when query parameters are absent', () => {
  const selection = router.resolveOperation(
    new URL('https://example.com/api/dns/sections/records/operations/records-list/'),
  );
  assert.equal(selection?.snapshot.id, '2027-01-31.breeze');
  assert.equal(selection?.lang, undefined);
  assert.equal(selection?.pageId, 'page:dns:breeze:records-list');
});

test('resolves canonical product and section landing pages', () => {
  const product = router.resolvePage(new URL('https://example.com/api/dns/'));
  assert.equal(product?.kind, 'product');
  assert.equal(product?.product.title, 'DNS');
  assert.equal(product?.snapshot.id, '2027-01-31.breeze');
  assert.equal(product?.kind === 'product' ? product.sections[0]?.title : undefined, 'Records');

  const section = router.resolvePage(new URL('https://example.com/api/dns/sections/records'));
  assert.equal(section?.kind, 'section');
  assert.equal(section?.kind === 'section' ? section.section.operations[0]?.title : undefined, 'List records');
});

test('product and section pages validate and preserve selections', () => {
  const product = router.resolvePage(new URL('https://example.com/api/dns?lang=typescript&version=2026-11-30.air'));
  assert.equal(product?.kind, 'product');
  assert.equal(product?.snapshot.id, '2026-11-30.air');
  assert.equal(product?.lang, 'typescript');

  assert.equal(router.resolvePage(new URL('https://example.com/api/dns/?lang=missing')), undefined);
  assert.equal(router.resolvePage(new URL('https://example.com/api/dns/sections/missing/')), undefined);
  assert.equal(router.resolvePage(new URL('https://example.com/api/missing/')), undefined);
});

test('landing pages include historical-only sections and operations', () => {
  const product = router.resolvePage(new URL('https://example.com/api/dns/?version=legacy'));
  assert.equal(product?.kind, 'product');
  assert.deepEqual(product?.kind === 'product' ? product.sections.map(({ id }) => id) : [], ['records', 'retired']);
  assert.equal(router.sectionHref('dns', 'legacy', 'retired'), '/api/dns/sections/retired/?version=legacy');
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/sections/retired/operations/retired-list/?version=legacy'),
    )?.pageId,
    'page:dns:legacy:retired-list',
  );
});

test('the version query uses the canonical snapshot ID and lang uses the target ID', () => {
  const selection = router.resolveOperation(
    new URL(
      'https://example.com/api/dns/sections/records/operations/records-read/?lang=typescript&version=2026-11-30.air',
    ),
  );
  assert.equal(selection?.snapshot.id, '2026-11-30.air');
  assert.equal(selection?.lang, 'typescript');
  assert.equal(selection?.pageId, 'page:dns:air:records-list');
});

test('operation resolution uses the slug declared by the selected snapshot', () => {
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/sections/records/operations/records-list/?version=2026-11-30.air'),
    ),
    undefined,
  );
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/sections/records/operations/records-read/?version=2026-11-30.air'),
    )?.pageId,
    'page:dns:air:records-list',
  );
});

test('invalid, empty, and duplicate selection parameters do not fall back', () => {
  const path = 'https://example.com/api/dns/sections/records/operations/records-list/';
  assert.equal(router.resolveOperation(new URL(`${path}?version=2026-11-30`)), undefined);
  assert.equal(router.resolveOperation(new URL(`${path}?lang=bash`)), undefined);
  assert.equal(router.resolveOperation(new URL(`${path}?lang=`)), undefined);
  assert.equal(router.resolveOperation(new URL(`${path}?version=legacy&version=2026-11-30.air`)), undefined);
});

test('site snapshot options select a snapshot without requiring an operation', () => {
  assert.equal(router.resolveSiteSnapshot(new URL('https://example.com/'))?.id, '2027-01-31.breeze');
  assert.equal(router.siteSnapshotHref('2026-11-30.air'), '/?version=2026-11-30.air');
  assert.equal(router.siteSnapshotHref('2027-01-31.breeze'), '/');
  assert.deepEqual(router.siteSnapshotOptions(new URL('https://example.com/?version=2026-11-30.air')), [
    { label: 'Legacy', value: '/?version=legacy', selected: false },
    { label: '2026-11-30 (Air)', value: '/?version=2026-11-30.air', selected: true },
    { label: '2027-01-31 (Breeze)', value: '/', selected: false },
  ]);
});

test('site-level links honor the Astro deployment base', () => {
  const based = new ApiRouter(plan, '/api');

  assert.equal(based.siteHref, '/api/');
  assert.equal(based.siteSnapshotHref('2026-11-30.air'), '/api/?version=2026-11-30.air');
  assert.equal(based.resolveHref({ kind: 'llms', scope: 'site' }), '/api/llms.txt');
  assert.equal(based.isSitePath('/api/'), true);
  assert.equal(based.isSitePath('/'), false);
});

test('site snapshot options retain supported languages and drop unsupported ones', () => {
  assert.deepEqual(router.siteSnapshotOptions(new URL('https://example.com/?lang=typescript')), [
    { label: 'Legacy', value: '/?version=legacy', selected: false },
    { label: '2026-11-30 (Air)', value: '/?lang=typescript&version=2026-11-30.air', selected: false },
    { label: '2027-01-31 (Breeze)', value: '/?lang=typescript', selected: true },
  ]);
});

test('invalid site snapshot parameters do not fall back', () => {
  assert.equal(router.resolveSiteSnapshot(new URL('https://example.com/?version=missing')), undefined);
  assert.equal(
    router.resolveSiteSnapshot(new URL('https://example.com/?version=legacy&version=2026-11-30.air')),
    undefined,
  );
  assert.deepEqual(router.siteSnapshotOptions(new URL('https://example.com/?version=')), []);
});

test('old snapshot and target path routes are gone', () => {
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/2026-11-30/sections/records/operations/records-list/'),
    ),
    undefined,
  );
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/typescript/sections/records/operations/records-list/'),
    ),
    undefined,
  );
});

test('Markdown resolution rejects paths without the Markdown extension', () => {
  assert.equal(
    router.resolveOperation(
      new URL('https://example.com/api/dns/sections/records/operations/records-list/'),
      'markdown',
    ),
    undefined,
  );
});

test('human and Markdown hrefs share the snapshot path and stable query parameters', () => {
  assert.equal(
    router.operationHref('dns', '2026-11-30.air', 'records_list', 'human', 'typescript'),
    '/api/dns/sections/records/operations/records-read/?lang=typescript&version=2026-11-30.air',
  );
  const markdown = router.operationHref('dns', '2026-11-30.air', 'records_list', 'markdown', 'typescript');
  assert.equal(markdown, '/api/dns/sections/records/operations/records-read.md?lang=typescript&version=2026-11-30.air');
  assert.equal(
    router.resolveOperation(new URL(`https://example.com${markdown}`), 'markdown')?.pageId,
    'page:dns:air:records-list',
  );
});

test('product and section hrefs use canonical hierarchy paths', () => {
  assert.equal(router.productHref('dns', '2027-01-31.breeze'), '/api/dns/');
  assert.equal(
    router.productHref('dns', '2026-11-30.air', 'typescript'),
    '/api/dns/?lang=typescript&version=2026-11-30.air',
  );
  assert.equal(
    router.sectionHref('dns', '2026-11-30.air', 'records', 'typescript'),
    '/api/dns/sections/records/?lang=typescript&version=2026-11-30.air',
  );
  assert.equal(router.sectionHref('dns', '2027-01-31.breeze', 'missing'), undefined);
});

test('breadcrumbs link every ancestor and leave only the current page unlinked', () => {
  const operation = router.resolvePage(
    new URL('https://example.com/api/dns/sections/records/operations/records-list/?lang=typescript'),
  );
  assert.ok(operation);
  assert.deepEqual(router.breadcrumbs(operation), [
    { label: 'API Reference', href: '/?lang=typescript' },
    { label: 'DNS', href: '/api/dns/?lang=typescript' },
    { label: 'Records', href: '/api/dns/sections/records/?lang=typescript' },
    { label: 'List records' },
  ]);

  const section = router.resolvePage(new URL('https://example.com/api/dns/sections/records/?version=legacy'));
  assert.ok(section);
  assert.deepEqual(router.breadcrumbs(section), [
    { label: 'API Reference', href: '/?version=legacy' },
    { label: 'DNS', href: '/api/dns/?version=legacy' },
    { label: 'Records' },
  ]);

  const product = router.resolvePage(new URL('https://example.com/api/dns/'));
  assert.ok(product);
  assert.deepEqual(router.breadcrumbs(product), [{ label: 'API Reference', href: '/' }, { label: 'DNS' }]);

  const productWithSiteUnsupportedLanguage = router.resolvePage(new URL('https://example.com/api/zones/?lang=go'));
  assert.ok(productWithSiteUnsupportedLanguage);
  assert.equal(router.breadcrumbs(productWithSiteUnsupportedLanguage)[0]?.href, '/');
});

test('llms snapshot and target scopes collapse onto the product route', () => {
  assert.equal(
    router.href({ kind: 'llms', scope: 'snapshot', productId: 'dns', snapshotId: '2026-11-30.air' }),
    '/api/dns/llms.txt?version=2026-11-30.air',
  );
  assert.equal(
    router.href({
      kind: 'llms',
      scope: 'target',
      productId: 'dns',
      snapshotId: '2026-11-30.air',
      targetId: 'typescript',
    }),
    '/api/dns/llms.txt?lang=typescript&version=2026-11-30.air',
  );
  assert.deepEqual(router.resolveLlms('dns', new URLSearchParams('lang=typescript&version=2026-11-30.air')), {
    kind: 'llms',
    scope: 'target',
    productId: 'dns',
    snapshotId: '2026-11-30.air',
    targetId: 'typescript',
  });
});

test('operation identity remains scoped to its product', () => {
  assert.equal(
    router.resolveOperation(new URL('https://example.com/api/zones/sections/records/operations/records-list/'))?.pageId,
    'page:zones:breeze:records-list',
  );
  assert.equal(router.operationHref('zones', '2027-01-31.breeze', 'records_list', 'human', 'typescript'), undefined);
});

test('a product unavailable in the global default snapshot never falls back to another snapshot', () => {
  const sparsePlan = structuredClone(plan);
  const source = sparsePlan.catalog.products[0];
  const legacy = source?.snapshots.find((snapshot) => snapshot.id === 'legacy');
  assert.ok(source && legacy);
  sparsePlan.catalog.products = [
    { ...source, id: 'archives', slug: 'archives', title: 'Archives', snapshots: [legacy] },
  ];
  const sparse = new ApiRouter(sparsePlan);

  assert.equal(sparse.resolvePage(new URL('https://example.com/api/archives/')), undefined);
  assert.equal(sparse.resolvePage(new URL('https://example.com/api/archives/?version=legacy'))?.snapshot.id, 'legacy');
  assert.equal(sparse.href({ kind: 'llms', scope: 'product', productId: 'archives' }), undefined);
  assert.equal(
    sparse.href({ kind: 'llms', scope: 'snapshot', productId: 'archives', snapshotId: 'legacy' }),
    '/api/archives/llms.txt?version=legacy',
  );
});

test('every language selector value resolves back to the selected target', () => {
  const product = plan.catalog.products[0];
  const snapshot = product?.snapshots.find((candidate) => candidate.default);
  const page = snapshot?.pages[0];
  assert.ok(product && snapshot && page);
  for (const target of snapshot.targets) {
    const href = router.operationHref(product.id, snapshot.id, page.operationId, 'human', target.id);
    assert.ok(href);
    assert.equal(router.resolveOperation(new URL(href, 'https://example.com'))?.lang, target.id);
  }
});

const sdkPrimary = {
  id: 'page:zero-trust:devices-list:primary',
  entryId: 'operation:zero-trust:devices-list:primary',
  operationId: 'devices_list',
  slug: 'devices/ip-profiles/methods/list',
  pathname: '/api/zero-trust/devices/ip-profiles/methods/list/',
  placement: {
    projectionId: 'primary',
    resourcePath: [
      { id: 'devices', slug: 'devices', title: 'Devices' },
      { id: 'ip_profiles', slug: 'ip-profiles', title: 'IP Profiles' },
    ],
    method: { id: 'list', slug: 'list' },
  },
  section: { id: 'devices', tag: 'Zero Trust devices', title: 'Internal ownership tag' },
  title: 'List IP profiles',
  description: 'Lists device IP profiles.',
  httpMethod: 'get',
};

const sdkAlias = {
  ...sdkPrimary,
  id: 'page:zero-trust:devices-list:alias',
  entryId: 'operation:zero-trust:devices-list:alias',
  slug: 'device-settings/methods/list',
  pathname: '/api/zero-trust/device-settings/methods/list/',
  placement: {
    projectionId: 'forge:alias:zero-trust.device_settings/list',
    resourcePath: [{ id: 'device_settings', slug: 'device-settings', title: 'Device Settings' }],
    method: { id: 'list', slug: 'list' },
  },
};

const sdkPlan: Pick<FernRoutePlan, 'catalog' | 'routing' | 'agents'> = {
  catalog: {
    snapshots: [{ id: 'current', slug: 'current', label: 'Current', default: true, targets: [] }],
    products: [
      {
        id: 'zero-trust',
        slug: 'zero-trust',
        title: 'Zero Trust',
        description: 'Zero Trust API.',
        snapshots: [
          {
            id: 'current',
            slug: 'current',
            label: 'Current',
            default: true,
            targets: [],
            pages: [sdkPrimary, sdkAlias],
          },
        ],
      },
    ],
  },
  routing: { base: '/api', target: 'hash' },
  agents: { injectRoutes: false, markdown: false, llms: false, directive: false },
};

test('SDK hierarchy resolves product, resource overview, and kebab-case method routes', () => {
  const sdkRouter = new ApiRouter(sdkPlan);
  const product = sdkRouter.resolvePage(new URL('https://example.com/api/zero-trust/'));
  assert.equal(product?.kind, 'product');
  assert.equal(product?.kind === 'product' ? product.resources[0]?.title : undefined, 'Devices');

  const resource = sdkRouter.resolvePage(new URL('https://example.com/api/zero-trust/devices/ip-profiles/'));
  assert.equal(resource?.kind, 'resource');
  assert.equal(resource?.kind === 'resource' ? resource.resource.title : undefined, 'IP Profiles');

  const operation = sdkRouter.resolveOperation(
    new URL('https://example.com/api/zero-trust/devices/ip-profiles/methods/list/'),
  );
  assert.equal(operation?.pageId, sdkPrimary.id);
  assert.equal(sdkRouter.resolvePage(new URL('https://example.com/api/zero-trust/devices/ip_profiles/')), undefined);
  assert.equal(sdkRouter.resolvePage(new URL('https://example.com/api/zero-trust/sections/devices/')), undefined);
  assert.equal(
    sdkRouter.resolvePage(
      new URL(
        'https://example.com/api/resources/zero-trust/subresources/devices/subresources/ip-profiles/methods/list/',
      ),
    ),
    undefined,
  );
});

test('SDK aliases resolve independently by projection identity', () => {
  const sdkRouter = new ApiRouter(sdkPlan);
  assert.equal(sdkRouter.operationHref('zero-trust', 'current', 'devices_list', 'human'), sdkPrimary.pathname);
  assert.equal(
    sdkRouter.operationHref(
      'zero-trust',
      'current',
      'devices_list',
      'human',
      undefined,
      'forge:alias:zero-trust.device_settings/list',
    ),
    sdkAlias.pathname,
  );
});

test('product URL slugs resolve back to semantic product IDs', () => {
  const slugPlan = structuredClone(sdkPlan);
  const product = slugPlan.catalog.products[0];
  assert.ok(product);
  product.id = 'analytics_engine';
  product.slug = 'analytics-engine';
  product.title = 'Analytics Engine';
  const slugRouter = new ApiRouter(slugPlan);

  const selection = slugRouter.resolvePage(new URL('https://example.com/api/analytics-engine/'));
  assert.equal(selection?.product.id, 'analytics_engine');
  assert.equal(selection?.pathname, '/api/analytics-engine/');
  assert.equal(slugRouter.resolvePage(new URL('https://example.com/api/analytics_engine/')), undefined);
  assert.deepEqual(slugRouter.resolveLlms('analytics-engine', new URLSearchParams()), {
    kind: 'llms',
    scope: 'product',
    productId: 'analytics_engine',
  });
  assert.equal(slugRouter.resolveLlms('analytics_engine', new URLSearchParams()), undefined);
  assert.equal(
    slugRouter.href({ kind: 'llms', scope: 'product', productId: 'analytics_engine' }),
    '/api/analytics-engine/llms.txt',
  );
});

test('SDK resource overviews cannot shadow operation routes', () => {
  const collisionPlan = structuredClone(sdkPlan);
  const snapshot = collisionPlan.catalog.products[0]?.snapshots[0];
  assert.ok(snapshot);
  snapshot.pages.push({
    ...sdkPrimary,
    id: 'page:zero-trust:nested-list:primary',
    entryId: 'operation:zero-trust:nested-list:primary',
    operationId: 'nested_list',
    slug: 'devices/ip-profiles/methods/list/methods/get',
    placement: {
      projectionId: 'primary',
      resourcePath: [
        ...sdkPrimary.placement.resourcePath,
        { id: 'methods', slug: 'methods', title: 'Methods' },
        { id: 'list', slug: 'list', title: 'List' },
      ],
      method: { id: 'get', slug: 'get' },
    },
  });

  assert.throws(() => new ApiRouter(collisionPlan), /maps SDK resource .* and operation .* to .*methods.*reserved/);
});

test('SDK breadcrumbs follow resource ownership instead of OpenAPI tags', () => {
  const sdkRouter = new ApiRouter(sdkPlan);
  const selection = sdkRouter.resolveOperation(new URL(`https://example.com${sdkPrimary.pathname}`));
  assert.ok(selection);
  assert.deepEqual(sdkRouter.breadcrumbs(selection), [
    { label: 'API Reference', href: '/' },
    { label: 'Zero Trust', href: '/api/zero-trust/' },
    { label: 'Devices', href: '/api/zero-trust/devices/' },
    {
      label: 'IP Profiles',
      href: '/api/zero-trust/devices/ip-profiles/',
    },
    { label: 'List IP profiles' },
  ]);
});

test('version selector values resolve the same operation and preserve only supported languages', () => {
  const selection = router.resolveOperation(
    new URL('https://example.com/api/dns/sections/records/operations/records-list/?lang=typescript'),
  );
  assert.ok(selection);
  const options = router.snapshotOptions(selection);
  assert.equal(options.length, 3);
  assert.equal(options.filter((option) => option.selected).length, 1);
  for (const option of options) {
    const resolved = router.resolveOperation(new URL(option.value, 'https://example.com'));
    assert.equal(resolved?.operation.operationId, selection.operation.operationId);
    assert.equal(resolved?.snapshot.label, option.label);
    assert.equal(resolved?.lang, option.label === 'Legacy' ? undefined : 'typescript');
  }
});

test('version selector only includes snapshots where the operation is available', () => {
  const selection = router.resolveOperation(
    new URL('https://example.com/api/dns/sections/retired/operations/retired-list/?version=legacy'),
  );
  assert.ok(selection);
  assert.deepEqual(router.snapshotOptions(selection), [
    {
      label: 'Legacy',
      value: '/api/dns/sections/retired/operations/retired-list/?version=legacy',
      selected: true,
    },
  ]);
});
