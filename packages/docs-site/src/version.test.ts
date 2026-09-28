import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUDFLARE_API_VERSION_CODENAMES,
  cloudflareApiVersionLabel,
  cloudflareApiVersionSlug,
  cloudflareApiVersionSortKey,
  compareCloudflareApiVersions,
  isDated,
  isLegacy,
  isPreview,
  isStable,
  parseCloudflareApiVersion,
  tryParseCloudflareApiVersion,
} from './version.ts';

test('parses a dated major release', () => {
  const version = parseCloudflareApiVersion('2027-01-01.air');
  assert.ok(version.channel === 'dated');
  assert.equal(version.codename, 'air');
  assert.equal(version.date, '2027-01-01');
  assert.deepEqual([version.year, version.month, version.day], [2027, 1, 1]);
  assert.equal(version.wire, '2027-01-01.air');
});

test('monthly minors reuse the major codename', () => {
  for (const wire of ['2027-02-01.air', '2027-03-01.air', '2027-06-01.air']) {
    const version = parseCloudflareApiVersion(wire);
    assert.ok(version.channel === 'dated');
    assert.equal(version.codename, 'air');
    assert.equal(version.wire, wire);
  }
});

test('major boundaries advance the codename alphabetically', () => {
  const cases: Array<[string, string]> = [
    ['2027-01-01.air', 'air'],
    ['2027-07-01.breeze', 'breeze'],
    ['2028-01-01.cirrus', 'cirrus'],
    ['2028-07-01.dew', 'dew'],
  ];
  for (const [wire, codename] of cases) {
    const version = parseCloudflareApiVersion(wire);
    assert.ok(version.channel === 'dated');
    assert.equal(version.codename, codename);
  }
});

test('every codename in the alphabet parses', () => {
  for (const codename of CLOUDFLARE_API_VERSION_CODENAMES) {
    const version = parseCloudflareApiVersion(`2030-01-01.${codename}`);
    assert.ok(version.channel === 'dated');
    assert.equal(version.codename, codename);
  }
});

test('parses the preview channel', () => {
  const version = parseCloudflareApiVersion('2027-02-01.preview');
  assert.ok(version.channel === 'preview');
  assert.equal(version.date, '2027-02-01');
  assert.equal(version.wire, '2027-02-01.preview');
});

test('parses the legacy epoch', () => {
  const version = parseCloudflareApiVersion('legacy');
  assert.ok(version.channel === 'legacy');
  assert.equal(version.wire, 'legacy');
});

test('parsing is case-insensitive and canonicalizes to lowercase', () => {
  assert.equal(parseCloudflareApiVersion('2027-01-01.AIR').wire, '2027-01-01.air');
  assert.equal(parseCloudflareApiVersion('  2027-02-01.Preview  ').wire, '2027-02-01.preview');
  assert.equal(parseCloudflareApiVersion('LEGACY').wire, 'legacy');
});

test('canonical wire round-trips through the parser', () => {
  for (const input of ['legacy', '2027-01-01.air', '2027-02-01.preview', '2028-07-01.dew']) {
    const once = parseCloudflareApiVersion(input);
    assert.equal(parseCloudflareApiVersion(once.wire).wire, once.wire);
  }
});

test('rejects invalid versions with descriptive errors', () => {
  assert.throws(() => parseCloudflareApiVersion('latest'), /"latest" is not a valid API version/);
  assert.throws(() => parseCloudflareApiVersion('2027-01-01'), /expected "legacy" or "YYYY-MM-DD/);
  assert.throws(() => parseCloudflareApiVersion('2027-13-01.air'), /not a real calendar date/);
  assert.throws(() => parseCloudflareApiVersion('2027-02-30.air'), /not a real calendar date/);
  assert.throws(() => parseCloudflareApiVersion('2027-01-01.foo'), /not a known codename/);
  assert.throws(() => parseCloudflareApiVersion('2027-1-1.air'), /expected "legacy" or "YYYY-MM-DD/);
  assert.throws(() => parseCloudflareApiVersion(''), /must not be empty/);
  assert.throws(() => parseCloudflareApiVersion('garbage'), /expected "legacy" or "YYYY-MM-DD/);
});

test('leap-year dates are validated', () => {
  const leap = parseCloudflareApiVersion('2028-02-29.air');
  assert.ok(leap.channel === 'dated');
  assert.equal(leap.date, '2028-02-29');
  assert.throws(() => parseCloudflareApiVersion('2027-02-29.air'), /not a real calendar date/);
});

test('tryParse returns null on invalid input and a value on valid input', () => {
  assert.equal(tryParseCloudflareApiVersion('nope'), null);
  assert.equal(tryParseCloudflareApiVersion('latest'), null);
  assert.equal(tryParseCloudflareApiVersion('2027-01-01.air')?.channel, 'dated');
});

test('compare orders legacy < dated (by date) < same-date preview', () => {
  const scrambled = [
    '2027-07-01.breeze',
    'legacy',
    '2027-02-01.preview',
    '2027-01-01.air',
    '2027-02-01.air',
    '2028-01-01.cirrus',
  ].map(parseCloudflareApiVersion);
  const ordered = [...scrambled].sort(compareCloudflareApiVersions).map((version) => version.wire);
  assert.deepEqual(ordered, [
    'legacy',
    '2027-01-01.air',
    '2027-02-01.air',
    '2027-02-01.preview',
    '2027-07-01.breeze',
    '2028-01-01.cirrus',
  ]);
});

test('sort keys are monotonically increasing in release order', () => {
  const keys = ['legacy', '2027-01-01.air', '2027-02-01.air', '2027-02-01.preview', '2027-07-01.breeze']
    .map(parseCloudflareApiVersion)
    .map(cloudflareApiVersionSortKey);
  for (let i = 1; i < keys.length; i++) {
    const previous = keys[i - 1];
    const current = keys[i];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(current > previous, `${current} should sort after ${previous}`);
  }
});

test('predicates classify each channel', () => {
  const legacy = parseCloudflareApiVersion('legacy');
  const dated = parseCloudflareApiVersion('2027-01-01.air');
  const preview = parseCloudflareApiVersion('2027-02-01.preview');
  assert.deepEqual([isLegacy(legacy), isDated(dated), isPreview(preview)], [true, true, true]);
  assert.deepEqual([isStable(legacy), isStable(dated), isStable(preview)], [true, true, false]);
});

test('labels render for display', () => {
  const label = (wire: string): string => cloudflareApiVersionLabel(parseCloudflareApiVersion(wire));
  assert.equal(label('legacy'), 'Legacy');
  assert.equal(label('2027-01-01.air'), '2027-01-01 (Air)');
  assert.equal(label('2027-02-01.preview'), '2027-02-01 (Preview)');
});

test('the URL slug is the bare date; the codename and preview suffix never appear', () => {
  const slug = (wire: string): string => cloudflareApiVersionSlug(parseCloudflareApiVersion(wire));
  assert.equal(slug('2027-01-01.air'), '2027-01-01');
  assert.equal(slug('2027-07-01.breeze'), '2027-07-01');
  // Preview collapses to its date too — "only the date" appears in the URL.
  assert.equal(slug('2028-01-01.preview'), '2028-01-01');
  // Legacy has no date, so it keeps its literal token.
  assert.equal(slug('legacy'), 'legacy');
});
