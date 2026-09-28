import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  pruneFernOperationArtifacts,
  publishFernOperationArtifacts,
  type FernArtifactGeneration,
} from './artifacts.ts';
import { enrichOperationArtifact } from './content-collections.ts';
import {
  fernArtifactDescriptorPath,
  fernArtifactDigest,
  FERN_ARTIFACT_FORMAT_VERSION,
  fernOperationArtifactPath,
  serializeFernArtifact,
} from './content-contract.ts';
import {
  contentArtifactCatalogSchema,
  contentArtifactDescriptorSchema,
  contentOperationArtifactSchema,
  type FernContentOperationEntrySchema,
} from './content/schema.ts';
import { fernOperationLiveLoader } from './operation-live-loader.ts';
import { defineFernProject } from './project.ts';
import { fixtureSnippets, widgetsProduct, widgetsSpec } from './test-fixture.ts';

async function fixtureArtifact(titleSuffix = ''): Promise<{
  artifact: FernContentOperationEntrySchema;
  catalog: ReturnType<ReturnType<typeof defineFernProject>['getData']>['catalog'];
}> {
  const content = defineFernProject({
    source: widgetsSpec,
    snippets: fixtureSnippets,
    manifest: { products: [widgetsProduct] },
  }).getData();
  const source = content.operations[0];
  assert.ok(source);
  const artifact = contentOperationArtifactSchema.parse(
    await enrichOperationArtifact(source, async (markdown) => ({ markdown, html: `<p>${markdown}</p>` })),
  );
  if (titleSuffix) artifact.operation.title += titleSuffix;
  return { artifact, catalog: content.catalog };
}

async function fixtureGeneration(options: { artifactTitle?: string; descriptorDescription?: string } = {}) {
  const { artifact, catalog: sourceCatalog } = await fixtureArtifact(options.artifactTitle);
  const bytes = serializeFernArtifact(artifact);
  const digest = await fernArtifactDigest(bytes);
  const catalog = contentArtifactCatalogSchema.parse({
    ...sourceCatalog,
    products: sourceCatalog.products.map((product) => ({
      ...product,
      snapshots: product.snapshots.map((snapshot) => ({
        ...snapshot,
        sections: snapshot.sections.map((section) => ({
          ...section,
          operations: section.operations.map((operation) => {
            assert.equal(operation.entryId, artifact.id);
            return { ...operation, artifactDigest: digest };
          }),
        })),
      })),
    })),
  });
  const description = options.descriptorDescription;
  const descriptor = contentArtifactDescriptorSchema.parse({
    format: FERN_ARTIFACT_FORMAT_VERSION,
    ...(description ? { description: { markdown: description, html: `<p>${description}</p>` } } : {}),
    catalog,
  });
  const descriptorBytes = serializeFernArtifact(descriptor);
  const revision = await fernArtifactDigest(descriptorBytes);
  const generation: FernArtifactGeneration = {
    revision,
    descriptorBytes,
    operations: [{ id: artifact.id, digest, bytes }],
  };
  return { artifact, descriptor, digest, generation };
}

async function fixtureSnapshotGeneration() {
  const { artifact: legacy, catalog: sourceCatalog } = await fixtureArtifact();
  const current = structuredClone(legacy);
  current.operation.title += ' current';
  const publications = await Promise.all(
    [legacy, current].map(async (artifact) => {
      const bytes = serializeFernArtifact(artifact);
      return { id: artifact.id, digest: await fernArtifactDigest(bytes), bytes };
    }),
  );
  const product = sourceCatalog.products[0];
  const snapshot = product?.snapshots[0];
  const globalSnapshot = sourceCatalog.snapshots[0];
  assert.ok(product && snapshot && globalSnapshot);
  const snapshots = [
    { id: 'legacy', slug: 'legacy', label: 'Legacy', default: false, publication: publications[0]! },
    { id: 'current', slug: 'current', label: 'Current', default: true, publication: publications[1]! },
  ];
  const catalog = contentArtifactCatalogSchema.parse({
    ...sourceCatalog,
    snapshots: snapshots.map(({ publication: _publication, ...identity }) => ({
      ...globalSnapshot,
      ...identity,
    })),
    products: [
      {
        ...product,
        snapshots: snapshots.map(({ publication, ...identity }) => ({
          ...snapshot,
          ...identity,
          sections: snapshot.sections.map((section) => ({
            ...section,
            operations: section.operations.map((operation) => ({
              ...operation,
              artifactDigest: publication.digest,
            })),
          })),
        })),
      },
    ],
  });
  const descriptor = contentArtifactDescriptorSchema.parse({ format: FERN_ARTIFACT_FORMAT_VERSION, catalog });
  const descriptorBytes = serializeFernArtifact(descriptor);
  const revision = await fernArtifactDigest(descriptorBytes);
  return { generation: { revision, descriptorBytes, operations: publications }, publications };
}

