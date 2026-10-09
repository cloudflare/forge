import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  type ApiOverlayFile,
  applyForgeOverlays,
  createOpenApiLoaders,
  type ForgeOpenApiDocument,
  init,
  jsonLoader,
  resolveOperation,
  yamlLoader,
} from '@cloudflare/forge';
import { compile, NodeHost } from '@typespec/compiler';
import { typeSpecLoader } from './typespec-loader.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
// One spec written in TypeSpec, JSON and YAML. `tsp compile .` in this directory rewrites its openapi.json.
const gold = join(fixtures, 'gold');
const minimalSpec =
  'import "@typespec/http";\nusing Http;\n@service(#{ title: "Bare" })\nnamespace Bare;\n@route("/ping") @get op ping(): void;\n';

/** A loader whose warnings are collected rather than printed. */
function quietLoader(): { loader: ReturnType<typeof typeSpecLoader>; warnings: string[] } {
  const warnings: string[] = [];
  return { loader: typeSpecLoader({ onWarning: (message) => warnings.push(message) }), warnings };
}

async function tempDir(context: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-typespec-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A temporary TypeSpec project with the given files and only the given installed @typespec packages. */
async function tempProject(context: TestContext, packages: string[], files: Record<string, string>): Promise<string> {
  const project = await tempDir(context);
  await mkdir(join(project, 'node_modules', '@typespec'), { recursive: true });
  for (const name of packages) {
    const installed = join(import.meta.dirname, 'node_modules', '@typespec', name);
    await symlink(installed, join(project, 'node_modules', '@typespec', name), 'dir');
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(project, path, '..'), { recursive: true });
    await writeFile(join(project, path), content);
  }
  return project;
}

/** Runs the OpenAPI emitter on a fixture without a tspconfig.yaml, writing OpenAPI 3.0 as JSON and YAML. */
async function tspCompile(context: TestContext, fixture: string): Promise<string> {
  const outputDir = await tempDir(context);
  const program = await compile(NodeHost, join(fixtures, fixture), {
    emit: ['@typespec/openapi3'],
    options: {
      '@typespec/openapi3': {
        'emitter-output-dir': outputDir,
        'openapi-versions': ['3.0.0'],
        'file-type': ['json', 'yaml'],
      },
    },
  });
  assert.deepEqual(program.diagnostics, []);
  return outputDir;
}

/** Forge metadata for the gold spec's shelves, which the spec leaves to an overlay. */
const shelvesOverlay: ApiOverlayFile = {
  name: 'shelves',
  overlay: {
    overlay: '1.0.0',
    info: { title: 'Shelves', version: '1.0.0' },
    actions: [
      {
        target: '$',
        update: {
          'x-forge-commands': {
            shelves: {
              description: 'Browse the shelves.',
              methods: [
                {
                  operationId: 'Shelves_list',
                  'x-fern-sdk-method-name': 'list',
                  'x-fern-availability': 'generally-available',
                },
                {
                  operationId: 'Shelves_get',
                  'x-fern-sdk-method-name': 'get',
                  'x-fern-availability': 'generally-available',
                },
              ],
            },
          },
        },
      },
    ],
  },
};

/** Forge's state for a gold document: its commands, each operation as the resolver reads it, and the overlaid document. */
async function getForgeState(document: ForgeOpenApiDocument) {
  const forge = await init(structuredClone(document), [shelvesOverlay], { writeArtifacts: false });
  const operations = Object.fromEntries(getOperationIds(document).map((id) => [id, resolveOperation(id)]));
  const overlaid = await applyForgeOverlays(structuredClone(document), [shelvesOverlay]);
  return { commands: [...forge.commands], operations, overlaid };
}

function getOperationIds(document: ForgeOpenApiDocument): string[] {
  return Object.values(document.paths).flatMap((pathItem) =>
    Object.values(pathItem ?? {}).flatMap((operation) =>
      operation && typeof operation === 'object' && 'operationId' in operation ? [String(operation.operationId)] : [],
    ),
  );
}

test('reads a spec as the OpenAPI 3.0 document tsp compile writes, byte for byte', async (context) => {
  for (const [fixture, name] of [
    ['workshop', 'Workshop'],
    ['shared-route', 'Shared'],
  ] as const) {
    const outputDir = await tspCompile(context, fixture);
    const written = await readFile(join(outputDir, 'openapi.json'), 'utf8');

    const [loaded] = await quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, fixture) });

    assert.equal(loaded?.name, name);
    assert.equal(`${JSON.stringify(loaded?.document, null, 2)}\n`, written, fixture);
  }
});

