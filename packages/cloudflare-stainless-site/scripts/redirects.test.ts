import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRedirectsSnapshot, compareSnapshots, type RedirectsSdkJson } from './redirects.ts';

const SPEC = {
  paths: {
    '/zones': { get: { operationId: 'zones-get' } },
    '/zones/{zone_id}/holds': { post: { operationId: 'zone-holds-create' }, parameters: [] },
    '/accounts/{account_id}/load_balancers': { get: { operationId: 'account-load-balancers-list' } },
    '/zones/{zone_id}/load_balancers': { get: { operationId: 'zone-load-balancers-list' } },
    '/user': { get: { operationId: 'user-get' } },
  },
};

const SDK_JSON: RedirectsSdkJson = {
  resources: {
    $shared: { configRef: '#/resources/$shared' },
    zones: {
      configRef: '#/resources/zones',
      methods: {
        list: { configRef: '#/resources/zones/methods/list', oasRef: '#/paths/%2Fzones/get', endpoint: 'get /zones' },
      },
      subresources: {
        holds: {
          configRef: '#/resources/zones/subresources/holds',
          methods: {
            create: {
              configRef: '#/resources/zones/subresources/holds/methods/create',
              oasRef: '#/paths/%2Fzones%2F%7Bzone_id%7D%2Fholds/post',
              endpoint: 'post /zones/{zone_id}/holds',
            },
          },
        },
      },
    },
  },
};

test('the snapshot holds the old resource and method pages, each method with its operationId, and every operationId', () => {
  assert.deepEqual(buildRedirectsSnapshot({ sdkJson: SDK_JSON, spec: SPEC, modelRedirects: {} }), {
    resources: ['/resources/$shared/', '/resources/zones/', '/resources/zones/subresources/holds/'],
    methods: {
      '/resources/zones/methods/list/': 'zones-get',
      '/resources/zones/subresources/holds/methods/create/': 'zone-holds-create',
    },
    models: [],
    operations: [
      'account-load-balancers-list',
      'user-get',
      'zone-holds-create',
      'zone-load-balancers-list',
      'zones-get',
    ],
  });
});

function withMethod(name: string, oasRef: string, endpoint: string): RedirectsSdkJson {
  return {
    resources: {
      load_balancers: {
        configRef: '#/resources/load_balancers',
        methods: { [name]: { configRef: `#/resources/load_balancers/methods/${name}`, oasRef, endpoint } },
      },
    },
  };
}

test('a method on an {accounts_or_zones} path takes the account operation, or the zone one without it', () => {
  const templated = '#/paths/%2F%7Baccounts_or_zones%7D%2F%7Baccount_or_zone_id%7D%2Fload_balancers/get';
  const endpoint = 'get /{accounts_or_zones}/{account_or_zone_id}/load_balancers';
  const build = (spec: typeof SPEC) =>
    buildRedirectsSnapshot({ sdkJson: withMethod('list', templated, endpoint), spec, modelRedirects: {} }).methods;
  assert.deepEqual(build(SPEC), { '/resources/load_balancers/methods/list/': 'account-load-balancers-list' });
  const zonesOnly = structuredClone(SPEC) as { paths: Record<string, unknown> };
  delete zonesOnly.paths['/accounts/{account_id}/load_balancers'];
  assert.deepEqual(build(zonesOnly as typeof SPEC), {
    '/resources/load_balancers/methods/list/': 'zone-load-balancers-list',
  });
});

test('a method whose operation is not in the spec fails the run, naming its page', () => {
  assert.throws(
    () =>
      buildRedirectsSnapshot({
        sdkJson: withMethod('gone', '#/paths/%2Fgone/get', 'get /gone'),
        spec: SPEC,
        modelRedirects: {},
      }),
    /\/resources\/load_balancers\/methods\/gone\/ \(get \/gone\)/,
  );
});

test("the model pages are the old site's HTTP model redirects", () => {
  const { models } = buildRedirectsSnapshot({
    sdkJson: SDK_JSON,
    spec: SPEC,
    modelRedirects: {
      '/resources/zones/models/zone': 'resources/zones',
      '/resources/$shared/models/asn': 'resources/$shared',
      '/python/resources/zones/models/zone': 'python/resources/zones',
    },
  });
  assert.deepEqual(models, ['/resources/$shared/models/asn/', '/resources/zones/models/zone/']);
});

test('a run reports what it adds, removes and remaps against the previous snapshot', () => {
  const previous = {
    resources: ['/resources/zones/', '/resources/gone/'],
    methods: { '/resources/zones/methods/list/': 'zones-get', '/resources/zones/methods/get/': 'zones-0-get' },
    models: ['/resources/zones/models/zone/'],
    operations: ['zones-get', 'zones-0-get'],
  };
  const next = {
    resources: ['/resources/zones/', '/resources/new/'],
    methods: { '/resources/zones/methods/list/': 'zones-list', '/resources/zones/methods/get/': 'zones-0-get' },
    models: ['/resources/zones/models/zone/'],
    operations: ['zones-list', 'zones-0-get'],
  };
  assert.deepEqual(compareSnapshots(previous, next), {
    added: ['operation zones-list', 'resource /resources/new/'],
    removed: ['operation zones-get', 'resource /resources/gone/'],
    remapped: ['/resources/zones/methods/list/: zones-get → zones-list'],
  });
});
