import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderLlmsIndex,
  renderLlmsIndexFromCatalog,
  renderPageMarkdown,
  type SemanticHrefRequest,
  type SemanticHrefResolver,
} from './index.ts';
import type { FernContentCatalogSchema } from '../content/index.ts';
import type { FernPageSchema, RichTextSchema } from '../content/schema.ts';
import type { OpenApiDocumentSchema } from '../content/openapi.ts';
import { defineFernManifest } from '../manifest.ts';
import { defineFernProject } from '../project.ts';
import type { FernProjectView } from '../route-plan.ts';
import { createSnippetProvider, interpolatePath } from '../snippets/index.ts';
import {
  fixtureProject,
  fixtureExtension,
  fixtureSnippets,
  testProject,
  type TestProject,
  widgetsProduct,
  widgetsSpec,
} from '../test-fixture.ts';

// A renderer whose HTML deliberately differs from the Markdown, used to prove
// the agent output reads the raw Markdown source and never leaks rendered HTML.
const wrapHtml = (markdown: string): RichTextSchema => ({ markdown, html: `<HTML>${markdown}</HTML>` });

/**
 * Return the composed runtime view and an operation lookup. The shared test
 * helper explicitly joins route-neutral content with runtime routing config.
 */
async function enrichedView(
  project: TestProject = fixtureProject(),
): Promise<{ view: FernProjectView; byOperation: (operationId: string) => FernPageSchema }> {
  const view = project.getData();
  const byOperation = (operationId: string): FernPageSchema => {
    const page = view.pages.find((candidate) => candidate.operation.operationId === operationId);
    assert.ok(page, `expected operation "${operationId}"`);
    return page;
  };
  return { view, byOperation };
}

/**
 * A deliberately exhaustive single-operation spec ("Gadgets" API) that exercises
 * the parts of `renderPageMarkdown`/`schemaLines` the shared fixture can't:
 * query parameters, a nested object body, an array field, a `oneOf` union, and
 * enum/default/deprecated leaf metadata, plus an array-typed response. Kept local
 * to this file so it can't disturb routing.test.ts's route counts.
 */
