import assert from 'node:assert/strict';
import { test } from 'node:test';

import { join } from '../custom/core/url/join.js';

const BASE = 'https://api.cloudflare.com/client/v4';

test('custom join: preserves a query string embedded in the path', () => {
  assert.equal(join(BASE, 'accounts/x/foo?bar=baz'), `${BASE}/accounts/x/foo?bar=baz`);
});

test('custom join: preserves multiple params and separators (no %3F mangling)', () => {
  const result = join(BASE, 'zones/1/dns_records?type=A&name=example.com&page=2');
  assert.equal(result, `${BASE}/zones/1/dns_records?type=A&name=example.com&page=2`);
  assert.ok(!result.includes('%3F'), 'the "?" must not be percent-encoded into the path');
});

test('custom join: preserves a fragment', () => {
  assert.equal(join('https://ex.com', 'a#frag'), 'https://ex.com/a#frag');
});

test('custom join: preserves query and fragment together', () => {
  assert.equal(join('https://ex.com', 'a?x=1#frag'), 'https://ex.com/a?x=1#frag');
});

test('custom join: does not double-encode already-encoded query values', () => {
  assert.equal(join('https://ex.com', 'a?x=a%20b'), 'https://ex.com/a?x=a%20b');
});

test('custom join: merges a peeled query after a query already on the base', () => {
  assert.equal(join('https://ex.com/b?a=1', 'c?d=2'), 'https://ex.com/b/c?a=1&d=2');
});

test('custom join: keeps trailing slash on the path portion when a query follows', () => {
  assert.equal(join('https://ex.com', 'a/?x=1'), 'https://ex.com/a/?x=1');
});

// --- stock behaviour that must remain unchanged ---

test('custom join: plain path join is unchanged', () => {
  assert.equal(join(BASE, 'accounts/x/foo'), `${BASE}/accounts/x/foo`);
});

test('custom join: trailing-slash preservation is unchanged', () => {
  assert.equal(join('https://ex.com', 'a/'), 'https://ex.com/a/');
});

test('custom join: empty base and no-segment cases are unchanged', () => {
  assert.equal(join('', 'a'), '');
  assert.equal(join(BASE), BASE);
});

test('custom join: relative base keeps the query literal (no encoding branch)', () => {
  assert.equal(join('/client/v4', 'a?x=1'), '/client/v4/a?x=1');
});