async function directoryNames(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

test('artifact digests use Web Crypto SHA-256 vectors', async () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['operation:widgets/update', 'be029f61c65239328f73e3426cdc5fc415dc2bdd5d5902ac10c4531ec5cf5af2'],
  ] as const;

  for (const [value, expected] of vectors) {
    assert.equal(await fernArtifactDigest(value), expected);
    assert.equal(await fernArtifactDigest(new TextEncoder().encode(value)), expected);
  }
});

test('artifact serialization hashes exact JSON bytes without sorting keys', async () => {
  const left = serializeFernArtifact({ alpha: 1, beta: 2 });
  const right = serializeFernArtifact({ beta: 2, alpha: 1 });
  const unicode = serializeFernArtifact({ text: 'café 日本語' });

  assert.equal(new TextDecoder().decode(left), '{"alpha":1,"beta":2}');
  assert.equal(new TextDecoder().decode(right), '{"beta":2,"alpha":1}');
  assert.equal(new TextDecoder().decode(unicode), '{"text":"café 日本語"}');
  assert.notEqual(await fernArtifactDigest(left), await fernArtifactDigest(right));
});

test('artifact paths use validated content digests', () => {
  const digest = 'a'.repeat(64);
  assert.equal(fernOperationArtifactPath(digest, '/docs'), `/docs/_astro-fern/operations/${digest}.json`);
  assert.equal(fernArtifactDescriptorPath(digest, '/docs'), `/docs/_astro-fern/catalogs/${digest}.json`);
  assert.throws(() => fernOperationArtifactPath('../bad'), /invalid artifact digest/);
});

test('the live loader verifies and loads one content-addressed artifact', async () => {
  const { artifact, digest, generation } = await fixtureGeneration();
  const bytes = generation.operations[0]?.bytes;
  assert.ok(bytes);
  let requested: Request | undefined;
  const result = await fernOperationLiveLoader().loadEntry({
    collection: 'apiOperations',
    filter: {
      id: artifact.id,
      digest,
      origin: 'https://example.com/api/widgets',
      fetcher: {
        async fetch(request) {
          requested = request;
          return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
        },
      },
    },
  });

  assert.ok(result && !('error' in result));
  assert.equal(requested?.url, `https://example.com${fernOperationArtifactPath(digest)}`);
  assert.equal(result.id, digest);
  assert.equal(result.data.id, artifact.id);
  assert.equal(result.data.format, FERN_ARTIFACT_FORMAT_VERSION);
  assert.deepEqual(result.cacheHint?.tags, [`fern:artifact:${digest}`, `fern:operation:${artifact.id}`]);
});

test('the live loader gives divergent snapshots distinct collection entry IDs', async () => {
  const { publications } = await fixtureSnapshotGeneration();
  const entries = await Promise.all(
    publications.map(async (publication) => {
      const result = await fernOperationLiveLoader().loadEntry({
        collection: 'apiOperations',
        filter: {
          id: publication.id,
          digest: publication.digest,
          origin: 'https://example.com',
          fetcher: { fetch: async () => new Response(publication.bytes) },
        },
      });
      assert.ok(result && !('error' in result));
      return result;
    }),
  );

  assert.equal(new Set(entries.map(({ id }) => id)).size, publications.length);
  assert.equal(new Set(entries.map(({ data }) => data.id)).size, 1);
});

