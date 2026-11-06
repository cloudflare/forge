/**
 * The API versions the docs site publishes.
 *
 * - Snapshots: one per GitHub Release of the source repository named `YYYY-MM-DD.<train>`. They are
 *   recorded in `api-versions.json`, each pinned to a commit and the SHA-256 of its spec. The record
 *   is append-only: sync adds releases, and only a reviewed edit changes or removes one.
 * - Rolling: the head of the source branch, resolved at build time and never recorded.
 *
 * Commands, run from the package directory:
 *
 *   sync         record new upstream releases in api-versions.json
 *   materialize  write every snapshot spec, the rolling spec and index.json into --out
 *
 *   node --experimental-strip-types scripts/api-versions.ts sync
 *   node --experimental-strip-types scripts/api-versions.ts materialize --out .forge/sources [--rolling-commit <sha>] [--cache <dir>]
 *
 * `GITHUB_TOKEN` or `GH_TOKEN`, when set, authenticates the GitHub API calls.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

export interface ApiRelease {
  /** The version id, `YYYY-MM-DD.<train>`, which is also the upstream release name. */
  id: string;
  /** The `api-schemas` commit the release pointed at when it was recorded. */
  commit: string;
  /** SHA-256 of the spec's bytes at `commit`. */
  sha256: string;
}

export interface ApiVersionsManifest {
  format: 1;
  source: { repository: string; branch: string; path: string };
  /** Oldest first. */
  releases: ApiRelease[];
}

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const VERSION = /^(\d{4})-(\d{2})-(\d{2})\.([a-z]+)$/;
/** A train name upstream uses for the rolling channel, which is never a release. */
const ROLLING_TRAIN = 'rolling';

function fail(message: string): never {
  throw new Error(`api-versions: ${message}`);
}

