import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { materialize, parseManifest, sync, type ApiVersionsManifest } from './api-versions.ts';

const tempDir = () => mkdtemp(join(tmpdir(), 'api-versions-'));

const COMMIT_A = 'a'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const COMMIT_B = 'b'.repeat(40);
const DIGEST_B = '2'.repeat(64);

const manifestText = (releases: unknown[]) =>
  JSON.stringify({
    format: 1,
    source: { repository: 'cloudflare/api-schemas', branch: 'main', path: 'openapi.json' },
    releases,
  });

const emptyManifest = (): ApiVersionsManifest => parseManifest(manifestText([]));

/** Serves `specs[commit]` at the raw URL of `openapi.json` in `cloudflare/api-schemas`, and records each request. */
function specServer(specs: Record<string, string>) {
  const requested: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const match =
      /^https:\/\/raw\.githubusercontent\.com\/cloudflare\/api-schemas\/([0-9a-f]{40})\/openapi\.json$/.exec(url);
    const body = match ? specs[match[1]!] : undefined;
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body);
  };
  return { fetch, requested };
}

// Digests of the literal specs below, computed with `shasum -a 256`.
const SPEC_310 = '{"openapi":"3.1.0"}';
const SPEC_310_SHA256 = '1f7b61c52c664d551376cf25d7c387f8c0832ba9fe00995f7d12dd1909ea0de5';
const SPEC_303 = '{"openapi":"3.0.3"}';
const SPEC_303_SHA256 = 'fdf4aaaa0affbe5384df2618b7801c719a16d0057ae1956a4fce07202ed4d28f';

test('sync records new releases with their spec digest, oldest first', async () => {
  const { fetch } = specServer({ [COMMIT_A]: SPEC_310, [COMMIT_B]: SPEC_303 });

  const result = await sync(emptyManifest(), {
    fetch,
    releases: [
      { name: '2027-04-01.air', commit: COMMIT_B },
      { name: '2026-10-01.epoch', commit: COMMIT_A },
    ],
  });

  assert.deepEqual(result.manifest.releases, [
    { id: '2026-10-01.epoch', commit: COMMIT_A, sha256: SPEC_310_SHA256 },
    { id: '2027-04-01.air', commit: COMMIT_B, sha256: SPEC_303_SHA256 },
  ]);
  assert.deepEqual(result.added, ['2026-10-01.epoch', '2027-04-01.air']);
});

test('sync skips release candidates, rolling, drafts, prereleases and other names', async () => {
  const { fetch, requested } = specServer({});

  const result = await sync(emptyManifest(), {
    fetch,
    releases: [
      { name: '2026-10-01.epoch-rc1', commit: COMMIT_A },
      { name: '2026-11-01.rolling', commit: COMMIT_A },
      { name: '2027-04-01.air', commit: COMMIT_A, draft: true },
      { name: '2027-05-01.air', commit: COMMIT_A, prerelease: true },
      { name: 'v1.2.3', commit: COMMIT_A },
    ],
  });

  assert.deepEqual(result.manifest.releases, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(requested, []);
});

test('sync keeps recorded releases without fetching them again', async () => {
  const { fetch, requested } = specServer({ [COMMIT_B]: SPEC_303 });
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A }]));

  const result = await sync(manifest, {
    fetch,
    releases: [
      { name: '2026-10-01.epoch', commit: COMMIT_A },
      { name: '2027-04-01.air', commit: COMMIT_B },
    ],
  });

  assert.deepEqual(result.manifest.releases[0], { id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A });
  assert.deepEqual(result.added, ['2027-04-01.air']);
  assert.equal(requested.length, 1);
});

test('sync fails when a recorded release points at another commit, and records nothing', async () => {
  const { fetch } = specServer({ [COMMIT_B]: SPEC_303 });
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A }]));

  await assert.rejects(
    sync(manifest, {
      fetch,
      releases: [
        { name: '2026-10-01.epoch', commit: COMMIT_B },
        { name: '2027-04-01.air', commit: COMMIT_B },
      ],
    }),
    new RegExp(`2026-10-01\\.epoch.*${COMMIT_A}.*${COMMIT_B}`),
  );
});

test('sync keeps a recorded release that disappeared upstream, with a warning', async () => {
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A }]));

  const result = await sync(manifest, { fetch: specServer({}).fetch, releases: [] });

  assert.deepEqual(result.manifest.releases, manifest.releases);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /2026-10-01\.epoch/);
});

test('sync rejects a release whose spec is not an OpenAPI document', async () => {
  const { fetch } = specServer({ [COMMIT_A]: '{"swagger":"2.0"}' });

  await assert.rejects(
    sync(emptyManifest(), { fetch, releases: [{ name: '2026-10-01.epoch', commit: COMMIT_A }] }),
    /not an OpenAPI document/,
  );
});

const COMMIT_ROLLING = 'c'.repeat(40);
const SPEC_ROLLING = '{"openapi":"3.1.0","info":{"title":"rolling"}}';

