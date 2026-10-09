import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { narrowSdkClientErrorImports, narrowSdkErrorImports } from './sdk-error-imports.ts';

const errorNames = new Set(['BadRequestError']);

for (const [apiPath, errorsPath] of [
  ['./api/index.js', './api/errors/index.js'],
  ['../../../index.js', '../../../errors/index.js'],
  ['./api', './api/errors'],
  ['../../..', '../../../errors'],
  ['../../../index', '../../../errors'],
] as const) {
  test(`separates runtime errors from request types imported from ${apiPath}`, () => {
    const source = `import * as CloudflareApi from "${apiPath}";
export function request(body: CloudflareApi.Request): CloudflareApi.Response {
  throw new CloudflareApi.BadRequestError(body);
}`;
    const narrowed = narrowSdkClientErrorImports(source, errorNames);
    assert.ok(narrowed.includes(`import type * as CloudflareApi from "${apiPath}";`));
    assert.ok(narrowed.includes(`import * as CloudflareApiErrors from "${errorsPath}";`));
    assert.ok(narrowed.includes('new CloudflareApiErrors.BadRequestError(body)'));
    assert.ok(narrowed.includes('body: CloudflareApi.Request'));
    assert.equal(narrowSdkClientErrorImports(narrowed, errorNames), narrowed);
  });
}

test('drops runtime imports for types, type queries and documentation', () => {
  const source = `import * as CloudflareApi from './api/index.js';
/** @throws {@link CloudflareApi.BadRequestError} */
export type Request = CloudflareApi.Request;
export type ErrorConstructor = typeof CloudflareApi.BadRequestError;`;
  const narrowed = narrowSdkClientErrorImports(source, errorNames);
  assert.ok(narrowed.includes("import type * as CloudflareApi from './api/index.js';"));
  assert.ok(!narrowed.includes('CloudflareApiErrors'));
  assert.ok(narrowed.includes('@throws {@link CloudflareApi.BadRequestError}'));
});

test('rewrites syntax without changing comments, strings or regular expressions', () => {
  const source = `import * as CloudflareApi from './api/index.js';
// new CloudflareApi.BadRequestError(body)
export const message = 'new CloudflareApi.BadRequestError(body)';
export const pattern = /new CloudflareApi.BadRequestError/;
export function request(body: CloudflareApi.Request) {
  throw new CloudflareApi.BadRequestError(body);
}`;
  const narrowed = narrowSdkClientErrorImports(source, errorNames);
  assert.ok(narrowed.includes('throw new CloudflareApiErrors.BadRequestError(body)'));
  assert.ok(narrowed.includes('// new CloudflareApi.BadRequestError(body)'));
  assert.ok(narrowed.includes("'new CloudflareApi.BadRequestError(body)'"));
  assert.ok(narrowed.includes('/new CloudflareApi.BadRequestError/'));
});

test('rewrites constructors inside template substitutions only', () => {
  const source = `import * as CloudflareApi from './api/index.js';
export function request() {
  return \`CloudflareApi.BadRequestError: \${new CloudflareApi.BadRequestError()}\`;
}`;
  const narrowed = narrowSdkClientErrorImports(source, errorNames);
  assert.ok(narrowed.includes('`CloudflareApi.BadRequestError: ${new CloudflareApiErrors.BadRequestError()}`'));
});

for (const body of [
  'return CloudflareApi.Value;',
  'throw new CloudflareApi.UnknownError();',
  'return error instanceof CloudflareApi.BadRequestError;',
  'return CloudflareApi[key];',
  'return CloudflareApi;',
  'const { BadRequestError } = CloudflareApi; return new BadRequestError();',
  'const CloudflareApiErrors = 1; throw new CloudflareApi.BadRequestError(CloudflareApiErrors);',
  'const CloudflareApi = error; throw new CloudflareApi.BadRequestError();',
]) {
  test(`preserves unfamiliar runtime use: ${body}`, () => {
    const source = `import * as CloudflareApi from './api/index.js';
export function request(error: unknown, key: string) { ${body} }`;
    assert.equal(narrowSdkClientErrorImports(source, errorNames), source);
  });
}

