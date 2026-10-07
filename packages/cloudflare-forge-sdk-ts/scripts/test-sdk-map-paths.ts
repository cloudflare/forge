import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const mapper = fileURLToPath(new URL('./generate-sdk-map.ts', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

interface Operation {
  method: string;
  path: string;
  operationId?: string;
  ignored?: boolean;
  generatedPath?: string;
}

interface MapEntry {
  method: string;
  path: string;
  httpMethod: string;
  operationIdSource?: string;
}

function generateMap(t: TestContext, operations: Operation[]) {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdk-map-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const generated = join(root, 'sdk');
  mkdirSync(generated);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const item = (paths[operation.path] ??= {});
    item[operation.method.toLowerCase()] = {
      ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
      ...(operation.ignored ? { 'x-fern-ignore': true } : {}),
    };
  }
  const spec = join(root, 'openapi.json');
  writeFileSync(spec, JSON.stringify({ paths }));
  writeFileSync(
    join(generated, 'Client.ts'),
    `declare function handleNonStatusCodeError(error: unknown, response: unknown, method: string, path: string): void;
export class FixtureClient {
${operations
  .map(
    (operation, index) => `  public endpoint${index}(): void {
    handleNonStatusCodeError(null, null, ${JSON.stringify(operation.method.toUpperCase())}, ${JSON.stringify(operation.generatedPath ?? operation.path)});
  }`,
  )
  .join('\n')}
}
`,
  );
  writeFileSync(join(generated, 'index.ts'), 'export { FixtureClient } from "./Client.js";\n');
  const result = spawnSync(process.execPath, ['--import', 'tsx', mapper], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORGE_SDK_GENERATED: generated,
      FORGE_SDK_FERN_SPEC: spec,
      FORGE_SDK_SOURCE_SPEC: spec,
    },
  });
  return {
    result,
    readMap: () => JSON.parse(readFileSync(join(generated, 'sdk-map.json'), 'utf8')) as Record<string, MapEntry>,
  };
}

test('maps renamed path parameters to canonical paths and operation IDs', (t) => {
  const operations: Operation[] = [
    {
      method: 'get',
      path: '/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}',
      operationId: 'ai-search-namespace-fetch-instance',
      generatedPath: '/accounts/{account_id}/ai-search/namespaces/{namespace}/instances/{instance-id}',
    },
    {
      method: 'get',
      path: '/{account_or_zone}/{account_or_zone_id}/rulesets/{ruleset_id}',
      generatedPath: '/{account_or_zone}/{account_or_zone_id}/rulesets/{id}',
    },
    {
      method: 'post',
      path: '/accounts/{account_id}/abuse-reports/{report_param}',
      operationId: 'SubmitAbuseReport',
      generatedPath: '/accounts/{account_id}/abuse-reports/{report-type}',
    },
    {
      method: 'get',
      path: '/accounts/{account_id}/abuse-reports/{report_param}',
      operationId: 'GetAbuseReport',
      generatedPath: '/accounts/{account_id}/abuse-reports/{report-id}',
    },
    {
      method: 'delete',
      path: '/ignored/{id}',
      operationId: 'ignored',
      generatedPath: '/ignored/{renamed-id}',
      ignored: true,
    },
  ];
  const { result, readMap } = generateMap(t, operations);
  assert.equal(result.status, 0, result.stderr);
  const map = readMap();
  assert.equal(Object.keys(map).length, 4);
  for (const [index, operation] of operations.entries()) {
    if (operation.ignored) continue;
    const id = operation.operationId ?? `generated:${operation.method}:${operation.path}`;
    assert.deepEqual(map[id], {
      accessor: [],
      method: `endpoint${index}`,
      httpMethod: operation.method.toUpperCase(),
      path: operation.path,
      ...(operation.operationId === undefined ? { operationIdSource: 'synthetic' } : {}),
    });
  }
  assert.match(result.stdout, /unresolved spec ops: 0/);
});

test('repairs literal dots alongside renamed parameters without changing static segments', (t) => {
  const { result, readMap } = generateMap(t, [
    {
      method: 'get',
      path: '/files/{file_id}.{extension}',
      operationId: 'download',
      generatedPath: '/files/{id}/./{format}',
    },
    { method: 'get', path: '/files/latest', operationId: 'latest' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readMap()['download']?.path, '/files/{file_id}.{extension}');
  assert.equal(readMap()['latest']?.path, '/files/latest');
});

test('prefers exact matches when parameter-insensitive routes would be ambiguous', (t) => {
  const { result, readMap } = generateMap(t, [
    { method: 'get', path: '/items/{id}', operationId: 'by-id' },
    { method: 'get', path: '/items/{name}', operationId: 'by-name' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readMap()['by-id']?.method, 'endpoint0');
  assert.equal(readMap()['by-name']?.method, 'endpoint1');
});

test('rejects ambiguous parameter-insensitive matches', (t) => {
  const { result } = generateMap(t, [
    { method: 'get', path: '/items/{id}', operationId: 'by-id', generatedPath: '/items/{key}' },
    { method: 'get', path: '/items/{name}', operationId: 'by-name' },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ambiguous.*GET \/items\/\{key\}/);
  assert.match(result.stderr, /\/items\/\{id\}/);
  assert.match(result.stderr, /\/items\/\{name\}/);
});

test('retains the unresolved-operation guard for genuinely different routes', (t) => {
  const { result } = generateMap(
    t,
    Array.from({ length: 6 }, (_, index) => ({
      method: 'get',
      path: `/expected/${index}/{id}`,
      operationId: `missing-${index}`,
      generatedPath: `/different/${index}/{id}`,
    })),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /6 non-ignored operation\(s\).*threshold 5/);
});
