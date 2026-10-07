import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FernArtifactGeneration } from './artifacts.ts';
import {
  assertSanitizedMarkdownRenderer,
  enrichOperationEntry,
  type FernContentLoaderContext,
  fernContentLoader,
  type MarkdownRenderer,
} from './content-collections.ts';
import { fernArtifactDigest, FERN_ARTIFACT_FORMAT_VERSION, FERN_PROJECT_ENTRY_ID } from './content-contract.ts';
import {
  apiReferenceEntrySchema,
  contentArtifactDescriptorSchema,
  operationCodeSampleSchema,
  type FernContentEntrySchema,
  type FernContentOperationEntrySchema,
  type FernContentProjectEntrySchema,
} from './content/schema.ts';
import { defineFernManifest } from './manifest.ts';
import { defineFernProject, type FernContentOptions, type FernProjectOptions } from './project.ts';
import { fixtureExtension, fixtureSnippets, widgetsProduct, widgetsSpec } from './test-fixture.ts';

const wrap = (markdown: string): string => `<HTML>${markdown}</HTML>`;
const stubRenderer: MarkdownRenderer = async (markdown) => ({ markdown, html: wrap(markdown) });

test('rendered code samples accept only canonical SDK names', () => {
  assert.equal(operationCodeSampleSchema.safeParse({ kind: 'sdk', sdk: 'typescript', code: '' }).success, true);
  assert.equal(operationCodeSampleSchema.safeParse({ kind: 'sdk', sdk: 'ts', code: '' }).success, false);
});

function fixtureOptions(): FernProjectOptions {
  return {
    source: widgetsSpec,
    snippets: fixtureSnippets,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [
        { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
        { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
      ],
    }),
  };
}

/** Minimal in-memory stand-in for the Content Layer store and loader helpers. */
function fakeContext(parse?: (id: string, data: unknown) => void | Promise<void>) {
  const entries = new Map<string, FernContentEntrySchema>();
  const artifacts = new Map<string, FernContentOperationEntrySchema>();
  const artifactDigests = new Map<string, string>();
  const generations: FernArtifactGeneration[] = [];
  const parsed: string[] = [];
  const store: FernContentLoaderContext['store'] = {
    clear: () => entries.clear(),
    get: <TData extends Record<string, unknown>>(id: string) => {
      const data = entries.get(id);
      return data ? { id, data: data as unknown as TData } : undefined;
    },
    set: (entry) => {
      const result = apiReferenceEntrySchema.safeParse(entry.data);
      if (!result.success) throw result.error;
      entries.set(entry.id, result.data);
      return true;
    },
  };
  const context = {
    store,
    logger: {
      error() {},
      info() {},
      fork: () => ({ warn() {} }) as unknown as ReturnType<FernContentLoaderContext['logger']['fork']>,
    },
    config: { root: new URL('file:///test/'), publicDir: new URL('file:///test/public/') },
    parseData: async <TData extends Record<string, unknown>>({ id, data }: { id: string; data: TData }) => {
      parsed.push(id);
      await parse?.(id, data);
      return data;
    },
    // Like a sanitizing processor, never emit source HTML as markup.
    renderMarkdown: async (markdown: string) => ({ html: wrap(markdown.replaceAll('<', '&lt;')) }),
    publishArtifacts: async (generation) => {
      generations.push(generation);
      artifacts.clear();
      artifactDigests.clear();
      assert.equal(await fernArtifactDigest(generation.descriptorBytes), generation.revision);
      for (const operation of generation.operations) {
        assert.equal(await fernArtifactDigest(operation.bytes), operation.digest);
        const entry = apiReferenceEntrySchema.parse(JSON.parse(new TextDecoder().decode(operation.bytes)));
        assert.equal(entry.kind, 'operation');
        artifacts.set(entry.id, entry);
        artifactDigests.set(entry.id, operation.digest);
      }
    },
  } satisfies FernContentLoaderContext;
  return { context, entries, artifacts, artifactDigests, generations, parsed };
}