test('reads the gold spec as the openapi.json tsp compile writes for it', async () => {
  const { loader, warnings } = quietLoader();
  const written = await readFile(join(gold, 'openapi.json'), 'utf8');

  const [library] = await loader.load({ format: 'typespec', entry: gold });

  assert.equal(library?.name, 'Library');
  assert.equal(`${JSON.stringify(library?.document, null, 2)}\n`, written);
  assert.deepEqual(warnings, []);
});

test('reads the gold spec from TypeSpec, JSON and YAML into the same document and Forge state', async () => {
  const loaders = createOpenApiLoaders(jsonLoader(), yamlLoader(), quietLoader().loader);

  const fromTypeSpec = await loaders.loadOne({ format: 'typespec', entry: gold });
  const fromJson = await loaders.loadOne({ format: 'json', location: join(gold, 'openapi.json') });
  const fromYaml = await loaders.loadOne({ format: 'yaml', location: join(gold, 'openapi.yaml') });

  // Compared serialized, so key order counts as well as content.
  assert.equal(JSON.stringify(fromJson), JSON.stringify(fromTypeSpec));
  assert.equal(JSON.stringify(fromYaml), JSON.stringify(fromTypeSpec));
  const state = await getForgeState(fromTypeSpec);
  assert.deepEqual(await getForgeState(fromJson), state);
  assert.deepEqual(await getForgeState(fromYaml), state);
});

test('builds the commands the gold spec and its overlay declare', async () => {
  const [library] = await quietLoader().loader.load({ format: 'typespec', entry: gold });
  assert.ok(library);

  const { commands } = await getForgeState(library.document);

  assert.deepEqual(commands, [
    [
      'books',
      {
        name: 'books',
        description: 'Manage the catalogue.',
        methods: [
          {
            name: 'list',
            operationId: 'Books_list',
            args: [
              {
                options: [
                  {
                    name: 'limit',
                    type: 'number',
                    required: { default: 20 },
                    description: 'The most books to return.',
                  },
                ],
              },
            ],
            status: 'generally-available',
            description: 'List the books in the catalogue.',
          },
          {
            name: 'create',
            operationId: 'Books_create',
            params: { title: { positional: true } },
            status: 'beta',
            description: 'Add a book to the catalogue.',
          },
          {
            name: 'export',
            operationId: 'Books_export',
            status: 'preview',
            description: 'Export the catalogue as CSV.',
          },
          {
            name: 'import',
            operationId: 'Books_importLegacy',
            status: 'deprecated',
            description: 'Import books from the previous catalogue.',
          },
          {
            name: 'find',
            operationId: 'Books_find',
            status: 'generally-available',
            description: 'Find books by title.',
          },
          {
            name: 'get',
            operationId: 'Books_get',
            status: 'generally-available',
            summary: 'Get a book',
            description: 'Return one book from the catalogue.',
          },
          {
            name: 'update',
            operationId: 'Books_update',
            params: { tags: { hidden: true } },
            status: 'generally-available',
            description: 'Replace a book in the catalogue.',
          },
          {
            name: 'delete',
            operationId: 'Books_delete',
            epilogue: 'A removed book cannot be restored.',
            requireConfirmation: 'This operation removes the book from the catalogue.',
            status: 'generally-available',
            description: 'Remove a book from the catalogue.',
          },
          {
            name: 'reviews',
            description: 'Manage reviews of a book.',
            epilogue: 'Reviews are public.',
            methods: [
              {
                name: 'list',
                operationId: 'Reviews_list',
                status: 'generally-available',
                description: 'List the reviews of a book.',
              },
              {
                name: 'create',
                operationId: 'Reviews_create',
                status: 'generally-available',
                description: 'Review a book.',
              },
            ],
          },
        ],
        globalCliArgs: [],
        hideCommand: false,
      },
    ],
    [
      'search',
      {
        name: 'search',
        description: 'Search the library.',
        methods: [{ name: 'books', operationId: 'Books_find', status: 'beta', description: 'Find books by title.' }],
        globalCliArgs: [
          {
            name: 'branch',
            type: 'string',
            required: { default: 'main' },
            description: 'The library branch to search.',
          },
        ],
        hideCommand: false,
      },
    ],
    [
      'shelves',
      {
        name: 'shelves',
        description: 'Browse the shelves.',
        methods: [
          {
            name: 'list',
            operationId: 'Shelves_list',
            status: 'generally-available',
            description: 'List the shelves.',
          },
          { name: 'get', operationId: 'Shelves_get', status: 'generally-available', description: 'Return one shelf.' },
        ],
        globalCliArgs: [],
        hideCommand: false,
      },
    ],
  ]);
});

