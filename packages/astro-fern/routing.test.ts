import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHumanStaticPaths, getLlmsStaticPaths, getMarkdownStaticPaths } from './routing.ts';
import { fixtureProject } from './test-fixture.ts';

test('hash routing emits one human page with target hash links', () => {
  const data = fixtureProject('hash').getData();
  assert.equal(data.humanRoutes.length, 1);
  assert.equal(data.pages[0]?.targets.find((target) => target.id === 'python')?.href.endsWith('#python'), true);
  assert.deepEqual(getHumanStaticPaths(data)[0]?.params, {
    slug: 'widgets/sections/management/operations/widgets-update',
  });
});

test('path routing emits aggregate and target-specific human pages', () => {
  const data = fixtureProject('path').getData();
  assert.equal(data.humanRoutes.length, 3);
  assert.ok(data.humanRoutes.some((route) => route.pathname.includes('/python/')));
});

test('agent static paths include aggregate, target, product and target indexes', () => {
  const data = fixtureProject().getData();
  assert.equal(getMarkdownStaticPaths(data).length, 3);
  assert.ok(getLlmsStaticPaths(data).some((path) => path.params.scope === 'widgets'));
  assert.ok(getLlmsStaticPaths(data).some((path) => path.params.scope === 'widgets/targets/python'));
});
