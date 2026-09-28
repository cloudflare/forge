import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { commandCatalogLoader, remoteCommandCatalogSource } from './command-reference/loader.ts';
import { commandCatalogSchema, commandMetadataSchema } from './command-reference/schema.ts';

const deploy = {
  command: 'cf deploy',
  name: 'deploy',
  fullPath: ['deploy'],
  description: 'Deploy an application to Cloudflare.',
  usage: 'cf deploy [options]',
  arguments: [],
  options: [
    {
      name: 'config',
      type: 'string',
      required: false,
      description: 'Path to the configuration file.',
    },
  ],
  category: 'action',
  hideCommand: false,
} as const;

test('command metadata accepts commands without OpenAPI linkage', () => {
  assert.equal(commandMetadataSchema.parse(deploy).command, 'cf deploy');
});

test('the vendored hand-written command catalog is adapted into documentation metadata', () => {
  assert.equal(cfCommandCatalog.commands.length, 22);
  assert.equal(
    cfCommandCatalog.commands.some(({ command }) => command === 'cf agent-context'),
    true,
  );
  assert.equal(
    cfCommandCatalog.commands.some(({ command }) => command === 'cf workers triggers deploy'),
    true,
  );
  assert.equal(
    cfCommandCatalog.commands.some((command) => 'handWritten' in command),
    false,
  );
});

test('command metadata accepts complete optional OpenAPI linkage', () => {
  assert.equal(
    commandMetadataSchema.parse({
      ...deploy,
      operationId: 'deploy',
      httpMethod: 'POST',
      apiPath: '/deployments',
    }).operationId,
    'deploy',
  );
});

test('command metadata accepts independently optional OpenAPI linkage', () => {
  assert.equal(
    commandMetadataSchema.safeParse({ ...deploy, operationId: 'deploy', httpMethod: 'TRACE' }).success,
    true,
  );
});

test('command metadata accepts JSON defaults and dynamic argument completion', () => {
  assert.equal(
    commandMetadataSchema.safeParse({
      ...deploy,
      arguments: [
        {
          name: 'zone',
          position: 0,
          type: 'string',
          required: true,
          description: 'Zone identifier.',
          completion: { type: 'dynamic', operation: 'zones.list', displayField: 'name' },
        },
      ],
      options: [{ ...deploy.options[0], default: { source: 'config' } }],
    }).success,
    true,
  );
});

test('command metadata rejects path segments that cannot form canonical routes', () => {
  for (const name of ['..', 'deploy#fragment', 'nested/path', 'déploy']) {
    assert.equal(
      commandMetadataSchema.safeParse({
        ...deploy,
        command: `cf ${name}`,
        name,
        fullPath: [name],
        usage: `cf ${name}`,
      }).success,
      false,
    );
  }
});

test('command metadata preserves source edge cases that remain valid', () => {
  assert.equal(
    commandMetadataSchema.safeParse({
      ...deploy,
      options: [
        {
          name: 'redistribute-static:wan',
          type: 'string',
          required: true,
          default: '',
          enum: ['', 'enabled'],
          description: 'Deployment mode.',
        },
        {
          name: 'redistribute-static:wan',
          type: 'string',
          required: true,
          description: 'A repeated producer option.',
        },
      ],
    }).success,
    true,
  );
});

test('command catalogs reject duplicate command identities', () => {
  assert.equal(
    commandCatalogSchema.safeParse({
      version: '1.0',
      generatedAt: 'build-time',
      commands: [deploy, deploy],
      descriptions: {},
    }).success,
    false,
  );
});

test('the command loader validates before replacing its store', async () => {
  let cleared = false;
  const loader = commandCatalogLoader(() => ({ ...cfCommandCatalog, version: '2.0' }));

  await assert.rejects(
    loader.load({
      generateDigest: () => 'digest',
      logger: { info() {} },
      parseData: async ({ data }: { data: unknown }) => data,
      store: {
        clear() {
          cleared = true;
        },
        set() {},
      },
    } as never),
  );
  assert.equal(cleared, false);
});

test('remote command sources reject unsuccessful responses', async () => {
  const source = remoteCommandCatalogSource('https://example.com/commands.json', async () =>
    Response.json({}, { status: 503, statusText: 'Unavailable' }),
  );
  await assert.rejects(source(), /503 Unavailable/);
});

test('remote command sources require HTTPS and bound response size', async () => {
  assert.throws(() => remoteCommandCatalogSource('http://example.com/commands.json'), /HTTPS/);
  assert.throws(
    () => remoteCommandCatalogSource('https://example.com/commands.json', fetch, { timeoutMs: 0 }),
    /positive safe integer/,
  );

  const source = remoteCommandCatalogSource(
    'https://example.com/commands.json',
    async () => new Response('{"catalog":"too large"}'),
    { maxResponseBytes: 4 },
  );
  await assert.rejects(source(), /exceeds 4 bytes/);
});

test('remote command sources report malformed JSON', async () => {
  const source = remoteCommandCatalogSource('https://example.com/commands.json', async () => new Response('not JSON'));
  await assert.rejects(source(), /not valid JSON/);
});