test('resolves the gold spec operations as Forge reads them', async () => {
  const [library] = await quietLoader().loader.load({ format: 'typespec', entry: gold });
  assert.ok(library);

  const { operations } = await getForgeState(library.document);
  const operation = (operationId: string) => {
    const info = operations[operationId];
    assert.ok(info, operationId);
    return info;
  };

  const list = operation('Books_list');
  assert.deepEqual(
    list.queryParams.map(({ name, type, required, enumValues }) => ({ name, type, required, enumValues })),
    [
      { name: 'genre', type: 'string', required: false, enumValues: ['fiction', 'history', 'science'] },
      { name: 'tags', type: 'array', required: false, enumValues: undefined },
      { name: 'limit', type: 'number', required: false, enumValues: undefined },
      { name: 'cursor', type: 'string', required: false, enumValues: undefined },
    ],
  );
  assert.deepEqual(
    list.headerParams.map(({ name }) => name),
    ['x-request-id'],
  );
  assert.equal(list.responseRef, "components['schemas']['BookPage']");

  const get = operation('Books_get');
  assert.deepEqual([get.path, get.method], ['/books/{bookId}', 'get']);
  assert.deepEqual(
    get.pathParams.map(({ name, required }) => ({ name, required })),
    [{ name: 'bookId', required: true }],
  );
  assert.deepEqual(Object.keys(get.responses), ['200', '404']);

  const create = operation('Books_create');
  assert.equal(create.requestBodyRef, "components['schemas']['Book']");
  // `id` is read-only, so it is not part of the request.
  assert.equal(
    create.bodyParams.some(({ name }) => name === 'id'),
    false,
  );
  assert.deepEqual(Object.keys(create.responses), ['201']);

  assert.equal(operation('Books_importLegacy').requestBodyIsArray, true);
  assert.deepEqual(Object.keys(operation('Books_export').responses['200']?.content ?? {}), ['text/csv']);
  assert.deepEqual(Object.keys(operation('Books_delete').responses), ['204', '404']);
  assert.deepEqual(operation('Reviews_create').bodyDiscriminator, {
    field: 'kind',
    variants: { stars: ['stars'], written: ['text'] },
  });
  assert.equal(operation('Reviews_list').responseIsArray, true);
  assert.equal(operation('Shelves_get').responseRef, "components['schemas']['Shelf']");
});

test('accepts an entry relative to the working directory', async () => {
  const entry = relative(process.cwd(), join(fixtures, 'workshop'));

  const [workshop] = await quietLoader().loader.load({ format: 'typespec', entry });

  assert.equal(workshop?.name, 'Workshop');
});

test('accepts an entry as a file URL', async () => {
  const [workshop] = await quietLoader().loader.load({
    format: 'typespec',
    entry: pathToFileURL(join(fixtures, 'workshop', 'main.tsp')),
  });

  assert.equal(workshop?.name, 'Workshop');
});

test('passes Forge metadata declared with @extension through to Forge', async () => {
  const [accounts] = await quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'extension') });
  assert.ok(accounts);

  const forge = await init(accounts.document);

  assert.deepEqual(
    [...forge.commands].map(([name, command]) => [name, command.methods.map((method) => method.name)]),
    [['accounts', ['list']]],
  );
});

test('reads every service and version a spec defines, as tsp compile writes them', async (context) => {
  const outputDir = await tspCompile(context, 'services');

  const documents = await quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'services') });

  assert.deepEqual(
    documents.map((entry) => entry.name),
    ['Billing@v1', 'Billing@v2', 'Identity'],
  );
  for (const entry of documents) {
    const written = await readFile(join(outputDir, `openapi.${entry.name.replace('@', '.')}.json`), 'utf8');
    assert.equal(`${JSON.stringify(entry.document, null, 2)}\n`, written, entry.name);
  }
  const [v1, v2] = documents;
  assert.ok(v1 && v2);
  assert.deepEqual(getOperationIds(v1.document), ['Invoices_all']);
  assert.deepEqual(getOperationIds(v2.document), ['Invoices_list', 'Invoices_cancel']);
});