test('loader publishes one catalog entry and deduplicates identical operation snapshots', async () => {
  const options: FernProjectOptions = {
    ...fixtureOptions(),
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: widgetsSpec },
        { id: 'v2', source: widgetsSpec },
      ],
    },
  };
  const canonical = defineFernProject(options).getData();
  const { context, entries, artifacts, artifactDigests, parsed } = fakeContext();

  await fernContentLoader(options).load(context);

  assert.equal(entries.size, 1);
  assert.deepEqual(parsed, [FERN_PROJECT_ENTRY_ID]);
  assert.equal(artifacts.size, 1);
  assert.equal(canonical.operations.length, 2);
  const project = entries.get(FERN_PROJECT_ENTRY_ID);
  assert.ok(project?.kind === 'project');
  assert.equal(project.format, FERN_ARTIFACT_FORMAT_VERSION);
  assert.equal(project.catalog.products[0]?.snapshots.length, 2, 'snapshots reference the same semantic operation');
  for (const product of project.catalog.products) {
    for (const snapshot of product.snapshots) {
      for (const section of snapshot.sections) {
        for (const operation of section.operations) {
          assert.equal(operation.artifactDigest, artifactDigests.get(operation.entryId));
        }
      }
    }
  }
  assert.equal(
    JSON.stringify(project.catalog).includes('"pathname"'),
    false,
    'catalog storage contains no mounted paths',
  );
});

test('loader awaits a source provider before building content', async () => {
  let calls = 0;
  const options: FernContentOptions = {
    ...fixtureOptions(),
    source: async () => {
      calls += 1;
      return widgetsSpec;
    },
  };
  const { context, entries } = fakeContext();

  await fernContentLoader(options).load(context);

  assert.equal(calls, 1);
  assert.ok(entries.has(FERN_PROJECT_ENTRY_ID));
});

test('loader resolves snapshot providers and publishes changed snapshots as distinct artifacts', async () => {
  const legacy = structuredClone(widgetsSpec);
  const current = structuredClone(widgetsSpec);
  const currentUpdate = current.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(currentUpdate);
  currentUpdate.summary = 'Update a current widget';
  const calls: string[] = [];
  const options: FernContentOptions = {
    ...fixtureOptions(),
    source: {
      kind: 'snapshots',
      snapshots: [
        {
          id: 'v1',
          source: async () => {
            calls.push('v1');
            return legacy;
          },
        },
        {
          id: 'v2',
          default: true,
          source: async () => {
            calls.push('v2');
            return current;
          },
        },
      ],
    },
  };
  const { context, entries, generations } = fakeContext();

  await fernContentLoader(options).load(context);

  assert.deepEqual(calls, ['v1', 'v2']);
  const generation = generations[0];
  const project = entries.get(FERN_PROJECT_ENTRY_ID);
  assert.ok(generation && project?.kind === 'project');
  assert.equal(generation.operations.length, 2);
  assert.equal(new Set(generation.operations.map(({ id }) => id)).size, 1);
  assert.equal(new Set(generation.operations.map(({ digest }) => digest)).size, 2);
  const titlesByDigest = new Map(
    generation.operations.map((publication) => {
      const entry = apiReferenceEntrySchema.parse(JSON.parse(new TextDecoder().decode(publication.bytes)));
      assert.equal(entry.kind, 'operation');
      return [publication.digest, entry.operation.title] as const;
    }),
  );
  assert.deepEqual(
    project.catalog.products[0]?.snapshots.map((snapshot) => {
      const digest = snapshot.sections[0]?.operations[0]?.artifactDigest;
      return [snapshot.id, digest ? titlesByDigest.get(digest) : undefined];
    }),
    [
      ['v1', 'Update widget'],
      ['v2', 'Update a current widget'],
    ],
  );
});

test('loader resolves a provider shared by snapshots once per load', async () => {
  let calls = 0;
  const source = async () => {
    calls += 1;
    return widgetsSpec;
  };
  const options: FernContentOptions = {
    ...fixtureOptions(),
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'legacy', source },
        { id: 'current', source, default: true },
      ],
    },
  };

  await fernContentLoader(options).load(fakeContext().context);

  assert.equal(calls, 1);
});

test('loader validates source-provider results before building content', async () => {
  const { context } = fakeContext();
  const options: FernContentOptions = { ...fixtureOptions(), source: async () => [] as never };

  await assert.rejects(fernContentLoader(options).load(context), /not a valid OpenAPI document/);
});

