import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiPageProps } from '@cloudflare/nimbus-docs/api';
import { apiPageCard, commandCard, ogCardPath, ogCardVersion, pagePathFor, parseOgCard } from './og/card.ts';

type Page = ApiPageProps['page'];
const crumbs = (...labels: string[]) => labels.map((label) => ({ label, href: '/' }));

test('an operation card shows its method and path', () => {
  const page = {
    kind: 'operation',
    title: 'List DNS Records',
    method: 'get',
    path: '/zones/{zone_id}/dns_records',
    breadcrumbs: [],
  } as unknown as Page;
  assert.deepEqual(apiPageCard(page), {
    title: 'List DNS Records',
    method: 'GET',
    code: '/zones/{zone_id}/dns_records',
  });
});

test("the API's card shows its base URL", () => {
  const page = {
    kind: 'api',
    title: 'API Reference',
    servers: ['https://api.cloudflare.com/client/v4/'],
    breadcrumbs: [],
  } as unknown as Page;
  assert.deepEqual(apiPageCard(page), { title: 'API Reference', code: 'https://api.cloudflare.com/client/v4' });
});

test('a section card names its product and what it holds', () => {
  const resource = {
    kind: 'section',
    title: 'Records',
    breadcrumbs: crumbs('API Reference', 'DNS'),
    operations: Array(13).fill({}),
  };
  assert.deepEqual(apiPageCard(resource as unknown as Page), { title: 'Records', pills: ['DNS', '13 operations'] });

  const product = {
    kind: 'section',
    title: 'DNS',
    breadcrumbs: crumbs('API Reference'),
    operations: [],
    sections: Array(6).fill({}),
  };
  assert.deepEqual(apiPageCard(product as unknown as Page), { title: 'DNS', pills: ['6 sections'] });

  const one = { kind: 'section', title: 'Usage', breadcrumbs: crumbs('API Reference', 'DNS'), operations: [{}] };
  assert.deepEqual(apiPageCard(one as unknown as Page)?.pills, ['DNS', '1 operation']);
});

test('a command card shows its usage', () => {
  assert.deepEqual(commandCard('Deploy', { usage: 'cf deploy [options]' }), {
    title: 'Deploy',
    code: 'cf deploy [options]',
  });
});

test('cards live at /og/<route>.png, with index for the root', () => {
  assert.equal(ogCardPath('/dns/records/'), '/og/dns/records.png');
  assert.equal(ogCardPath('/'), '/og/index.png');
  assert.equal(pagePathFor('dns/records'), '/dns/records/');
  assert.equal(pagePathFor('index'), '/');
  assert.equal(pagePathFor(ogCardPath('/tooling/deploy/').slice(4, -4)), '/tooling/deploy/');
});

test('the version changes with the card and only with the card', () => {
  const card = { title: 'Records', pills: ['DNS', '13 operations'] };
  assert.equal(ogCardVersion(card), ogCardVersion({ ...card }));
  assert.notEqual(ogCardVersion(card), ogCardVersion({ ...card, pills: ['DNS', '14 operations'] }));
  assert.match(ogCardVersion(card), /^[0-9a-z]+$/);
});

test('a card reads back from its meta tag, and a malformed tag reads as none', () => {
  const card = { title: 'List DNS Records', method: 'GET', code: '/zones/{zone_id}/dns_records' };
  assert.deepEqual(parseOgCard(JSON.stringify(card)), card);
  assert.equal(parseOgCard('{'), undefined);
  assert.equal(parseOgCard('{"title":""}'), undefined);
  assert.equal(parseOgCard('{"title":"x","pills":[1]}'), undefined);
  assert.equal(parseOgCard('{"title":"x","code":3}'), undefined);
});
