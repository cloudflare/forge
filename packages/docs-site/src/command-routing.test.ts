import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { assertToolingRouteNamespace, CommandRouter, commandTitle } from './command-reference/routing.ts';

const router = new CommandRouter(cfCommandCatalog, { base: '/api' });

test('command routes resolve under the API tooling namespace', () => {
  assert.equal(router.resolve(new URL('https://example.com/api/tooling/deploy/'))?.command, 'cf deploy');
  assert.equal(router.resolve('/api/tooling/dev')?.command, 'cf dev');
});

test('command routes reject the directory, unknown commands, and API operation paths', () => {
  assert.equal(router.resolve('/api/tooling/'), undefined);
  assert.equal(router.resolve('/api/tooling/missing/'), undefined);
  assert.equal(router.resolve('/api/workers/tooling/deploy/'), undefined);
  assert.equal(router.resolve('/api/tooling/%64eploy/'), undefined);
  assert.equal(router.resolve('/api/commands/deploy/'), undefined);
});

test('command hrefs derive from the configured base', () => {
  assert.equal(router.commandHref({ fullPath: ['context', 'set-value'] }), '/api/tooling/context/set-value/');

  const nestedBase = new CommandRouter(cfCommandCatalog, { base: '/docs/api/' });
  const deploy = nestedBase.commands.find((command) => command.command === 'cf deploy');
  assert.ok(deploy);
  assert.equal(nestedBase.directoryHref, '/docs/api/tooling/');
  assert.equal(nestedBase.commandHref(deploy), '/docs/api/tooling/deploy/');
  assert.equal(nestedBase.resolve('/docs/api/tooling/deploy/')?.command, 'cf deploy');
  assert.equal(nestedBase.resolve('/api/tooling/deploy/'), undefined);
});

test('product commands use product tooling routes', () => {
  const d1 = { id: 'd1', slug: 'd1' };
  const apply = router.commands.find((command) => command.command === 'cf d1 migrations apply');
  assert.ok(apply);
  assert.equal(router.commandHref(apply, d1), '/api/d1/tooling/migrations/apply/');
  assert.equal(router.resolve('/api/d1/tooling/migrations/apply/', [d1]), apply);
  assert.equal(router.resolve('/api/tooling/d1/migrations/apply/', [d1]), undefined);
});

test('command titles humanize kebab and snake case names', () => {
  assert.equal(commandTitle({ name: 'agent-context' }), 'Agent Context');
  assert.equal(commandTitle({ name: 'who_am_i' }), 'Who Am I');
});

test('commands are associated with products by exact visible namespace', () => {
  assert.deepEqual(
    router.commandsForProduct('d1').map((command) => command.command),
    ['cf d1 migrations apply', 'cf d1 migrations create', 'cf d1 migrations list'],
  );
  assert.deepEqual(
    router.commandsForProduct('workers').map((command) => command.command),
    ['cf workers triggers deploy'],
  );
  assert.deepEqual(router.commandsForProduct('builds'), []);
});

test('hidden commands cannot be resolved', () => {
  const hidden = new CommandRouter(
    {
      ...cfCommandCatalog,
      commands: [{ ...cfCommandCatalog.commands[0], hideCommand: true }],
    },
    { base: '/api' },
  );
  assert.equal(hidden.commands.length, 0);
  assert.equal(hidden.resolve('/api/tooling/deploy/'), undefined);
});

test('the tooling namespace rejects a colliding API product', () => {
  assert.throws(() => assertToolingRouteNamespace([{ id: 'tooling', slug: 'tooling' }], '/api', '/api'), /conflicts/);
  assert.throws(() => assertToolingRouteNamespace([{ id: 'Tools', slug: 'tooling' }], '/api', '/api'), /conflicts/);
  assert.throws(
    () =>
      assertToolingRouteNamespace(
        [
          {
            id: 'workers',
            slug: 'workers',
            snapshots: [{ pages: [{ pathname: '/api/workers/tooling/methods/list/' }] }],
          },
        ],
        '/api',
        '/api',
      ),
    /conflicts/,
  );
  assert.doesNotThrow(() => assertToolingRouteNamespace([{ id: 'tooling', slug: 'tooling' }], '/api', '/docs/api'));
  assert.doesNotThrow(() => assertToolingRouteNamespace([{ id: 'workers', slug: 'workers' }], '/api', '/api'));
});