test('names documents by service and version as declared, not as sanitized into file names', async (context) => {
  const project = await tempProject(context, ['compiler', 'http', 'openapi3', 'versioning'], {
    'main.tsp': [
      'import "@typespec/http";',
      'import "@typespec/versioning";',
      'using Http;',
      'using Versioning;',
      '@service(#{ title: "Odd" })',
      '@versioned(Versions)',
      'namespace `Odd:Name` {',
      '  enum Versions { first: "2024/01" }',
      '  @route("/ping") @get op ping(): void;',
      '}',
    ].join('\n'),
  });

  const documents = await quietLoader().loader.load({ format: 'typespec', entry: project });

  assert.deepEqual(
    documents.map((document) => document.name),
    ['Odd:Name@2024/01'],
  );
});

test('reads every document when tspconfig.yaml declares parameters named like output file variables', async (context) => {
  const project = await tempProject(context, ['compiler', 'http', 'openapi3', 'versioning'], {
    'main.tsp': [
      'import "@typespec/http";',
      'import "@typespec/versioning";',
      'using Http;',
      'using Versioning;',
      '@service(#{ title: "Billing" })',
      '@versioned(Versions)',
      'namespace Billing {',
      '  enum Versions { v1, v2 }',
      '  @route("/invoices") @get op list(): string[];',
      '}',
    ].join('\n'),
    'tspconfig.yaml': 'parameters:\n  service-name:\n    default: pinned\n  version:\n    default: pinned\n',
  });

  const documents = await quietLoader().loader.load({ format: 'typespec', entry: project });

  assert.deepEqual(
    documents.map((document) => document.name),
    ['Billing@v1', 'Billing@v2'],
  );
});

test('narrows a source to one service and version', async () => {
  const { loader } = quietLoader();
  const entry = join(fixtures, 'services');

  const billing = await loader.load({ format: 'typespec', entry, service: 'Billing', version: 'v2' });
  const identity = await loader.load({ format: 'typespec', entry, service: 'Identity' });

  assert.deepEqual(
    billing.map((document) => document.name),
    ['Billing@v2'],
  );
  assert.deepEqual(
    identity.map((document) => document.name),
    ['Identity'],
  );
});

test('names every document when a selection matches none', async () => {
  const { loader } = quietLoader();
  const entry = join(fixtures, 'services');

  await assert.rejects(
    loader.load({ format: 'typespec', entry, service: 'Billing', version: 'v3' }),
    /defines no document "Billing@v3" \(.*services\)\. Documents:\n- Billing@v1\n- Billing@v2\n- Identity/,
  );
  await assert.rejects(loader.load({ format: 'typespec', entry, service: 'Payroll' }), /no document "Payroll"/);
});

test('applies the project tspconfig.yaml as tsp compile does, except for the OpenAPI version', async () => {
  const [catalog] = await quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'configured') });

  assert.ok(catalog);
  // The project asks for OpenAPI 3.1.0, fqn operation IDs (the default gives `Products_list`), and
  // `seal-object-schemas: "false"`, which the emitter's option schema coerces to a boolean.
  assert.equal(catalog.document.openapi, '3.0.0');
  assert.deepEqual(getOperationIds(catalog.document), ['Products.list']);
  assert.deepEqual(catalog.document.components?.schemas?.['Product'], {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  });
});

test('runs only the OpenAPI emitter and writes nothing', async (context) => {
  const project = await tempProject(context, ['compiler', 'http', 'openapi3'], {
    'main.tsp': minimalSpec,
    'tspconfig.yaml':
      'output-dir: "{project-root}/out"\nemit:\n  - "@typespec/not-installed"\n  - "@typespec/openapi3"\n',
  });

  const [bare] = await quietLoader().loader.load({ format: 'typespec', entry: project });

  assert.equal(bare?.name, 'Bare');
  await assert.rejects(access(join(project, 'out')), { code: 'ENOENT' });
  await assert.rejects(access(join(project, 'tsp-output')), { code: 'ENOENT' });
});

test('rejects OpenAPI emitter options the emitter does not define', async () => {
  await assert.rejects(
    quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'invalid-option') }),
    /does not compile[\s\S]*tspconfig\.yaml:\d+:\d+ - error invalid-schema/,
  );
});

test('rejects an invalid tspconfig.yaml', async () => {
  await assert.rejects(
    quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'invalid-config') }),
    /does not compile[\s\S]*tspconfig\.yaml:1:1 - error invalid-schema/,
  );
});

test('reports a warning as tsp compile --pretty=false prints it, without failing', async () => {
  const { loader, warnings } = quietLoader();

  const [legacy] = await loader.load({ format: 'typespec', entry: join(fixtures, 'warning') });

  assert.equal(legacy?.name, 'Legacy');
  assert.deepEqual(warnings, [
    `${relative(process.cwd(), join(fixtures, 'warning', 'main.tsp'))}:18:16 - warning deprecated: Deprecated: Use Item instead.`,
  ]);
});

