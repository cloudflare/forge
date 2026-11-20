import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planStainlessRedirects, stainlessRedirect, type StainlessSnapshot } from './stainless-redirects.ts';

const snapshot: StainlessSnapshot = {
  resources: ['/resources/zones/'],
  methods: { '/resources/zones/methods/list/': 'zones-get' },
  models: [],
  operations: ['zones-get'],
};

const site = {
  operations: { 'zones-get': 'zones/methods/list' },
  sections: new Set(['/zones/']),
};

test('an old method page redirects to the page of its operation', () => {
  const plan = planStainlessRedirects(snapshot, site);
  assert.equal(plan.lookup['/resources/zones/methods/list/'], '/zones/methods/list/');
});

test('an old resource page redirects to the deepest section holding all its methods', () => {
  const plan = planStainlessRedirects(
    {
      resources: ['/resources/zero_trust/', '/resources/zero_trust/subresources/dex/'],
      methods: {
        '/resources/zero_trust/subresources/dex/methods/list/': 'dex-list',
        '/resources/zero_trust/subresources/dex/subresources/fleet_status/methods/get/': 'dex-fleet',
        '/resources/zero_trust/subresources/access/methods/get/': 'access-get',
      },
      models: [],
      operations: [],
    },
    {
      operations: {
        'dex-list': 'zero-trust/dex/tests/methods/list',
        'dex-fleet': 'zero-trust/dex/devices/methods/get',
        'access-get': 'zero-trust/access/methods/get',
      },
      sections: new Set([
        '/zero-trust/',
        '/zero-trust/dex/',
        '/zero-trust/dex/tests/',
        '/zero-trust/dex/devices/',
        '/zero-trust/access/',
      ]),
    },
  );
  assert.equal(plan.lookup['/resources/zero_trust/subresources/dex/'], '/zero-trust/dex/');
  assert.equal(plan.lookup['/resources/zero_trust/'], '/zero-trust/');
});

test('what the site no longer publishes falls back to the nearest old ancestor that redirects', () => {
  const plan = planStainlessRedirects(
    {
      resources: ['/resources/$shared/', '/resources/accounts/', '/resources/accounts/subresources/profile/'],
      methods: {
        '/resources/accounts/methods/list/': 'accounts-list',
        '/resources/accounts/subresources/profile/methods/get/': 'profile-get',
      },
      models: ['/resources/accounts/subresources/profile/models/profile/'],
      operations: ['profile-get'],
    },
    { operations: { 'accounts-list': 'accounts/methods/list' }, sections: new Set(['/accounts/']) },
  );
  assert.equal(plan.lookup['/resources/accounts/subresources/profile/methods/get/'], '/accounts/');
  assert.equal(plan.lookup['/resources/accounts/subresources/profile/'], '/accounts/');
  assert.equal(plan.lookup['/resources/$shared/'], '/');
  assert.deepEqual(plan.fallbacks.sort(), [
    '/operations/profile-get/',
    '/resources/$shared/',
    '/resources/accounts/subresources/profile/',
    '/resources/accounts/subresources/profile/methods/get/',
    '/resources/accounts/subresources/profile/models/profile/',
  ]);
});

test('old model, operation and overview pages redirect too', () => {
  const plan = planStainlessRedirects(
    {
      resources: ['/resources/zones/', '/resources/zones/subresources/holds/'],
      methods: {
        '/resources/zones/methods/list/': 'zones-get',
        '/resources/zones/subresources/holds/methods/get/': 'holds-get',
      },
      models: ['/resources/zones/models/zone/'],
      operations: ['zones-get', 'holds-get', 'gone'],
    },
    site,
  );
  assert.equal(plan.lookup['/resources/zones/models/zone/'], '/zones/');
  assert.equal(plan.lookup['/operations/zones-get/'], '/zones/methods/list/');
  assert.equal(plan.lookup['/operations/holds-get/'], '/zones/');
  assert.equal(plan.lookup['/operations/gone/'], '/');
  assert.equal(plan.lookup['/overview/'], '/');
});