test('loader enriches operation and nested Markdown descriptions', async () => {
  const options = fixtureOptions();
  const { context, entries, artifacts } = fakeContext();
  await fernContentLoader(options).load(context);
  const project = entries.get(FERN_PROJECT_ENTRY_ID);
  assert.ok(project?.kind === 'project');
  assert.ok(project.description);
  assert.equal(project.description.markdown, widgetsSpec.info?.description);
  assert.equal(project.description.html, wrap(project.description.markdown));
  const entry = [...artifacts.values()][0];
  assert.ok(entry?.kind === 'operation');

  assert.equal(entry.operation.description.markdown, 'Updates a [widget](https://example.com/widgets) by ID.');
  assert.equal(entry.operation.description.html, wrap(entry.operation.description.markdown));
  const response = entry.operation.responses[0];
  const representation = response?.representations[0];
  const example = representation?.examples[0];
  assert.ok(response && representation && example);
  assert.equal(response.status, '200');
  assert.equal(response.description.markdown, 'The updated [widget](https://example.com/widgets).');
  assert.equal(response.description.html, wrap(response.description.markdown));
  assert.deepEqual(example.value, { id: 'id', name: 'name' });
  assert.equal(example.name, 'updated');
  assert.equal(example.summary, 'Updated widget');
  assert.equal(example.description?.markdown, 'A complete **widget** response.');
  assert.equal(example.description?.html, wrap('A complete **widget** response.'));
  assert.equal(representation.examples[1]?.value, null);
  assert.deepEqual(representation.examples[2]?.value, {});
  assert.equal(representation.schema?.children?.[0]?.format, 'uuid');
  assert.equal(entry.operation.requestBody?.required, true);
  assert.equal(
    entry.operation.requestBody?.description?.html,
    wrap('Fields to update on the [widget](https://example.com/widgets).'),
  );
  const name = entry.operation.requestBody?.representations[0]?.schema?.children?.find(
    (child) => child.name === 'name',
  );
  assert.ok(name?.description);
  assert.match(name.description.markdown, /\[name\]\(https:\/\/example\.com\/naming\)/);
  assert.equal(name.description.html, wrap(name.description.markdown));
});

test('loader enriches Fern enum metadata and retains associated examples', async () => {
  const source = structuredClone(widgetsSpec);
  const update = source.paths?.['/widgets/{widget_id}']?.patch;
  const name = update?.requestBody?.content?.['application/json']?.schema;
  assert.ok(update && name && typeof name !== 'boolean');
  const nameProperty = name.properties?.name;
  assert.ok(nameProperty && typeof nameProperty !== 'boolean');
  nameProperty.enum = ['current', 'retired'];
  nameProperty['x-fern-enum'] = {
    current: { description: 'The **current** name.' },
    retired: { description: 'No longer used.', deprecated: true },
  };
  update['x-fern-examples'] = [
    {
      name: 'Rename widget',
      request: { name: 'current' },
      response: { body: { id: 'id', name: 'current' } },
      'code-samples': [{ sdk: 'ts', code: 'await client.widgets.update();' }],
    },
  ];
  const { context, artifacts } = fakeContext();

  await fernContentLoader({ ...fixtureOptions(), source }).load(context);
  const entry = [...artifacts.values()][0];
  assert.ok(entry?.kind === 'operation');
  const renderedName = entry.operation.requestBody?.representations[0]?.schema?.children?.find(
    (child) => child.name === 'name',
  );
  assert.deepEqual(renderedName?.enumValueMetadata, [
    { value: 'current', description: { markdown: 'The **current** name.', html: wrap('The **current** name.') } },
    {
      value: 'retired',
      description: { markdown: 'No longer used.', html: wrap('No longer used.') },
      deprecated: true,
    },
  ]);
  assert.deepEqual(entry.operation.examples, [
    {
      name: 'Rename widget',
      request: { body: { name: 'current' } },
      response: { body: { id: 'id', name: 'current' } },
      codeSamples: [{ kind: 'sdk', sdk: 'typescript', code: 'await client.widgets.update();' }],
    },
  ]);
});

test('loader retains confirmation messages as escaped plain-text data', async () => {
  const source = structuredClone(widgetsSpec);
  const update = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(update);
  update['x-test-confirmation'] = 'This operation removes <all> *widgets*.';
  const { context, artifacts } = fakeContext();

  await fernContentLoader({ ...fixtureOptions(), source, extensions: [fixtureExtension] }).load(context);
  const entry = [...artifacts.values()][0];
  assert.ok(entry?.kind === 'operation');
  assert.equal(entry.operation.requireConfirmation, 'This operation removes <all> *widgets*.');
  assert.equal(apiReferenceEntrySchema.safeParse(entry).success, true);
  assert.equal(
    apiReferenceEntrySchema.safeParse({
      ...entry,
      operation: { ...entry.operation, requireConfirmation: { html: '<strong>unsafe</strong>' } },
    }).success,
    false,
  );
});

test('the project revision addresses its exact descriptor bytes', async () => {
  const { context, entries, artifacts, generations } = fakeContext();
  await fernContentLoader(fixtureOptions()).load(context);
  const project = entries.get(FERN_PROJECT_ENTRY_ID);
  const generation = generations[0];
  assert.ok(project?.kind === 'project' && generation);
  assert.equal(project.revision, generation.revision);
  assert.equal(await fernArtifactDigest(generation.descriptorBytes), project.revision);
  assert.deepEqual(
    contentArtifactDescriptorSchema.parse(JSON.parse(new TextDecoder().decode(generation.descriptorBytes))),
    {
      format: project.format,
      ...(project.description ? { description: project.description } : {}),
      catalog: project.catalog,
    },
  );
  assert.equal(
    [...artifacts.values()].every((artifact) => !('revision' in artifact)),
    true,
  );
});

