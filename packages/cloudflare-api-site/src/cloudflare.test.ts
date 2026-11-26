import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudflareFormatIdentifier } from './cloudflare.ts';

test('formatIdentifier is acronym-aware and title-cases the rest', () => {
  assert.equal(cloudflareFormatIdentifier('dns'), 'DNS');
  assert.equal(cloudflareFormatIdentifier('dns_records'), 'DNS Records');
  assert.equal(cloudflareFormatIdentifier('zone-transfers'), 'Zone Transfers');
  assert.equal(cloudflareFormatIdentifier('acls'), 'ACLs');
  assert.equal(cloudflareFormatIdentifier('widgets'), 'Widgets');
});
