import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unwrapCloudflareEnvelope } from '../custom/core/fetcher/unwrapCloudflareEnvelope.js';

test('custom runtime: peels bare result when result is not an array', () => {
  assert.deepEqual(unwrapCloudflareEnvelope({ success: true, result: { id: 1 }, errors: [], messages: [] }), { id: 1 });
});

test('custom runtime: peels bare result even if result_info is present on non-list', () => {
  assert.deepEqual(
    unwrapCloudflareEnvelope({
      success: true,
      result: { id: 1 },
      result_info: { page: 1 },
      errors: [],
      messages: [],
    }),
    { id: 1 },
  );
});

test('custom runtime: keeps page shape when result is an array', () => {
  assert.deepEqual(
    unwrapCloudflareEnvelope({
      success: true,
      result: [{ id: 1 }],
      result_info: { page: 1 },
      errors: [],
      messages: [],
    }),
    { result: [{ id: 1 }], result_info: { page: 1 } },
  );
});

test('custom runtime: array result without result_info still returns page wrapper', () => {
  assert.deepEqual(unwrapCloudflareEnvelope({ success: true, result: [{ id: 1 }], errors: [], messages: [] }), {
    result: [{ id: 1 }],
    result_info: undefined,
  });
});

test('custom runtime: explicit cloudflare-page preserves non-array page types', () => {
  assert.deepEqual(
    unwrapCloudflareEnvelope({ success: true, result: { items: [] }, errors: [], messages: [] }, 'cloudflare-page'),
    { result: { items: [] }, result_info: undefined },
  );
});

test('custom runtime: non-envelope bodies pass through', () => {
  assert.deepEqual(unwrapCloudflareEnvelope({ ok: true }), { ok: true });
  assert.equal(unwrapCloudflareEnvelope(null), null);
});

test('custom runtime: success:false throws CloudflareApiEnvelopeError', () => {
  assert.throws(
    () => unwrapCloudflareEnvelope({ success: false, result: null, errors: [{ message: 'nope' }] }),
    (err: unknown) => err instanceof Error && err.name === 'CloudflareApiEnvelopeError',
  );
});