const gadgetsSpec: OpenApiDocumentSchema = {
  components: {
    schemas: {
      GadgetKindA: { type: 'object', properties: { a: { type: 'string' } } },
      GadgetKindB: { type: 'object', properties: { b: { type: 'integer' } } },
    },
  },
  paths: {
    '/gadgets/{gadget_id}': {
      post: {
        operationId: 'gadgets_configure',
        summary: 'Configure gadget',
        description: 'Configures a [gadget](https://example.com/gadgets).',
        tags: ['Gadget Management'],
        'x-fern-sdk-group-name': 'gadgets',
        'x-fern-sdk-method-name': 'configure',
        'x-fern-availability': { status: 'beta', message: 'Subject to change.' },
        'x-test-confirmation': 'This operation removes <all> *gadgets*.',
        parameters: [
          { name: 'gadget_id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'page',
            in: 'query',
            required: false,
            description: 'Page number.',
            schema: { type: 'integer', default: 1 },
          },
          { name: 'mode', in: 'query', required: false, schema: { type: 'string', enum: ['fast', 'slow'] } },
        ],
        requestBody: {
          description: 'Configure the payload.\n\n- Keep this item.\n- Keep that item.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', description: 'Display name.' },
                  retries: { type: 'integer', default: 3, description: 'Retry count.' },
                  legacyField: { type: 'string', deprecated: true, description: 'Deprecated field.' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Tag list.' },
                  nested: { type: 'object', properties: { inner: { type: 'string', description: 'Inner value.' } } },
                  variant: {
                    oneOf: [{ $ref: '#/components/schemas/GadgetKindA' }, { $ref: '#/components/schemas/GadgetKindB' }],
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' }, status: { type: 'string', enum: ['ok', 'error'] } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Only curl renders; "go" is a configured target with no renderer, so it becomes
// a "coming soon" target (code: null) — exercising that branch of renderPageMarkdown.
const gadgetsSnippets = createSnippetProvider(
  {
    curl: {
      label: 'curl',
      syntax: 'bash',
      render: ({ op }) => `curl -X ${op.method.toUpperCase()} https://api.example.com${interpolatePath(op.path)}`,
    },
  },
  ['curl'],
);

function gadgetsProject(
  render?: (markdown: string) => RichTextSchema,
  source: OpenApiDocumentSchema = gadgetsSpec,
): TestProject {
  return testProject(
    {
      source,
      snippets: gadgetsSnippets,
      manifest: defineFernManifest({
        products: [{ id: 'gadgets', sections: [{ id: 'management', tag: 'Gadget Management' }] }],
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'go', kind: 'sdk', label: 'Go', language: 'go', packageName: 'gadgets-go', version: '1.2.3' },
        ],
      }),
      extensions: [fixtureExtension],
    },
    {},
    render,
  );
}

function deprecatedWidgetsProject(): TestProject {
  const source = structuredClone(widgetsSpec);
  const update = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(update);
  update.deprecated = true;
  return testProject({
    source,
    snippets: fixtureSnippets,
    manifest: defineFernManifest({ products: [widgetsProduct] }),
  });
}

function semanticManifest() {
  return defineFernManifest({
    products: [widgetsProduct],
    targets: [
      { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
      { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
    ],
  });
}

function semanticSource() {
  return {
    kind: 'snapshots' as const,
    snapshots: [
      { id: '2026-01-01', slug: 'v1', label: 'January 2026', default: true, source: widgetsSpec },
      { id: '2026-07-01', slug: 'v2', label: 'July 2026', source: widgetsSpec },
    ],
  };
}

function semanticProject(): TestProject {
  return testProject(
    { source: semanticSource(), snippets: fixtureSnippets, manifest: semanticManifest() },
    { routing: { target: 'path' }, agents: { markdown: false, llms: false } },
  );
}

function semanticCatalog(): FernContentCatalogSchema {
  return defineFernProject({
    source: semanticSource(),
    snippets: fixtureSnippets,
    manifest: semanticManifest(),
  }).getData().catalog;
}

test('aggregate page Markdown includes every execution target and the body/response sections', async () => {
  const { view, byOperation } = await enrichedView();
  const markdown = renderPageMarkdown(byOperation('widgets_update'), { directive: view.agents.directive }).body;
  assert.match(markdown, /## Execute with curl/);
  assert.match(markdown, /## Execute with Python/);
  assert.match(markdown, /## Request body/);
  assert.match(markdown, /Required: yes/);
  assert.match(markdown, /Content types: `application\/json`/);
  assert.doesNotMatch(markdown, /Schema shown for:/);
  assert.match(markdown, /Fields to update on the \[widget\]/);
  assert.match(markdown, /## Responses/);
  assert.match(markdown, /### Response `200`/);
  assert.match(markdown, /##### Example `updated`/);
  assert.match(markdown, /Summary: Updated widget/);
  assert.match(markdown, /"id": "id"/);
  assert.doesNotMatch(markdown, /^## Response example$/m);
  assert.match(markdown, /- Section: Widget Management/);
  assert.match(markdown, /- Snapshot: Current/);
});

test('target Markdown includes only the selected execution target', async () => {
  const { byOperation } = await enrichedView();
  const markdown = renderPageMarkdown(byOperation('widgets_update'), { target: 'python' }).body;
  assert.match(markdown, /## Execute with Python/);
  assert.doesNotMatch(markdown, /## Execute with curl/);
});

test('the directive is emitted only when provided', async () => {
  const { view, byOperation } = await enrichedView();
  const page = byOperation('widgets_update');
  const directive = view.agents.directive;
  assert.ok(typeof directive === 'string' && directive.length > 0);
  assert.ok(renderPageMarkdown(page, { directive }).body.startsWith(directive));

  const withoutDirective = renderPageMarkdown(page, {}).body;
  assert.ok(withoutDirective.startsWith('# '));
  assert.doesNotMatch(withoutDirective, /optimized for agents/);
});

test('renders operation availability with its message', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /- Availability: beta \(Subject to change\.\)/);
});

test('renders normalized deprecation instead of conflicting active availability', async () => {
  const { byOperation } = await enrichedView(deprecatedWidgetsProject());
  const markdown = renderPageMarkdown(byOperation('widgets_update')).body;
  assert.match(markdown, /- Availability: deprecated/);
  assert.doesNotMatch(markdown, /generally-available/);
});

test('renders confirmation metadata as escaped plain text', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.ok(markdown.includes('> **Destructive operation:** This operation removes \\<all\\> \\*gadgets\\*.'));
});

test('renders query parameters with allowed values and defaults', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /## Query parameters/);
  assert.match(markdown, /Allowed values: `fast`, `slow`/);
  assert.match(markdown, /Default: `1`/);
});

test('renders Fern enum descriptions and per-value deprecation', async () => {
  const source = structuredClone(gadgetsSpec);
  const operation = source.paths?.['/gadgets/{gadget_id}']?.post;
  const mode = operation?.parameters?.find((parameter) => parameter.name === 'mode')?.schema;
  assert.ok(mode && typeof mode !== 'boolean');
  mode['x-fern-enum'] = {
    fast: { description: 'Completes **quickly**.' },
    slow: { description: 'Use `fast` instead.', deprecated: true },
  };
  const { byOperation } = await enrichedView(gadgetsProject(wrapHtml, source));
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;

  assert.match(markdown, /- `fast`\n  Completes \*\*quickly\*\*\./);
  assert.match(markdown, /- `slow` \(deprecated\)\n  Use `fast` instead\./);
  assert.doesNotMatch(markdown, /<HTML>/);
});

test('renders associated Fern examples before generated target snippets', async () => {
  const source = structuredClone(widgetsSpec);
  const operation = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(operation);
  operation['x-fern-examples'] = [
    {
      name: 'Rename widget',
      'path-parameters': { widget_id: 'widget-1' },
      request: { name: 'renamed' },
      response: { body: { id: 'widget-1', name: 'renamed' } },
      'code-samples': [{ language: 'Elixir', install: 'mix deps.get', code: 'Widgets.rename()' }],
    },
  ];
  const project = testProject({
    source,
    snippets: fixtureSnippets,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [{ id: 'python', kind: 'sdk', label: 'Python', language: 'python' }],
    }),
  });
  const { byOperation } = await enrichedView(project);
  const markdown = renderPageMarkdown(byOperation('widgets_update'), { target: 'python' }).body;

  assert.match(markdown, /## Examples/);
  assert.match(markdown, /### Rename widget/);
  assert.match(markdown, /#### Request/);
  assert.match(markdown, /#### Custom code sample: Elixir/);
  assert.match(markdown, /mix deps\.get/);
  assert.match(markdown, /#### Response body/);
  assert.ok(markdown.indexOf('### Rename widget') < markdown.indexOf('## Execute with Python'));
});

test('renders associated text and binary bodies without JSON quoting', async () => {
  const source = structuredClone(widgetsSpec);
  const operation = source.paths?.['/widgets/{widget_id}']?.patch;
  assert.ok(operation);
  operation.requestBody = { content: { 'text/plain': { schema: { type: 'string' } } } };
  operation.responses = {
    '200': { content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
  };
  operation['x-fern-examples'] = [
    { name: 'Raw bodies', request: 'plain request', response: { body: '%PDF-response' } },
  ];
  const { byOperation } = await enrichedView(
    testProject({
      source,
      snippets: fixtureSnippets,
      manifest: defineFernManifest({ products: [widgetsProduct], targets: [] }),
    }),
  );
  const markdown = renderPageMarkdown(byOperation('widgets_update')).body;

  assert.match(markdown, /##### Body\n\n```text\nplain request\n```/);
  assert.match(markdown, /#### Response body\n\n```text\n%PDF-response\n```/);
  assert.doesNotMatch(markdown, /"(?:plain request|%PDF-response)"/);
});

test('renders a nested request body: children, array items, unions, defaults, deprecated', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /## Request body/);
  // A top-level object field renders at H3; its nested field one level deeper at H4.
  assert.match(markdown, /\n### `nested`/);
  assert.match(markdown, /\n#### `inner`/);
  // An array field expands its element schema via `items`.
  assert.match(markdown, /\n### `tags`/);
  assert.match(markdown, /Type: `string\[\]`/);
  // A `oneOf` field expands each variant.
  assert.match(markdown, /\n### `variant`/);
  assert.match(markdown, /GadgetKindA/);
  assert.match(markdown, /GadgetKindB/);
  // Per-node leaf metadata.
  assert.match(markdown, /Deprecated: yes/);
  assert.match(markdown, /Default: `3`/);
});

test('renders generated array responses and their full wire schema', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /## Responses/);
  assert.match(markdown, /### Response `200`/);
  assert.match(markdown, /##### Generated example/);
  assert.match(markdown, /##### Schema/);
  assert.match(markdown, /Type: `object\[\]`/);
  assert.match(markdown, /\n###### `status`/);
  assert.match(markdown, /Allowed values: `ok`, `error`/);
});

test('agent Markdown renders every response, representation, example, and bodyless status in order', async () => {
  const source = structuredClone(gadgetsSpec);
  assert.ok(source.components);
  source.components.examples = {
    RemoteCreated: {
      summary: 'Remote example',
      description: 'Hosted **outside** this document.',
      externalValue: 'https://example.com/examples/gadget.json',
    },
  };
  const operation = source.paths?.['/gadgets/{gadget_id}']?.post;
  assert.ok(operation);
  operation.responses = {
    '201': {
      description: 'The gadget was **created**.',
      content: {
        'application/json': {
          examples: {
            created: {
              summary: 'Created gadget',
              description: 'The complete **wire envelope**.',
              value: { success: true, result: { id: 'gadget-1' } },
            },
            null: { value: null },
            empty: { value: {} },
            remote: { $ref: '#/components/examples/RemoteCreated' },
          },
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              result: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
        'text/plain': { example: 'created\nwithout JSON quotes', schema: { type: 'string' } },
        'application/x-ndjson': {
          example: '{"id":"one"}\n{"id":"two"}',
          schema: { type: 'string' },
        },
      },
    },
    '202': {
      description: 'The gadget was queued.',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { jobId: { type: 'string' } } },
        },
      },
    },
    '204': { description: 'The operation completed without a response body.' },
    '4XX': { description: 'The request was rejected without a body.' },
    default: { description: 'No response body is documented.' },
  };

  const page = gadgetsProject(wrapHtml, source).getData().pages[0];
  assert.ok(page);
  const markdown = renderPageMarkdown(page).body;
  const statuses = ['201', '202', '204', '4XX', 'default'];
  const positions = statuses.map((status) => markdown.indexOf(`### Response \`${status}\``));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    positions.slice().sort((left, right) => left - right),
  );
  assert.match(markdown, /Category: success/);
  assert.match(markdown, /Category: client-error/);
  assert.match(markdown, /Category: default/);
  assert.match(markdown, /The gadget was \*\*created\*\*\./);
  assert.match(markdown, /#### `application\/json`/);
  assert.match(markdown, /#### `text\/plain`/);
  assert.match(markdown, /#### `application\/x-ndjson`/);
  assert.match(markdown, /##### Example `created`/);
  assert.match(markdown, /Summary: Created gadget/);
  assert.match(markdown, /The complete \*\*wire envelope\*\*\./);
  assert.match(markdown, /##### Example `remote`/);
  assert.match(markdown, /Summary: Remote example/);
  assert.match(markdown, /Hosted \*\*outside\*\* this document\./);
  assert.match(markdown, /External value: https:\/\/example\.com\/examples\/gadget\.json/);
  assert.match(markdown, /```json\n\{\n  "success": true/);
  assert.match(markdown, /```json\nnull\n```/);
  assert.match(markdown, /```json\n\{\}\n```/);
  assert.match(markdown, /```text\ncreated\nwithout JSON quotes\n```/);
  assert.match(markdown, /```text\n\{"id":"one"\}\n\{"id":"two"\}\n```/);
  assert.equal(markdown.match(/##### Generated example/g)?.length, 1);
  assert.ok((markdown.match(/##### Schema/g)?.length ?? 0) >= 4);
  assert.doesNotMatch(markdown, /<HTML>/);
  assert.doesNotMatch(markdown, /^## Response example$/m);

  const noContentBlock = markdown.slice(positions[2], positions[3]);
  assert.match(noContentBlock, /The operation completed without a response body\./);
  assert.doesNotMatch(noContentBlock, /^#### /m);
  const defaultBlock = markdown.slice(positions[4], markdown.indexOf('## Related representations'));
  assert.match(defaultBlock, /No response body is documented\./);
  assert.doesNotMatch(defaultBlock, /^#### /m);
});

test('renders a coming-soon target when no snippet is available', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /## Execute with curl/);
  assert.match(markdown, /## Execute with Go/);
  assert.match(markdown, /Version: `1\.2\.3`/);
  assert.match(markdown, /A Go example is not available yet\./);
});

test('lists related representations (human doc, target Markdown, llms indexes)', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /## Related representations/);
  assert.match(markdown, /\[Human documentation\]\(/);
  assert.match(markdown, /curl Markdown\]\(/);
  assert.match(markdown, /Go Markdown\]\(/);
  assert.doesNotMatch(markdown, /go Markdown\]\(/);
  assert.match(markdown, /llms\.txt\]\(/);
});

test('semantic related links use canonical identities even when agent features are disabled', () => {
  const view = semanticProject().getData();
  const page = view.pages.find((candidate) => candidate.snapshot.id === '2026-07-01');
  assert.ok(page);
  assert.equal(page.agentLinks.markdown, undefined);
  assert.deepEqual(page.agentLinks.llms, []);
  assert.ok(page.targets.every((target) => target.markdownHref === undefined));

  const calls: SemanticHrefRequest[] = [];
  const resolveHref: SemanticHrefResolver = (request) => {
    calls.push(request);
    return request.kind === 'operation'
      ? `/resolve?representation=${request.representation}&target=${request.targetId ?? 'all'}`
      : `/resolve?llms=${request.scope}`;
  };
  const markdown = renderPageMarkdown(page, { target: 'python', resolveHref }).body;

  assert.deepEqual(calls, [
    {
      kind: 'operation',
      representation: 'human',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      operationId: 'widgets_update',
      targetId: 'python',
    },
    {
      kind: 'operation',
      representation: 'markdown',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      operationId: 'widgets_update',
      targetId: 'curl',
    },
    {
      kind: 'operation',
      representation: 'markdown',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      operationId: 'widgets_update',
      targetId: 'python',
    },
    { kind: 'llms', scope: 'site' },
    { kind: 'llms', scope: 'product', productId: 'widgets' },
    { kind: 'llms', scope: 'snapshot', productId: 'widgets', snapshotId: '2026-07-01' },
  ]);
  assert.match(markdown, /\[Human documentation\]\(\/resolve\?representation=human&target=python\)/);
  assert.match(markdown, /\[curl Markdown\]\(\/resolve\?representation=markdown&target=curl\)/);
  assert.match(markdown, /\[Python Markdown\]\(\/resolve\?representation=markdown&target=python\)/);
  assert.match(markdown, /\[site llms\.txt\]\(\/resolve\?llms=site\)/);
  assert.match(markdown, /\[product llms\.txt\]\(\/resolve\?llms=product\)/);
  assert.match(markdown, /\[snapshot llms\.txt\]\(\/resolve\?llms=snapshot\)/);
});

test('semantic related links resolve a default snapshot index when product scope is unavailable', () => {
  const page = semanticProject()
    .getData()
    .pages.find((candidate) => candidate.snapshot.id === '2026-01-01');
  assert.ok(page);
  const calls: SemanticHrefRequest[] = [];
  const markdown = renderPageMarkdown(page, {
    resolveHref(request) {
      calls.push(request);
      return request.kind === 'llms' && request.scope === 'snapshot' ? '/api/widgets/llms.txt' : undefined;
    },
  }).body;
  assert.deepEqual(
    calls.filter((request) => request.kind === 'llms'),
    [
      { kind: 'llms', scope: 'site' },
      { kind: 'llms', scope: 'product', productId: 'widgets' },
      { kind: 'llms', scope: 'snapshot', productId: 'widgets', snapshotId: '2026-01-01' },
    ],
  );
  assert.match(markdown, /\[snapshot llms\.txt\]\(\/api\/widgets\/llms\.txt\)/);
});

test('agent Markdown uses the raw Markdown description, never the rendered HTML', async () => {
  const { byOperation } = await enrichedView(gadgetsProject(wrapHtml));
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  // The raw Markdown link survives into the agent output…
  assert.match(markdown, /\[gadget\]\(https:\/\/example\.com\/gadgets\)/);
  // …and the renderer's HTML wrapper never leaks into it.
  assert.doesNotMatch(markdown, /<HTML>/);
});

test('agent Markdown preserves request-body paragraphs and lists', async () => {
  const { byOperation } = await enrichedView(gadgetsProject());
  const markdown = renderPageMarkdown(byOperation('gadgets_configure')).body;
  assert.match(markdown, /Configure the payload\.\n\n- Keep this item\.\n- Keep that item\./);
});

test('agent Markdown uses a safe code span for media types containing backticks', async () => {
  const source = structuredClone(widgetsSpec);
  const requestBody = source.paths?.['/widgets/{widget_id}']?.patch?.requestBody;
  const media = requestBody?.content?.['application/json'];
  assert.ok(requestBody && media);
  requestBody.content = { 'application/`json': media };
  const page = testProject({
    source,
    snippets: fixtureSnippets,
    manifest: defineFernManifest({ products: [widgetsProduct] }),
  }).getData().pages[0];
  assert.ok(page);

  const markdown = renderPageMarkdown(page).body;
  assert.match(markdown, /Content types: ``application\/`json``/);
});

test('llms product index links to operation Markdown and lists execution targets', async () => {
  const { view } = await enrichedView();
  const route = view.agentRoutes.find(
    (candidate) => candidate.kind === 'llms-index' && candidate.pathname === '/api/widgets/llms.txt',
  );
  assert.ok(route);
  const markdown = renderLlmsIndex(view, route).body;
  assert.match(markdown, /# Widgets/);
  assert.match(markdown, /## API operations/);
  assert.match(markdown, /### Widget Management/);
  assert.match(markdown, /Update widget/);
  assert.match(markdown, /\.md\)/);
  assert.match(markdown, /## Execution targets/);
});

test('llms site index lists products', async () => {
  const { view } = await enrichedView();
  const route = view.agentRoutes.find((candidate) => candidate.id === 'llms:site');
  assert.ok(route);
  const markdown = renderLlmsIndex(view, route).body;
  assert.match(markdown, /## Products/);
  assert.match(markdown, /\[Widgets\]\(/);
});

test('catalog site index resolves product links semantically', () => {
  const calls: SemanticHrefRequest[] = [];
  const markdown = renderLlmsIndexFromCatalog(semanticCatalog(), { kind: 'llms', scope: 'site' }, (request) => {
    calls.push(request);
    return request.kind === 'llms' && request.scope === 'product'
      ? `/agent-index?product=${request.productId}`
      : undefined;
  }).body;

  assert.match(markdown, /# API documentation/);
  assert.match(markdown, /## Products/);
  assert.match(markdown, /\[Widgets\]\(\/agent-index\?product=widgets\)/);
  assert.deepEqual(calls, [{ kind: 'llms', scope: 'product', productId: 'widgets' }]);
});

test('catalog indexes retain entries when narrower llms routes are disabled', () => {
  const catalog = semanticCatalog();
  const site = renderLlmsIndexFromCatalog(catalog, { kind: 'llms', scope: 'site' }, () => undefined).body;
  assert.match(site, /^- Widgets: /m);
  assert.doesNotMatch(site, /\[Widgets\]\(/);

  const product = renderLlmsIndexFromCatalog(
    catalog,
    { kind: 'llms', scope: 'product', productId: 'widgets' },
    (request) => (request.kind === 'operation' ? '/operation' : undefined),
  ).body;
  assert.match(product, /\[Update widget\]\(\/operation\)/);
  assert.match(product, /^- curl$/m);
  assert.match(product, /^- Python$/m);
});

test('catalog product index uses its default snapshot and prefers operation Markdown', () => {
  const calls: SemanticHrefRequest[] = [];
  const markdown = renderLlmsIndexFromCatalog(
    semanticCatalog(),
    { kind: 'llms', scope: 'product', productId: 'widgets' },
    (request) => {
      calls.push(request);
      if (request.kind === 'operation') {
        return `/operation?snapshot=${request.snapshotId}&representation=${request.representation}`;
      }
      if (request.scope === 'target') return `/target-index?target=${request.targetId}`;
      return undefined;
    },
  ).body;

  assert.match(markdown, /# Widgets/);
  assert.doesNotMatch(markdown, /January 2026/);
  assert.match(markdown, /Update widget/);
  assert.match(markdown, /snapshot=2026-01-01&representation=markdown/);
  assert.deepEqual(calls, [
    {
      kind: 'operation',
      representation: 'markdown',
      productId: 'widgets',
      snapshotId: '2026-01-01',
      operationId: 'widgets_update',
    },
    {
      kind: 'llms',
      scope: 'target',
      productId: 'widgets',
      snapshotId: '2026-01-01',
      targetId: 'curl',
    },
    {
      kind: 'llms',
      scope: 'target',
      productId: 'widgets',
      snapshotId: '2026-01-01',
      targetId: 'python',
    },
  ]);
});

test('catalog snapshot index selects the exact canonical snapshot ID', () => {
  const calls: SemanticHrefRequest[] = [];
  const markdown = renderLlmsIndexFromCatalog(
    semanticCatalog(),
    { kind: 'llms', scope: 'snapshot', productId: 'widgets', snapshotId: '2026-07-01' },
    (request) => {
      calls.push(request);
      return request.kind === 'operation' ? `/operation?snapshot=${request.snapshotId}` : undefined;
    },
  ).body;

  assert.match(markdown, /# Widgets - July 2026/);
  assert.match(markdown, /\?snapshot=2026-07-01/);
  assert.deepEqual(calls[0], {
    kind: 'operation',
    representation: 'markdown',
    productId: 'widgets',
    snapshotId: '2026-07-01',
    operationId: 'widgets_update',
  });
});

test('catalog target index scopes operation links to that target and falls back to the human representation', () => {
  const calls: SemanticHrefRequest[] = [];
  const markdown = renderLlmsIndexFromCatalog(
    semanticCatalog(),
    {
      kind: 'llms',
      scope: 'target',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      targetId: 'python',
    },
    (request) => {
      calls.push(request);
      if (request.kind !== 'operation') return undefined;
      if (request.representation === 'markdown') return undefined;
      return `/operation?representation=human&target=${request.targetId}`;
    },
  ).body;

  assert.match(markdown, /# Widgets - July 2026 - python/);
  assert.match(markdown, /\[Update widget\]\(\/operation\?representation=human&target=python\)/);
  assert.deepEqual(calls.slice(0, 2), [
    {
      kind: 'operation',
      representation: 'markdown',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      operationId: 'widgets_update',
      targetId: 'python',
    },
    {
      kind: 'operation',
      representation: 'human',
      productId: 'widgets',
      snapshotId: '2026-07-01',
      operationId: 'widgets_update',
      targetId: 'python',
    },
  ]);
  assert.ok(calls.filter((request) => request.kind === 'operation').every((request) => request.targetId === 'python'));
});

test('catalog llms requests reject inexact or unknown identities', () => {
  const catalog = semanticCatalog();
  const unresolved: SemanticHrefResolver = () => undefined;
  assert.throws(
    () => renderLlmsIndexFromCatalog(catalog, { kind: 'llms', scope: 'product', productId: 'Widgets' }, unresolved),
    /semantic product ID "Widgets" is not in the catalog/,
  );
  assert.throws(
    () =>
      renderLlmsIndexFromCatalog(
        catalog,
        { kind: 'llms', scope: 'snapshot', productId: 'widgets', snapshotId: 'v2' },
        unresolved,
      ),
    /product "widgets" is unavailable in semantic snapshot "v2"/,
  );
  assert.throws(
    () =>
      renderLlmsIndexFromCatalog(
        catalog,
        {
          kind: 'llms',
          scope: 'target',
          productId: 'widgets',
          snapshotId: '2026-07-01',
          targetId: 'Python',
        },
        unresolved,
      ),
    /target "Python" is unavailable for product "widgets" snapshot "2026-07-01"/,
  );

  const withoutDefault = structuredClone(catalog);
  for (const snapshot of withoutDefault.products[0]?.snapshots ?? []) snapshot.default = false;
  assert.throws(
    () =>
      renderLlmsIndexFromCatalog(withoutDefault, { kind: 'llms', scope: 'product', productId: 'widgets' }, unresolved),
    /unavailable in the global default snapshot/,
  );
});

test('llms indexes normalize product slugs and URL-encode target path segments', async () => {
  const encodedProject = testProject({
    source: widgetsSpec,
    manifest: defineFernManifest({
      products: [{ id: 'widget tools', sections: widgetsProduct.sections }],
      targets: [{ id: 'c++', kind: 'sdk', label: 'C++', language: 'cpp' }],
    }),
  });
  const view = (await enrichedView(encodedProject)).view;
  const siteRoute = view.agentRoutes.find((candidate) => candidate.id === 'llms:site');
  assert.ok(siteRoute);
  assert.match(renderLlmsIndex(view, siteRoute).body, /\/api\/widget-tools\/llms\.txt/);

  const productRoute = view.agentRoutes.find(
    (candidate) => candidate.kind === 'llms-index' && candidate.pathname === '/api/widget-tools/llms.txt',
  );
  assert.ok(productRoute);
  assert.match(renderLlmsIndex(view, productRoute).body, /\/targets\/c%2B%2B\/llms\.txt/);
});

function widgetsNoMarkdown(): TestProject {
  return testProject(
    {
      source: widgetsSpec,
      snippets: fixtureSnippets,
      manifest: defineFernManifest({
        products: [widgetsProduct],
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
        ],
      }),
    },
    { routing: { target: 'path' }, agents: { markdown: false } },
  );
}

test('llms product index falls back to the human page when Markdown is disabled', async () => {
  const { view } = await enrichedView(widgetsNoMarkdown());
  const route = view.agentRoutes.find(
    (candidate) => candidate.kind === 'llms-index' && candidate.pathname === '/api/widgets/llms.txt',
  );
  assert.ok(route);
  const markdown = renderLlmsIndex(view, route).body;
  assert.match(markdown, /## API operations/);
  assert.match(markdown, /Update widget/);
  assert.match(markdown, /\(\/api\/widgets\/sections\/management\/operations\/widgets-update\/\)/);
  assert.doesNotMatch(markdown, /\.md\)/);
});

test('llms target index falls back to the human target page when Markdown is disabled', async () => {
  const { view } = await enrichedView(widgetsNoMarkdown());
  const route = view.agentRoutes.find(
    (candidate) => candidate.kind === 'llms-index' && candidate.scope?.target === 'python',
  );
  assert.ok(route);
  const markdown = renderLlmsIndex(view, route).body;
  assert.match(markdown, /Update widget/);
  assert.match(markdown, /\/api\/widgets\/python\/sections\/management\/operations\/widgets-update\//);
  assert.doesNotMatch(markdown, /\.md\)/);
});
