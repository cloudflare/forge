import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichOperationEntry } from './content-collections.ts';
import { contentArtifactCatalogSchema, contentArtifactDescriptorSchema } from './content/schema.ts';
import { fernArtifactDigest, FERN_ARTIFACT_FORMAT_VERSION, serializeFernArtifact } from './content-contract.ts';
import { defineFernManifest } from './manifest.ts';
import { defineFernProject } from './project.ts';
import { resolveRuntimeConfig } from './runtime-config.ts';
import {
  cacheFernOperation,
  createFernProjectRuntime,
  createFernRequestCache,
  llmsRequestForRoute,
  renderFernLlmsResponse,
  resolveFernArtifactOrigin,
  resolveFernSemanticHref,
} from './server-runtime.ts';
import { fixtureSnippets, widgetsProduct, widgetsSpec } from './test-fixture.ts';

async function runtimeFixture(v2ArtifactDigest = '') {
  const content = defineFernProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: widgetsSpec },
        { id: 'v2', source: widgetsSpec },
      ],
    },
    snippets: fixtureSnippets,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [
        { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
        { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
      ],
    }),
  }).getData();
  const operation = await enrichOperationEntry(content.operations[0]!, async (markdown) => ({
    markdown,
    html: `<p>${markdown}</p>`,
  }));
  const artifactDigest = await fernArtifactDigest(serializeFernArtifact(operation));
  const catalog = contentArtifactCatalogSchema.parse({
    ...content.catalog,
    products: content.catalog.products.map((product) => ({
      ...product,
      snapshots: product.snapshots.map((snapshot) => ({
        ...snapshot,
        sections: snapshot.sections.map((section) => ({
          ...section,
          operations: section.operations.map((reference) => ({
            ...reference,
            artifactDigest: snapshot.id === 'v2' && v2ArtifactDigest ? v2ArtifactDigest : artifactDigest,
          })),
        })),
      })),
    })),
  });
  const descriptor = contentArtifactDescriptorSchema.parse({ format: FERN_ARTIFACT_FORMAT_VERSION, catalog });
  const project = {
    kind: 'project',
    id: 'project',
    revision: await fernArtifactDigest(serializeFernArtifact(descriptor)),
    ...descriptor,
  } as const;
  const runtime = createFernProjectRuntime(
    project,
    resolveRuntimeConfig({
      routing: { base: '/api', target: 'path' },
      agents: { llms: { scopes: ['site', 'product', 'snapshot', 'target'] } },
    }),
    { site: 'https://docs.example.com' },
  );
  return { artifactDigest, operation, runtime };
}

test('runtime indexes operation artifacts by exact snapshot and semantic entry ID', async () => {
  const v2ArtifactDigest = 'b'.repeat(64);
  const { artifactDigest, operation, runtime } = await runtimeFixture(v2ArtifactDigest);

  assert.equal(runtime.operationArtifacts.get('v1')?.get(operation.id), artifactDigest);
  assert.equal(runtime.operationArtifacts.get('v2')?.get(operation.id), v2ArtifactDigest);
  const v1Page = [...runtime.pageReferences.values()].find((reference) => reference.snapshotId === 'v1');
  const v2Page = [...runtime.pageReferences.values()].find((reference) => reference.snapshotId === 'v2');
  assert.equal(v1Page?.artifactDigest, artifactDigest);
  assert.equal(v2Page?.artifactDigest, v2ArtifactDigest);
});

test('runtime llms routes retain their semantic scope', async () => {
  const { runtime } = await runtimeFixture();
  const site = runtime.agentRoutes.get('llms:site');
  const product = [...runtime.agentRoutes.values()].find((route) => route.scopeKind === 'product');
  const snapshot = [...runtime.agentRoutes.values()].find((route) => route.scopeKind === 'snapshot');
  assert.ok(site && product && snapshot);
  assert.deepEqual(llmsRequestForRoute(site), { kind: 'llms', scope: 'site' });
  assert.deepEqual(llmsRequestForRoute(product), { kind: 'llms', scope: 'product', productId: 'widgets' });
  assert.deepEqual(llmsRequestForRoute(snapshot), {
    kind: 'llms',
    scope: 'snapshot',
    productId: 'widgets',
    snapshotId: 'v2',
  });

  const siteResponse = renderFernLlmsResponse(runtime, site.id);
  const siteMarkdown = await siteResponse.text();
  assert.equal(siteResponse.status, 200);
  assert.match(siteMarkdown, /\[Widgets\]\(https:\/\/docs\.example\.com\/api\/widgets\/llms\.txt\)/);

  const productResponse = renderFernLlmsResponse(runtime, product.id);
  const productMarkdown = await productResponse.text();
  assert.match(productMarkdown, /## API operations/);
  assert.match(productMarkdown, /Update widget/);
});

test('runtime semantic links use pre-indexed operation and agent routes', async () => {
  const { runtime } = await runtimeFixture();
  assert.equal(
    resolveFernSemanticHref(runtime, {
      kind: 'operation',
      representation: 'markdown',
      productId: 'widgets',
      snapshotId: 'v1',
      operationId: 'widgets_update',
    }),
    'https://docs.example.com/api/widgets/sections/management/operations/widgets-update.md',
  );
  assert.equal(
    resolveFernSemanticHref(runtime, {
      kind: 'llms',
      scope: 'target',
      productId: 'widgets',
      snapshotId: 'v1',
      targetId: 'python',
    }),
    'https://docs.example.com/api/widgets/targets/python/llms.txt',
  );
});

test('request caches deduplicate loads and remain isolated', async () => {
  const { artifactDigest, operation } = await runtimeFixture();
  const first = createFernRequestCache();
  const second = createFernRequestCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return operation;
  };

  const [left, right] = await Promise.all([
    cacheFernOperation(first, artifactDigest, operation.id, load),
    cacheFernOperation(first, artifactDigest, operation.id, load),
  ]);
  assert.equal(left, operation);
  assert.equal(right, operation);
  assert.equal(loads, 1);

  await cacheFernOperation(second, artifactDigest, operation.id, load);
  assert.equal(loads, 2, 'a separate request cache performs its own load');
});

test('request caches evict failed loads', async () => {
  const { artifactDigest, operation } = await runtimeFixture();
  const cache = createFernRequestCache();
  let loads = 0;
  await assert.rejects(
    cacheFernOperation(cache, artifactDigest, operation.id, async () => {
      loads += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/,
  );
  await cacheFernOperation(cache, artifactDigest, operation.id, async () => {
    loads += 1;
    return operation;
  });
  assert.equal(loads, 2);
});

test('request caches do not share one digest across different entry IDs', async () => {
  const { artifactDigest, operation } = await runtimeFixture();
  const cache = createFernRequestCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return operation;
  };

  await cacheFernOperation(cache, artifactDigest, operation.id, load);
  await cacheFernOperation(cache, artifactDigest, 'operation:other', load);

  assert.equal(loads, 2);
});

test('network artifact loads reject request-derived origins', () => {
  const request = new Request('https://attacker.example/api/widgets');
  assert.throws(() => resolveFernArtifactOrigin({ request }), /requires a trusted origin/);
  assert.equal(resolveFernArtifactOrigin({ request }, 'https://docs.example.com/base'), 'https://docs.example.com');
  assert.equal(
    resolveFernArtifactOrigin({ origin: 'https://assets.example.com/path', request }),
    'https://assets.example.com',
  );
  assert.equal(resolveFernArtifactOrigin({ request, fetcher: {} }), 'https://attacker.example');
});
