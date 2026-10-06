import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { jsonLoader, yamlLoader } from './openapi-file-loaders.ts';

const spec = {
  openapi: '3.0.3',
  info: { title: 'Ledger', version: '1' },
  paths: {
    '/accounts': {
      get: {
        operationId: 'Accounts_list',
        description: 'List accounts.',
        responses: { '200': { description: 'The accounts.' } },
      },
    },
  },
  components: { schemas: {} },
};

async function tempDir(context: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-openapi-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('reads a JSON spec', async (context) => {
  const path = join(await tempDir(context), 'ledger.json');
  await writeFile(path, JSON.stringify(spec));

  const documents = await jsonLoader().load({ format: 'json', location: path });

  assert.deepEqual(documents, [{ name: 'Ledger', document: spec }]);
});

test('reads a JSON spec that starts with a byte order mark', async (context) => {
  const path = join(await tempDir(context), 'ledger.json');
  await writeFile(path, `\uFEFF${JSON.stringify(spec)}`);

  const documents = await jsonLoader().load({ format: 'json', location: path });

  assert.deepEqual(documents, [{ name: 'Ledger', document: spec }]);
});

test('reads a YAML spec', async (context) => {
  const path = join(await tempDir(context), 'ledger.yaml');
  await writeFile(path, toYaml(spec));

  const documents = await yamlLoader().load({ format: 'yaml', location: path });

  assert.deepEqual(documents, [{ name: 'Ledger', document: spec }]);
});

test('reads from a file URL', async (context) => {
  const path = join(await tempDir(context), 'ledger.yml');
  await writeFile(path, toYaml(spec));

  const [document] = await yamlLoader().load({ format: 'yaml', location: pathToFileURL(path) });

  assert.equal(document?.name, 'Ledger');
});

test('applies YAML merge keys and allows repeated aliases', async (context) => {
  const path = join(await tempDir(context), 'anchors.yaml');
  const operations = Array.from({ length: 150 }, (_, index) =>
    [`  /item${index}:`, '    get:', `      operationId: item${index}`, '      responses: *responses'].join('\n'),
  );
  await writeFile(
    path,
    [
      'openapi: 3.0.3',
      'info: { title: Anchors, version: "1" }',
      'x-shared:',
      '  ok: &ok',
      '    description: ok',
      '  responses: &responses',
      "    '200':",
      '      <<: *ok',
      '      content: {}',
      'paths:',
      ...operations,
    ].join('\n'),
  );

  const [anchors] = await yamlLoader().load({ format: 'yaml', location: path });

  assert.deepEqual(anchors?.document.paths['/item149']?.get?.responses, { '200': { description: 'ok', content: {} } });
});

test('reads aliased YAML nodes as separate objects, as JSON would be', async (context) => {
  const path = join(await tempDir(context), 'aliases.yaml');
  await writeFile(
    path,
    [
      'openapi: 3.0.3',
      'info: { title: Aliases, version: "1" }',
      'paths:',
      '  /a:',
      '    get:',
      '      operationId: a',
      "      responses: &responses { '200': { description: ok } }",
      '  /b:',
      '    get:',
      '      operationId: b',
      '      responses: *responses',
    ].join('\n'),
  );

  const [aliases] = await yamlLoader().load({ format: 'yaml', location: path });
  const responses = (route: string) => aliases?.document.paths[route]?.get?.responses;

  assert.deepEqual(responses('/a'), responses('/b'));
  assert.notEqual(responses('/a'), responses('/b'));
});

test('reads unquoted YAML dates as strings, as JSON would', async (context) => {
  const path = join(await tempDir(context), 'dates.yaml');
  await writeFile(
    path,
    [
      'openapi: 3.0.3',
      'info: { title: Dates, version: 2024-01-01 }',
      'paths: {}',
      'components:',
      '  schemas:',
      '    Day: { type: string, format: date, example: 2024-01-01 }',
    ].join('\n'),
  );

  const [dates] = await yamlLoader().load({ format: 'yaml', location: path });

  assert.equal(dates?.document.info.version, '2024-01-01');
  assert.deepEqual(dates?.document.components?.schemas?.['Day'], {
    type: 'string',
    format: 'date',
    example: '2024-01-01',
  });
});

test('wraps read failures with the location and cause', async (context) => {
  const path = join(await tempDir(context), 'missing.json');

  await assert.rejects(jsonLoader().load({ format: 'json', location: path }), (error: Error) => {
    assert.match(error.message, /^Could not read the OpenAPI spec \(.*missing\.json\)$/);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});

test('rejects JSON that is only valid as YAML', async (context) => {
  const path = join(await tempDir(context), 'openapi.json');
  await writeFile(path, 'openapi: 3.0.3');

  await assert.rejects(jsonLoader().load({ format: 'json', location: path }), /not valid JSON/);
});

test('rejects YAML that does not parse', async (context) => {
  const path = join(await tempDir(context), 'broken.yaml');
  await writeFile(path, 'openapi: [');

  await assert.rejects(yamlLoader().load({ format: 'yaml', location: path }), /not valid YAML/);
});

test('rejects a document that is not OpenAPI 3.x, naming the fields it needs', async (context) => {
  const path = join(await tempDir(context), 'swagger.json');
  await writeFile(path, JSON.stringify({ ...spec, openapi: undefined, swagger: '2.0' }));

  await assert.rejects(
    jsonLoader().load({ format: 'json', location: path }),
    /not an OpenAPI 3\.x document with string `openapi`, `info\.title` and `info\.version` fields and a `paths` object/,
  );
});