test('reports each warning the OpenAPI emitter raises once', async () => {
  const route = quietLoader();
  const strategy = quietLoader();

  await route.loader.load({ format: 'typespec', entry: join(fixtures, 'route-warning') });
  await strategy.loader.load({ format: 'typespec', entry: join(fixtures, 'enum-strategy') });

  assert.equal(route.warnings.length, 1);
  assert.match(route.warnings[0] ?? '', /warning @typespec\/openapi3\/path-reserved-expansion/);
  assert.deepEqual(strategy.warnings, [
    'warning @typespec/openapi3/enum-strategy-not-supported: `enum-strategy: annotated` is only supported for OpenAPI 3.1.0 and above. The default enum strategy will be used for OpenAPI 3.0.0.',
  ]);
});

test('honors #suppress for warnings the OpenAPI emitter raises', async () => {
  const { loader, warnings } = quietLoader();

  await loader.load({ format: 'typespec', entry: join(fixtures, 'route-warning-suppressed') });

  assert.deepEqual(warnings, []);
});

test('treats warnings as errors when the project config asks for it', async () => {
  const { loader } = quietLoader();

  await assert.rejects(
    loader.load({ format: 'typespec', entry: join(fixtures, 'warn-as-error') }),
    /does not compile[\s\S]*main\.tsp:\d+:\d+ - error deprecated: Deprecated: Use Item instead\./,
  );
  await assert.rejects(
    loader.load({ format: 'typespec', entry: join(fixtures, 'route-warn-as-error') }),
    /does not compile[\s\S]*error @typespec\/openapi3\/path-reserved-expansion/,
  );
});

test('reports compile errors with their location', async () => {
  await assert.rejects(
    quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'compile-error') }),
    /The TypeSpec spec does not compile \(.*compile-error\):\n- .*main\.tsp:\d+:\d+ - error invalid-ref: Unknown identifier Money/,
  );
});

test('reports errors the OpenAPI emitter finds', async () => {
  const { loader } = quietLoader();

  await assert.rejects(
    loader.load({ format: 'typespec', entry: join(fixtures, 'schema-error') }),
    /does not compile[\s\S]*error @typespec\/openapi3\/enum-unique-type/,
  );
  await assert.rejects(
    loader.load({ format: 'typespec', entry: join(fixtures, 'route-error') }),
    /does not compile[\s\S]*error @typespec\/openapi3\/path-query/,
  );
});

test('compiles with the compiler installed in the spec project', async (context) => {
  const project = await tempProject(context, [], {
    'main.tsp': minimalSpec,
    'node_modules/@typespec/compiler/package.json': JSON.stringify({
      name: '@typespec/compiler',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { import: './index.js' } },
    }),
    'node_modules/@typespec/compiler/index.js':
      'export function resolveCompilerOptions() { throw new Error("project compiler was used"); }\n',
  });

  await assert.rejects(quietLoader().loader.load({ format: 'typespec', entry: project }), /project compiler was used/);
});

test('falls back to its own compiler when the spec project has none', async (context) => {
  const project = await tempProject(context, ['http', 'openapi3'], { 'main.tsp': minimalSpec });

  const [bare] = await quietLoader().loader.load({ format: 'typespec', entry: project });

  assert.equal(bare?.name, 'Bare');
});

test('fails as tsp compile does when the spec project lacks @typespec/openapi3', async (context) => {
  const project = await tempProject(context, ['compiler', 'http'], { 'main.tsp': minimalSpec });

  await assert.rejects(
    quietLoader().loader.load({ format: 'typespec', entry: project }),
    /does not compile[\s\S]*error emitter-not-found/,
  );
});

test('names a spec without @service by its placeholder title', async (context) => {
  const outputDir = await tspCompile(context, 'no-service');
  const written = await readFile(join(outputDir, 'openapi.json'), 'utf8');

  const [document] = await quietLoader().loader.load({ format: 'typespec', entry: join(fixtures, 'no-service') });

  assert.equal(document?.name, '(title)');
  assert.equal(`${JSON.stringify(document?.document, null, 2)}\n`, written);
});

test('wraps a missing entry with the location and cause', async () => {
  const entry = join(fixtures, 'missing.tsp');

  await assert.rejects(quietLoader().loader.load({ format: 'typespec', entry }), (error: Error) => {
    assert.match(error.message, /^Could not read the OpenAPI spec \(.*missing\.tsp\)$/);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});