/** True for `YYYY-MM-DD.<train>` on a real calendar date, other than the rolling channel. */
export function isReleaseVersion(name: string): boolean {
  const match = VERSION.exec(name);
  if (!match || match[4] === ROLLING_TRAIN) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Release ids sort by date, and the fixed-width date prefix makes string order date order. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A GitHub Release in the source repository, with the commit its tag points at. */
export interface UpstreamRelease {
  name: string;
  commit: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface SyncResult {
  manifest: ApiVersionsManifest;
  /** The ids recorded by this run, oldest first. */
  added: string[];
  warnings: string[];
}

export type Fetch = (input: string | URL | Request) => Promise<Response>;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function specUrl(manifest: ApiVersionsManifest, commit: string): URL {
  if (!COMMIT.test(commit)) fail(`"${commit}" is not a full commit SHA`);
  const { repository, path } = manifest.source;
  return new URL(`https://raw.githubusercontent.com/${repository}/${commit}/${path}`);
}

/** Downloads the spec at `commit` and checks that it is an OpenAPI document. */
export async function downloadSpec(manifest: ApiVersionsManifest, commit: string, fetch: Fetch): Promise<Uint8Array> {
  const url = specUrl(manifest, commit);
  const response = await fetch(url);
  if (!response.ok) fail(`could not download ${url}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new Error(`api-versions: ${url} is not valid JSON`, { cause });
  }
  if (typeof (document as { openapi?: unknown } | null)?.openapi !== 'string') {
    fail(`${url} is not an OpenAPI document`);
  }
  return bytes;
}

/** Records every published upstream release that the manifest lacks. */
export async function sync(
  manifest: ApiVersionsManifest,
  { releases, fetch }: { releases: UpstreamRelease[]; fetch: Fetch },
): Promise<SyncResult> {
  const candidates = releases.filter((r) => !r.draft && !r.prerelease && isReleaseVersion(r.name));
  const recorded = new Map(manifest.releases.map((r) => [r.id, r]));

  // History is append-only: a recorded release is never re-pointed by sync.
  const moved = candidates.flatMap((upstream) => {
    const release = recorded.get(upstream.name);
    return release && release.commit !== upstream.commit
      ? [`${release.id} (recorded ${release.commit}, upstream now ${upstream.commit})`]
      : [];
  });
  if (moved.length > 0) {
    fail(
      `recorded releases point at other commits upstream: ${moved.join('; ')}. Restore them upstream, or edit api-versions.json in a reviewed PR.`,
    );
  }

  const upstreamNames = new Set(candidates.map((r) => r.name));
  const warnings = manifest.releases
    .filter((r) => !upstreamNames.has(r.id))
    .map((r) => `${r.id} is recorded but no longer published upstream; it stays published here`);

  const added: ApiRelease[] = [];
  for (const release of candidates) {
    if (recorded.has(release.name)) continue;
    const bytes = await downloadSpec(manifest, release.commit, fetch);
    added.push({ id: release.name, commit: release.commit, sha256: sha256(bytes) });
  }
  const merged = [...manifest.releases, ...added].sort((a, b) => compareIds(a.id, b.id));
  return {
    manifest: { ...manifest, releases: merged },
    added: added.map((r) => r.id).sort(compareIds),
    warnings,
  };
}

/** What `materialize` writes next to the specs: every version the build renders. */
export interface ApiVersionsIndex {
  format: 1;
  repository: string;
  /** File names are relative to the index. */
  rolling: { branch: string; commit: string; sha256: string; file: string };
  releases: (ApiRelease & { file: string })[];
}

const ROLLING_FILE = 'rolling.json';

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

/**
 * Writes each recorded release's spec, the rolling spec at `rollingCommit`, and `index.json` into
 * `out`. A release spec must match its recorded digest. Release specs are cached by commit in
 * `cache`, since they never change; a cached copy that fails its digest is downloaded again. Rolling
 * changes with nearly every commit, so it is always downloaded and never cached.
 */
export async function materialize(
  manifest: ApiVersionsManifest,
  {
    out,
    rollingCommit,
    fetch,
    cache,
  }: { out: string; rollingCommit: string; fetch: Fetch; cache?: string | undefined },
): Promise<ApiVersionsIndex> {
  await mkdir(out, { recursive: true });
  if (cache) await mkdir(cache, { recursive: true });

  const loadRelease = async (release: ApiRelease): Promise<Uint8Array> => {
    const cached = cache ? join(cache, `${release.commit}.json`) : undefined;
    const hit = cached ? await readIfPresent(cached) : undefined;
    if (hit && sha256(hit) === release.sha256) return hit;
    const bytes = await downloadSpec(manifest, release.commit, fetch);
    if (cached && sha256(bytes) === release.sha256) await writeFile(cached, bytes);
    return bytes;
  };

  const releases: ApiVersionsIndex['releases'] = [];
  for (const release of manifest.releases) {
    const bytes = await loadRelease(release);
    const digest = sha256(bytes);
    if (digest !== release.sha256) {
      fail(`the spec for ${release.id} at ${release.commit} hashes to ${digest}, not the recorded ${release.sha256}`);
    }
    const file = `${release.id}.json`;
    await writeFile(join(out, file), bytes);
    releases.push({ ...release, file });
  }
  const rollingBytes = await downloadSpec(manifest, rollingCommit, fetch);
  await writeFile(join(out, ROLLING_FILE), rollingBytes);
  const index: ApiVersionsIndex = {
    format: 1,
    repository: manifest.source.repository,
    rolling: {
      branch: manifest.source.branch,
      commit: rollingCommit,
      sha256: sha256(rollingBytes),
      file: ROLLING_FILE,
    },
    releases,
  };
  await writeFile(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

export function parseManifest(text: string): ApiVersionsManifest {
  let manifest: ApiVersionsManifest;
  try {
    manifest = JSON.parse(text) as ApiVersionsManifest;
  } catch (cause) {
    throw new Error('api-versions: the manifest is not valid JSON', { cause });
  }
  if (manifest?.format !== 1) fail(`unsupported manifest format ${JSON.stringify(manifest?.format)}`);
  const { repository, branch, path } = manifest.source ?? {};
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) fail('source.repository must be owner/name');
  if (typeof branch !== 'string' || branch === '') fail('source.branch must be a branch name');
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    fail('source.path must be a path inside the repository');
  }
  if (!Array.isArray(manifest.releases)) fail('releases must be an array');
  let previous: string | undefined;
  for (const release of manifest.releases) {
    if (!isReleaseVersion(release.id)) fail(`"${release.id}" is not a release version (YYYY-MM-DD.<train>)`);
    if (previous !== undefined && compareIds(previous, release.id) >= 0) {
      fail(`releases must be strictly oldest first: ${release.id} follows ${previous}`);
    }
    previous = release.id;
    if (!COMMIT.test(release.commit)) fail(`release ${release.id} has an invalid commit "${release.commit}"`);
    if (!SHA256.test(release.sha256)) fail(`release ${release.id} has an invalid sha256`);
  }
  return manifest;
}

export function formatManifest(manifest: ApiVersionsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// --- Command line. The adapters below talk to GitHub and git; everything above is pure or takes a Fetch.

const GITHUB_API = 'https://api.github.com';

function githubFetch(path: string): Promise<Response> {
  const token = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'];
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function githubJson<T>(path: string): Promise<T> {
  const response = await githubFetch(path);
  if (!response.ok) fail(`GitHub API ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

/** Every release of `repository`, with the commit its tag points at. Only release names are resolved. */
async function listUpstreamReleases(repository: string): Promise<UpstreamRelease[]> {
  const releases: { tag_name: string; draft: boolean; prerelease: boolean }[] = [];
  for (let page = 1; ; page++) {
    const batch = await githubJson<typeof releases>(`/repos/${repository}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const result: UpstreamRelease[] = [];
  for (const release of releases) {
    if (!isReleaseVersion(release.tag_name)) continue;
    const commit = await githubJson<{ sha: string }>(
      `/repos/${repository}/commits/${encodeURIComponent(release.tag_name)}`,
    );
    result.push({ name: release.tag_name, commit: commit.sha, draft: release.draft, prerelease: release.prerelease });
  }
  return result;
}

/** The commit at the head of the source branch, from `git ls-remote`, which needs no API quota. */
async function resolveBranch(manifest: ApiVersionsManifest): Promise<string> {
  const { repository, branch } = manifest.source;
  const ref = `refs/heads/${branch}`;
  const { stdout } = await promisify(execFile)('git', ['ls-remote', `https://github.com/${repository}.git`, ref]);
  const commit = stdout
    .split('\n')
    .find((line) => line.endsWith(`\t${ref}`))
    ?.split('\t')[0];
  if (!commit || !COMMIT.test(commit)) fail(`could not resolve ${repository}@${branch}`);
  return commit;
}

async function githubOutput(values: Record<string, string>): Promise<void> {
  const path = process.env['GITHUB_OUTPUT'];
  if (!path) return;
  await appendFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      manifest: { type: 'string', default: 'api-versions.json' },
      out: { type: 'string' },
      cache: { type: 'string' },
      'rolling-commit': { type: 'string' },
    },
  });
  const manifest = parseManifest(await readFile(values.manifest, 'utf8'));

  if (command === 'sync') {
    const releases = await listUpstreamReleases(manifest.source.repository);
    const result = await sync(manifest, { releases, fetch });
    for (const warning of result.warnings) console.log(`::warning::${warning}`);
    await writeFile(values.manifest, formatManifest(result.manifest));
    console.log(result.added.length > 0 ? `Recorded ${result.added.join(', ')}` : 'No new releases');
    await githubOutput({ added: result.added.join(',') });
    return;
  }

  if (command === 'materialize') {
    if (!values.out) fail('materialize needs --out <dir>');
    const rollingCommit = values['rolling-commit'] || (await resolveBranch(manifest));
    const index = await materialize(manifest, { out: values.out, rollingCommit, fetch, cache: values.cache });
    const ids = index.releases.map((r) => r.id);
    console.log(`Rolling at ${rollingCommit}; snapshots: ${ids.length > 0 ? ids.join(', ') : 'none'}`);
    await githubOutput({
      index: join(values.out, 'index.json'),
      rolling: join(values.out, index.rolling.file),
      'rolling-commit': rollingCommit,
      releases: ids.join(','),
    });
    return;
  }

  fail(`unknown command "${command ?? ''}": expected sync or materialize`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