test('the request-time lookup redirects every old page, its Markdown twin and its language variants', () => {
  const lookup = {
    '/overview/': '/',
    '/resources/zones/': '/zones/',
    '/resources/zones/methods/list/': '/zones/methods/list/',
    '/resources/zones/models/zone/': '/zones/',
    '/resources/ai/subresources/models/': '/ai/models/',
    '/operations/zones-get/': '/zones/methods/list/',
  };
  const cases: [path: string, search: string, target: string | undefined][] = [
    ['/resources/zones/', '', '/zones/'],
    ['/resources/zones/methods/list/', '?a=1', '/zones/methods/list/?a=1'],
    ['/resources/zones/models/zone/', '', '/zones/'],
    ['/operations/zones-get/', '', '/zones/methods/list/'],
    ['/overview/', '', '/'],
    ['/resources/zones/methods/list/index.md', '', '/zones/methods/list/index.md'],
    ['/resources/zones/index.md', '?a=1', '/zones/index.md?a=1'],
    ['/overview/index.md', '', '/index.md'],
    ['/terraform/', '', '/?lang=terraform'],
    ['/terraform/index.md', '', '/index.md'],
    ['/terraform/resources/zones/methods/list/', '?a=1', '/zones/methods/list/?a=1&lang=terraform'],
    ['/terraform/resources/zones/methods/list/index.md', '', '/zones/methods/list/index.md'],
    ['/terraform/resources/zones/models/zone/', '', '/zones/?lang=terraform'],
    ['/python/resources/zones/', '?a=1', '/zones/?a=1&lang=python'],
    ['/python/resources/zones/methods/list/', '?lang=go', '/zones/methods/list/?lang=python'],
    ['/typescript/resources/zones/methods/list/', '', '/zones/methods/list/?lang=typescript'],
    ['/node/resources/zones/methods/list/', '', '/zones/methods/list/?lang=typescript'],
    ['/node/resources/zones/methods/list/index.md', '', '/zones/methods/list/index.md'],
    ['/go/', '', '/?lang=go'],
    ['/typescript/index.md', '', '/index.md'],
    ['/python/operations/zones-get/', '', undefined],
    ['/ruby/resources/zones/', '', undefined],
    ['/resources/ai/subresources/models/', '', '/ai/models/'],
    ['/resources/ai/subresources/models/index.md', '', '/ai/models/index.md'],
    ['/resources/nope/', '', undefined],
    ['/resources/zones/models/nope/', '', undefined],
    ['/operations/zones-get/index.md', '', undefined],
    ['/terraform/operations/zones-get/', '', undefined],
    ['/resources/nope/index.md', '', undefined],
    ['/terraform/resources/nope/', '', undefined],
    ['/zones/', '', undefined],
    ['/zones/index.md', '', undefined],
    ['/', '', undefined],
    ['/index.md', '', undefined],
  ];
  for (const [path, search, target] of cases) {
    assert.equal(stainlessRedirect(path, search, lookup), target, `${path}${search}`);
  }
});

test('the request-time lookup holds every old page', () => {
  const plan = planStainlessRedirects({ ...snapshot, models: ['/resources/zones/models/zone/'] }, site);
  assert.deepEqual(plan.lookup, {
    '/overview/': '/',
    '/resources/zones/': '/zones/',
    '/resources/zones/methods/list/': '/zones/methods/list/',
    '/resources/zones/models/zone/': '/zones/',
    '/operations/zones-get/': '/zones/methods/list/',
  });
});

test('an old resource whose methods moved to several products redirects within the one holding most', () => {
  const plan = planStainlessRedirects(
    {
      resources: ['/resources/zones/'],
      methods: {
        '/resources/zones/methods/list/': 'zones-get',
        '/resources/zones/subresources/holds/methods/get/': 'holds-get',
        '/resources/zones/subresources/analytics/methods/get/': 'analytics-get',
      },
      models: [],
      operations: [],
    },
    {
      operations: {
        'zones-get': 'zones/methods/list',
        'holds-get': 'zones/holds/methods/get',
        'analytics-get': 'observability/zones/methods/get',
      },
      sections: new Set(['/zones/', '/zones/holds/', '/observability/', '/observability/zones/']),
    },
  );
  assert.equal(plan.lookup['/resources/zones/'], '/zones/');
});
