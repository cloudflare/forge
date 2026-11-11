import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, score } from '../src/score.ts';
import { index, words } from '../src/search.ts';

const tools = [
  { name: 'zones_list', description: 'Lists zones.', method: 'GET', path: '/zones' },
  {
    name: 'dns_records_list',
    description: 'Lists the DNS records of a zone.',
    method: 'GET',
    path: '/zones/{zone_id}/dns_records',
  },
  {
    name: 'dns_records_create',
    description: 'Creates a DNS record.',
    method: 'POST',
    path: '/zones/{zone_id}/dns_records',
  },
  {
    name: 'zeroTrust_access_applications_list',
    description: 'Lists Access applications.',
    method: 'GET',
    path: '/{account_or_zone}/{account_or_zone_id}/access/apps',
  },
];

test('splits names into words, at camelCase and underscores, without plural s', () => {
  assert.deepEqual(words('zeroTrust_access_applications_list'), ['zero', 'trust', 'access', 'application', 'list']);
  assert.deepEqual(words('Lists DNS records.'), ['list', 'dns', 'record']);
});

test('ranks the tool whose name and description share the most rare words first', () => {
  assert.equal(index(tools)('create a DNS record')[0]?.name, 'dns_records_create');
  assert.equal(index(tools)('list access applications')[0]?.name, 'zeroTrust_access_applications_list');
});

test('scores where each task ranked its expected method, by method and path as forge writes them', () => {
  const result = score(tools, [
    { task: 'list DNS records', expect: ['GET /zones/{zone_id}/dns_records'] },
    { task: 'list zones', expect: ['GET /zones'] },
    { task: 'purge the cache', expect: ['POST /zones/{zone_id}/purge_cache'] },
  ]);
  assert.equal(result.tasks, 3);
  assert.equal(result.top1, 2);
  assert.deepEqual(
    result.results.map(({ rank }) => rank),
    [1, 1, undefined],
  );
  assert.deepEqual(result.results[2]?.expected, []);
  assert.ok(Math.abs(result.mrr - 2 / 3) < 1e-9);
  assert.match(markdown(result), /\| purge the cache \| >20 \| no tool \|/);
});
