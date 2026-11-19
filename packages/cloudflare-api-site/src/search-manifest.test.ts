import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchManifest, type SearchPage } from './search-manifest.ts';

const root: SearchPage = { kind: 'api', coordinate: 'api', href: '/', title: 'API Reference', breadcrumbs: [] };
const product: SearchPage = {
  kind: 'section',
  coordinate: 'tags.zero-trust',
  href: '/zero-trust/',
  title: 'Zero Trust',
  description: 'Zero Trust API',
  descriptionHtml: '<p>Zero Trust API</p>\n',
  breadcrumbs: [{ label: 'API Reference', href: '/' }],
};
const resource: SearchPage = {
  kind: 'section',
  coordinate: 'tags.zero-trust-devices',
  href: '/zero-trust/devices/',
  title: 'Devices',
  breadcrumbs: [
    { label: 'API Reference', href: '/' },
    { label: 'Zero Trust', href: '/zero-trust/' },
  ],
};
const operation: SearchPage = {
  kind: 'operation',
  coordinate: 'devices-list-devices',
  href: '/zero-trust/devices/methods/list/',
  title: 'List devices',
  description: 'Lists **WARP** devices &amp; more.',
  descriptionHtml: '<p>Lists <strong>WARP</strong> devices &amp; more.</p>\n',
  breadcrumbs: [...resource.breadcrumbs, { label: 'Devices', href: '/zero-trust/devices/' }],
  method: 'GET',
  path: '/accounts/{account_id}/devices',
};

test('an operation record carries its method, endpoint, and plain-text description', () => {
  const [record] = buildSearchManifest([root, operation], '/api/').records;
  assert.deepEqual(record!.metadata, {
    kind: 'http_method',
    title: 'List devices',
    path: '/api/zero-trust/devices/methods/list/',
    crumbs: 'Zero Trust\u001fDevices\u001fList devices',
    detail: 'GET\u001f/accounts/{account_id}/devices\u001fLists WARP devices & more.',
  });
});

test('a resource record is detailed by its dotted name', () => {
  const records = buildSearchManifest([root, product, resource], '/api/').records;
  assert.deepEqual(
    records.map((record) => [record.metadata.crumbs, record.metadata.detail, record.content]),
    [
      ['Zero Trust', 'zero-trust', 'Zero Trust\nzero-trust\nZero Trust API'],
      ['Zero Trust\u001fDevices', 'zero-trust.devices', 'Devices\nZero Trust > Devices\nzero-trust.devices'],
    ],
  );
});

test('source ids hash the kind and coordinate, so they survive a moved page', () => {
  const [first] = buildSearchManifest([root, operation]).records;
  const [moved] = buildSearchManifest([root, { ...operation, href: '/devices/methods/list/' }]).records;
  assert.match(first!.sourceId, /^http_method-[0-9a-f]{64}\.md$/);
  assert.equal(moved!.sourceId, first!.sourceId);
});

test('metadata is cut at 500 code points and content at 3000', () => {
  const long = '😀'.repeat(4_000);
  const [record] = buildSearchManifest([root, { ...operation, title: long, descriptionHtml: long }]).records;
  assert.equal([...record!.metadata.title].length, 500);
  assert.equal([...record!.metadata.detail].length, 500);
  assert.equal([...record!.metadata.crumbs].length, 500);
  assert.equal([...record!.content].length, 3_000);
});
