import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fernAvailabilityJsDocLine, FERN_PRERELEASE_JSDOC, parseFernAvailability } from './fern-availability.ts';

test('parses every Fern endpoint status string', () => {
  for (const status of ['alpha', 'beta', 'preview', 'generally-available', 'deprecated', 'legacy'] as const) {
    assert.deepEqual(parseFernAvailability(status, 'listWidgets'), { status });
  }
});

test('parses an availability object and trims the message', () => {
  assert.deepEqual(
    parseFernAvailability({ status: 'legacy', message: '  Use the v2 widgets endpoint.  ' }, 'listWidgets'),
    { status: 'legacy', message: 'Use the v2 widgets endpoint.' },
  );
});

test('rejects statuses outside the Fern endpoint vocabulary', () => {
  assert.throws(
    () => parseFernAvailability('stable', 'listWidgets'),
    /listWidgets: invalid x-fern-availability stable/,
  );
  assert.throws(
    () => parseFernAvailability({ status: 'in-development' }, 'listWidgets'),
    /listWidgets: invalid x-fern-availability in-development/,
  );
});

test('rejects malformed availability objects', () => {
  assert.throws(
    () => parseFernAvailability({ message: 'Missing status' }, 'listWidgets'),
    /invalid x-fern-availability/,
  );
  assert.throws(
    () => parseFernAvailability({ status: 'beta', message: '   ' }, 'listWidgets'),
    /listWidgets: invalid x-fern-availability message/,
  );
  assert.throws(
    () => parseFernAvailability({ status: 'beta', note: 'nope' }, 'listWidgets'),
    /invalid x-fern-availability property "note"/,
  );
  assert.throws(() => parseFernAvailability(null, 'listWidgets'), /invalid x-fern-availability null/);
});

test('maps availability onto the JSDoc tags Fern emits for TypeScript', () => {
  assert.equal(fernAvailabilityJsDocLine({ status: 'deprecated' }), '@deprecated');
  assert.equal(
    fernAvailabilityJsDocLine({ status: 'deprecated', message: 'Use PATCH /widgets.' }),
    '@deprecated Use PATCH /widgets.',
  );
  assert.equal(fernAvailabilityJsDocLine({ status: 'preview' }), `@beta ${FERN_PRERELEASE_JSDOC}`);
  assert.equal(
    fernAvailabilityJsDocLine({ status: 'alpha', message: 'Subject to change.' }),
    '@beta Subject to change.',
  );
  assert.equal(fernAvailabilityJsDocLine({ status: 'generally-available' }), undefined);
  assert.equal(fernAvailabilityJsDocLine({ status: 'legacy', message: 'Still supported.' }), undefined);
});