test('materialize writes every recorded release and rolling, and an index of them', async () => {
  const out = await tempDir();
  const { fetch } = specServer({ [COMMIT_A]: SPEC_310, [COMMIT_B]: SPEC_303, [COMMIT_ROLLING]: SPEC_ROLLING });
  const manifest = parseManifest(
    manifestText([
      { id: '2026-10-01.epoch', commit: COMMIT_A, sha256: SPEC_310_SHA256 },
      { id: '2027-04-01.air', commit: COMMIT_B, sha256: SPEC_303_SHA256 },
    ]),
  );

  const index = await materialize(manifest, { out, rollingCommit: COMMIT_ROLLING, fetch });

  assert.deepEqual(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')), index);
  assert.deepEqual(
    index.releases.map((r) => [r.id, r.file]),
    [
      ['2026-10-01.epoch', '2026-10-01.epoch.json'],
      ['2027-04-01.air', '2027-04-01.air.json'],
    ],
  );
  assert.equal(index.rolling.commit, COMMIT_ROLLING);
  assert.equal(index.rolling.branch, 'main');
  assert.equal(await readFile(join(out, '2026-10-01.epoch.json'), 'utf8'), SPEC_310);
  assert.equal(await readFile(join(out, '2027-04-01.air.json'), 'utf8'), SPEC_303);
  assert.equal(await readFile(join(out, index.rolling.file), 'utf8'), SPEC_ROLLING);
});

test('materialize fails when a release spec does not match its recorded digest', async () => {
  const { fetch } = specServer({ [COMMIT_A]: SPEC_303, [COMMIT_ROLLING]: SPEC_ROLLING });
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: SPEC_310_SHA256 }]));

  await assert.rejects(
    materialize(manifest, { out: await tempDir(), rollingCommit: COMMIT_ROLLING, fetch }),
    new RegExp(`2026-10-01\\.epoch.*${SPEC_303_SHA256}.*${SPEC_310_SHA256}`),
  );
});

test('materialize reuses cached snapshot specs, and always downloads rolling', async () => {
  const cache = await tempDir();
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: SPEC_310_SHA256 }]));
  const first = specServer({ [COMMIT_A]: SPEC_310, [COMMIT_ROLLING]: SPEC_ROLLING });
  await materialize(manifest, { out: await tempDir(), rollingCommit: COMMIT_ROLLING, fetch: first.fetch, cache });

  const second = specServer({ [COMMIT_ROLLING]: SPEC_ROLLING });
  const out = await tempDir();
  await materialize(manifest, { out, rollingCommit: COMMIT_ROLLING, fetch: second.fetch, cache });

  assert.equal(first.requested.length, 2);
  assert.deepEqual(second.requested, [
    `https://raw.githubusercontent.com/cloudflare/api-schemas/${COMMIT_ROLLING}/openapi.json`,
  ]);
  assert.deepEqual(await readdir(cache), [`${COMMIT_A}.json`]);
  assert.deepEqual((await readdir(out)).sort(), ['2026-10-01.epoch.json', 'index.json', 'rolling.json']);
});

test('materialize ignores a cached spec that no longer matches its digest', async () => {
  const cache = await tempDir();
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: SPEC_310_SHA256 }]));
  const stale = specServer({ [COMMIT_A]: SPEC_303, [COMMIT_ROLLING]: SPEC_ROLLING });
  await materialize(manifest, { out: await tempDir(), rollingCommit: COMMIT_ROLLING, fetch: stale.fetch, cache }).catch(
    () => {},
  );

  const fresh = specServer({ [COMMIT_A]: SPEC_310, [COMMIT_ROLLING]: SPEC_ROLLING });
  const out = await tempDir();
  await materialize(manifest, { out, rollingCommit: COMMIT_ROLLING, fetch: fresh.fetch, cache });

  assert.equal(await readFile(join(out, '2026-10-01.epoch.json'), 'utf8'), SPEC_310);
});

test('parses a manifest with a recorded release', () => {
  const manifest = parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A }]));

  assert.deepEqual(manifest.releases, [{ id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A }]);
  assert.equal(manifest.source.path, 'openapi.json');
});

test('rejects releases that are not strictly oldest first', () => {
  const epoch = { id: '2026-10-01.epoch', commit: COMMIT_A, sha256: DIGEST_A };
  const air = { id: '2027-04-01.air', commit: COMMIT_B, sha256: DIGEST_B };

  assert.throws(() => parseManifest(manifestText([air, epoch])), /oldest first.*2026-10-01\.epoch/);
  assert.throws(() => parseManifest(manifestText([epoch, epoch])), /oldest first.*2026-10-01\.epoch/);
});

test('rejects an id that is not a dated version', () => {
  for (const id of ['2026-10-01.rolling', '2026-10-01.epoch-rc1', 'v1.0.0', '2026-02-30.epoch']) {
    assert.throws(
      () => parseManifest(manifestText([{ id, commit: COMMIT_A, sha256: DIGEST_A }])),
      /not a release version/,
      id,
    );
  }
});

test('rejects an unknown format or an unusable source', () => {
  const valid = JSON.parse(manifestText([]));
  const cases: [string, unknown][] = [
    ['format', { ...valid, format: 2 }],
    ['repository', { ...valid, source: { ...valid.source, repository: 'not a repo' } }],
    ['path', { ...valid, source: { ...valid.source, path: '../openapi.json' } }],
    ['branch', { ...valid, source: { ...valid.source, branch: '' } }],
    ['JSON', '{'],
  ];
  for (const [field, value] of cases) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.throws(() => parseManifest(text), new RegExp(field), field);
  }
});

test('rejects a release whose commit is not a full SHA', () => {
  assert.throws(
    () => parseManifest(manifestText([{ id: '2026-10-01.epoch', commit: 'abc123', sha256: DIGEST_A }])),
    /2026-10-01\.epoch.*commit/,
  );
});