test('the live loader distinguishes missing, corrupt, and malformed artifacts', async () => {
  const { artifact, generation } = await fixtureGeneration();
  const bytes = generation.operations[0]?.bytes;
  assert.ok(bytes);
  const baseFilter = { id: artifact.id, digest: generation.operations[0]!.digest, origin: 'https://example.com' };
  const load = (filter: typeof baseFilter & { fetcher: { fetch(): Promise<Response> } }) =>
    fernOperationLiveLoader().loadEntry({ collection: 'apiOperations', filter });

  const missing = await load({
    ...baseFilter,
    fetcher: { fetch: async () => new Response('missing', { status: 404 }) },
  });
  assert.equal(missing, undefined);

  const corrupt = await load({
    ...baseFilter,
    digest: '0'.repeat(64),
    fetcher: { fetch: async () => new Response(bytes) },
  });
  assert.ok(corrupt && 'error' in corrupt);
  assert.match(corrupt.error.message, /has digest .* expected "0000/);

  const malformedBytes = serializeFernArtifact({ format: FERN_ARTIFACT_FORMAT_VERSION, id: artifact.id });
  const malformed = await load({
    ...baseFilter,
    digest: await fernArtifactDigest(malformedBytes),
    fetcher: { fetch: async () => new Response(malformedBytes) },
  });
  assert.ok(malformed && 'error' in malformed);
  assert.match(malformed.error.message, /does not match its schema/);

  const invalidJson = new TextEncoder().encode('{');
  const invalid = await load({
    ...baseFilter,
    digest: await fernArtifactDigest(invalidJson),
    fetcher: { fetch: async () => new Response(invalidJson) },
  });
  assert.ok(invalid && 'error' in invalid);
  assert.match(invalid.error.message, /not valid UTF-8 JSON/);
});

test('the live loader rejects invalid UTF-8 and mismatched operation identities', async () => {
  const invalidUtf8 = Uint8Array.from([0xff]);
  const utf8Result = await fernOperationLiveLoader().loadEntry({
    collection: 'apiOperations',
    filter: {
      id: 'operation:invalid',
      digest: await fernArtifactDigest(invalidUtf8),
      origin: 'https://example.com',
      fetcher: { fetch: async () => new Response(invalidUtf8) },
    },
  });
  assert.ok(utf8Result && 'error' in utf8Result);
  assert.match(utf8Result.error.message, /not valid UTF-8 JSON/);

  const { generation } = await fixtureGeneration();
  const publication = generation.operations[0];
  assert.ok(publication);
  const identityResult = await fernOperationLiveLoader().loadEntry({
    collection: 'apiOperations',
    filter: {
      id: 'operation:other',
      digest: publication.digest,
      origin: 'https://example.com',
      fetcher: { fetch: async () => new Response(publication.bytes) },
    },
  });
  assert.ok(identityResult && 'error' in identityResult);
  assert.match(identityResult.error.message, /contains entry ID/);
});

test('the publisher writes hash-addressed blobs and descriptors to publicDir', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const { artifact, descriptor, digest, generation } = await fixtureGeneration();
  const publication = generation.operations[0];
  assert.ok(publication);

  await publishFernOperationArtifacts(publicDir, generation);
  await pruneFernOperationArtifacts(publicDir, generation.revision, undefined);

  const publishedOperation = await readFile(join(directory, fernOperationArtifactPath(digest)));
  const publishedDescriptor = await readFile(join(directory, fernArtifactDescriptorPath(generation.revision)));
  assert.deepEqual([...publishedOperation], [...publication.bytes]);
  assert.deepEqual([...publishedDescriptor], [...generation.descriptorBytes]);
  assert.equal(await fernArtifactDigest(publishedOperation), digest);
  assert.equal(await fernArtifactDigest(publishedDescriptor), generation.revision);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(publishedOperation)), artifact);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(publishedDescriptor)), descriptor);
  assert.deepEqual(await directoryNames(join(directory, '_astro-fern')), ['catalogs', 'operations']);
});

test('the publisher accepts two snapshot artifacts with one semantic operation ID', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const { generation, publications } = await fixtureSnapshotGeneration();

  await publishFernOperationArtifacts(publicDir, generation);
  await pruneFernOperationArtifacts(publicDir, generation.revision, undefined);

  assert.equal(new Set(publications.map(({ id }) => id)).size, 1);
  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/operations')),
    publications.map(({ digest }) => `${digest}.json`).sort(),
  );
});

test('the publisher rejects mismatched bytes and immutable blob mutations', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const { digest, generation } = await fixtureGeneration();
  const publication = generation.operations[0];
  assert.ok(publication);

  await assert.rejects(
    publishFernOperationArtifacts(publicDir, {
      ...generation,
      operations: [{ ...publication, bytes: serializeFernArtifact({ wrong: true }) }],
    }),
    /does not match digest/,
  );
  await assert.rejects(
    publishFernOperationArtifacts(publicDir, {
      ...generation,
      operations: [{ ...publication, id: 'operation:other' }],
    }),
    /contains entry ID/,
  );

  await publishFernOperationArtifacts(publicDir, generation);
  await writeFile(join(directory, fernOperationArtifactPath(digest)), 'corrupt');
  await assert.rejects(publishFernOperationArtifacts(publicDir, generation), /immutable artifact .* does not match/);
});