test('supports multiline namespace imports', () => {
  const source = `import * as CloudflareApi
  from './api/index.js';
export function request() { throw new CloudflareApi.BadRequestError(); }`;
  assert.ok(narrowSdkClientErrorImports(source, errorNames).includes('new CloudflareApiErrors.BadRequestError()'));
});

test('preserves files without a runtime API namespace import', () => {
  const source = 'import type * as CloudflareApi from "./api/index.js";\nexport type Request = CloudflareApi.Request;';
  assert.equal(narrowSdkClientErrorImports(source, errorNames), source);
  assert.equal(narrowSdkClientErrorImports('export class Client {}', errorNames), 'export class Client {}');
});

test('normalizes root and nested clients without loading the API barrel or changing error identity', async (t) => {
  const generated = mkdtempSync(join(tmpdir(), 'forge-sdk-errors-'));
  t.after(() => rmSync(generated, { recursive: true, force: true }));
  const write = (path: string, source: string): void => writeFileSync(join(generated, path), source);
  mkdirSync(join(generated, 'api/errors'), { recursive: true });
  mkdirSync(join(generated, 'api/resources/things/client'), { recursive: true });
  const errorSource = `export class BadRequestError extends Error {
  name = 'BadRequestError';
  statusCode = 400;
  constructor(public body: unknown, public rawResponse: unknown) { super('Bad request'); }
}`;
  write('api/errors/BadRequestError.ts', errorSource);
  write('api/errors/index.ts', 'export { BadRequestError } from "./BadRequestError.js";\n');
  const barrel = `export * from './errors/index.js';
export * from './resources/index.js';
export interface Request { body: unknown; rawResponse: unknown; }
`;
  write('api/index.ts', barrel);
  write('api/resources/index.ts', 'throw new Error("SDK clients must not load the full API barrel");\nexport {};\n');
  for (const [path, apiPath] of [
    ['Client.ts', './api/index.js'],
    ['api/resources/things/client/Client.ts', '../../../index.js'],
  ] as const) {
    write(
      path,
      `import * as CloudflareApi from '${apiPath}';
export function request(input: CloudflareApi.Request): never {
  throw new CloudflareApi.BadRequestError(input.body, input.rawResponse);
}`,
    );
  }
  assert.equal(narrowSdkErrorImports(generated), 2);
  assert.equal(narrowSdkErrorImports(generated), 0);
  assert.equal(readFileSync(join(generated, 'api/index.ts'), 'utf8'), barrel);
  assert.equal(readFileSync(join(generated, 'api/errors/BadRequestError.ts'), 'utf8'), errorSource);
  const { BadRequestError } = await import(pathToFileURL(join(generated, 'api/errors/BadRequestError.ts')).href);
  const body = { errors: [{ code: 1000, message: 'Invalid query' }] };
  const rawResponse = new Response(JSON.stringify(body), { status: 400 });
  for (const path of ['Client.ts', 'api/resources/things/client/Client.ts']) {
    const { request } = await import(pathToFileURL(join(generated, path)).href);
    assert.throws(
      () => request({ body, rawResponse }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof BadRequestError);
        assert.equal(error.message, 'Bad request');
        assert.deepEqual({ ...error }, { name: 'BadRequestError', statusCode: 400, body, rawResponse });
        return true;
      },
    );
  }
});

test('supports SDKs with no declared HTTP error directory', (t) => {
  const generated = mkdtempSync(join(tmpdir(), 'forge-sdk-no-errors-'));
  t.after(() => rmSync(generated, { recursive: true, force: true }));
  writeFileSync(
    join(generated, 'Client.ts'),
    'import * as CloudflareApi from "./api/index.js";\nexport type Request = CloudflareApi.Request;',
  );
  assert.equal(narrowSdkErrorImports(generated), 1);
  assert.ok(readFileSync(join(generated, 'Client.ts'), 'utf8').startsWith('import type * as CloudflareApi'));
});