test('operation schema changes invalidate the project revision', async () => {
  const original = fakeContext();
  await fernContentLoader(fixtureOptions()).load(original.context);
  const originalProject = original.entries.get(FERN_PROJECT_ENTRY_ID);
  assert.ok(originalProject?.kind === 'project');
  const originalRevision = originalProject.revision;

  const source = structuredClone(widgetsSpec);
  const responseSchema =
    source.paths?.['/widgets/{widget_id}']?.patch?.responses?.['200']?.content?.['application/json']?.schema;
  assert.ok(responseSchema && typeof responseSchema !== 'boolean');
  const idSchema = responseSchema.properties?.id;
  assert.ok(idSchema && typeof idSchema !== 'boolean');
  idSchema.type = 'integer';
  const changed = fakeContext();
  await fernContentLoader({ ...fixtureOptions(), source }).load(changed.context);
  const changedProject = changed.entries.get(FERN_PROJECT_ENTRY_ID);
  assert.ok(changedProject?.kind === 'project');
  const changedRevision = changedProject.revision;

  assert.notEqual(changedRevision, originalRevision);
});

test('a failed artifact publication leaves the previous store intact', async () => {
  const { context, entries } = fakeContext();
  const stale = {
    format: FERN_ARTIFACT_FORMAT_VERSION,
    kind: 'project',
    id: FERN_PROJECT_ENTRY_ID,
    revision: '0'.repeat(64),
    catalog: { snapshots: [], products: [] },
  } satisfies FernContentProjectEntrySchema;
  entries.set(FERN_PROJECT_ENTRY_ID, stale);
  context.publishArtifacts = async () => {
    throw new Error('artifact publication failed');
  };

  await assert.rejects(fernContentLoader(fixtureOptions()).load(context), /artifact publication failed/);
  assert.deepEqual([...entries.values()], [stale]);
});

test('the operation entry schema enforces availability shape', async () => {
  const source = defineFernProject(fixtureOptions()).getData().operations[0];
  assert.ok(source);
  const entry = await enrichOperationEntry(source, stubRenderer);
  assert.deepEqual(entry.operation.availability, { status: 'generally-available' });
  assert.equal(apiReferenceEntrySchema.safeParse(entry).success, true);

  const missingStatus = { ...entry, operation: { ...entry.operation, availability: { message: 'x' } } };
  assert.equal(apiReferenceEntrySchema.safeParse(missingStatus).success, false);
  const bareString = { ...entry, operation: { ...entry.operation, availability: 'generally-available' } };
  assert.equal(apiReferenceEntrySchema.safeParse(bareString).success, false);
});

test('the operation entry schema enforces normalized deprecation metadata', async () => {
  const source = structuredClone(widgetsSpec);
  const update = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(update);
  update['x-fern-availability'] = 'deprecated';
  const operation = defineFernProject({ ...fixtureOptions(), source }).getData().operations[0];
  assert.ok(operation);
  const entry = await enrichOperationEntry(operation, stubRenderer);

  assert.equal(entry.operation.deprecated, true);
  assert.equal(apiReferenceEntrySchema.safeParse(entry).success, true);
  assert.equal(
    apiReferenceEntrySchema.safeParse({
      ...entry,
      operation: { ...entry.operation, deprecated: 'yes' },
    }).success,
    false,
  );
});

test('content loading fails when the active Markdown renderer emits raw HTML', async () => {
  await assert.rejects(
    assertSanitizedMarkdownRenderer(async (markdown) => ({ html: `<p>${markdown}</p>` })),
    /renders raw HTML or unsafe URLs/,
  );
});

test('content loading fails when the active Markdown renderer emits javascript: links', async () => {
  await assert.rejects(
    assertSanitizedMarkdownRenderer(async () => ({ html: '<p>&lt;i&gt; <a href="javascript:probe">probe</a></p>' })),
    /renders raw HTML or unsafe URLs/,
  );
});

test('content loading accepts a renderer that escapes source HTML and neutralizes unsafe URLs', async () => {
  await assertSanitizedMarkdownRenderer(async () => ({
    html: '<p>&lt;i data-astro-fern-probe&gt;&lt;/i&gt; <a href="#">probe</a></p>',
  }));
});