test('reachability GC shares unchanged blobs and retains two descriptors', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const first = await fixtureGeneration({ descriptorDescription: 'first' });
  const second = await fixtureGeneration({ descriptorDescription: 'second' });
  const third = await fixtureGeneration({ artifactTitle: ' third' });
  const fourth = await fixtureGeneration({ artifactTitle: ' fourth' });

  let active: string | undefined;
  for (const item of [first, second, second, third, fourth]) {
    await publishFernOperationArtifacts(publicDir, item.generation);
    await pruneFernOperationArtifacts(publicDir, item.generation.revision, active);
    active = item.generation.revision;
  }

  assert.equal(first.digest, second.digest, 'catalog-only changes reuse operation blobs');
  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/catalogs')),
    [`${fourth.generation.revision}.json`, `${third.generation.revision}.json`].sort(),
  );
  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/operations')),
    [`${fourth.digest}.json`, `${third.digest}.json`].sort(),
  );
});

test('reachability GC preserves the generation active immediately before a rollback', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const first = await fixtureGeneration({ artifactTitle: ' first' });
  const second = await fixtureGeneration({ artifactTitle: ' second' });
  const third = await fixtureGeneration({ artifactTitle: ' third' });

  let active: string | undefined;
  for (const item of [first, second, first, third]) {
    await publishFernOperationArtifacts(publicDir, item.generation);
    await pruneFernOperationArtifacts(publicDir, item.generation.revision, active);
    active = item.generation.revision;
  }

  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/catalogs')),
    [`${first.generation.revision}.json`, `${third.generation.revision}.json`].sort(),
  );
  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/operations')),
    [`${first.digest}.json`, `${third.digest}.json`].sort(),
  );
});

test('reachability GC removes legacy revision directories from its reserved root', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const { generation } = await fixtureGeneration();
  await mkdir(join(directory, '_astro-fern/legacy-revision/operations'), { recursive: true });
  await writeFile(join(directory, '_astro-fern/legacy-revision/operations/old.json'), '{}');

  await publishFernOperationArtifacts(publicDir, generation);
  await pruneFernOperationArtifacts(publicDir, generation.revision, undefined);

  assert.deepEqual(await directoryNames(join(directory, '_astro-fern')), ['catalogs', 'operations']);
});

test('reachability GC uses the actual prior store revision after a skipped prune', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const first = await fixtureGeneration({ artifactTitle: ' first' });
  const second = await fixtureGeneration({ artifactTitle: ' second' });
  const third = await fixtureGeneration({ artifactTitle: ' third' });

  await publishFernOperationArtifacts(publicDir, first.generation);
  await pruneFernOperationArtifacts(publicDir, first.generation.revision, undefined);
  await publishFernOperationArtifacts(publicDir, second.generation);
  // Simulate a failed prune after the eager store has already activated `second`.
  await publishFernOperationArtifacts(publicDir, third.generation);
  await pruneFernOperationArtifacts(publicDir, third.generation.revision, second.generation.revision);

  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/catalogs')),
    [`${second.generation.revision}.json`, `${third.generation.revision}.json`].sort(),
  );
  assert.deepEqual(
    await directoryNames(join(directory, '_astro-fern/operations')),
    [`${second.digest}.json`, `${third.digest}.json`].sort(),
  );
});

test('reachability GC fails safely when prior artifacts are missing or history is unknown', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const first = await fixtureGeneration({ artifactTitle: ' first' });
  const second = await fixtureGeneration({ artifactTitle: ' second' });

  await publishFernOperationArtifacts(publicDir, first.generation);
  await publishFernOperationArtifacts(publicDir, second.generation);
  await pruneFernOperationArtifacts(publicDir, second.generation.revision, undefined);
  assert.equal(
    (await directoryNames(join(directory, '_astro-fern/catalogs'))).length,
    2,
    'unknown history is preserved',
  );

  await writeFile(join(directory, fernOperationArtifactPath(first.digest)), 'corrupt');
  await assert.rejects(
    pruneFernOperationArtifacts(publicDir, second.generation.revision, first.generation.revision),
    /prior operation artifact .* missing or corrupt/,
  );
  assert.equal((await directoryNames(join(directory, '_astro-fern/catalogs'))).length, 2);
});

test('the publisher rejects non-directory managed artifact paths', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-fern-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = pathToFileURL(`${directory}/`);
  const { generation } = await fixtureGeneration();
  await mkdir(join(directory, '_astro-fern'));
  await writeFile(join(directory, '_astro-fern/operations'), 'not a directory');

  await assert.rejects(publishFernOperationArtifacts(publicDir, generation), /must be a regular directory/);
});
