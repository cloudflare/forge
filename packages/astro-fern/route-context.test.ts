import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineFernManifest } from './manifest.ts';
import { defineFernProject } from './project.ts';
import { buildSnapshotSwitch } from './route-context.ts';
import { composeFernRoutePlan, type FernRoutePlan } from './route-plan.ts';
import { resolveRuntimeConfig, type FernTargetRouting } from './runtime-config.ts';
import { widgetsProduct, widgetsSpec } from './test-fixture.ts';

/** A single-product, multi-snapshot project (default = v2) over the shared widgets fixture. */
function snapshotProject(target: FernTargetRouting = 'hash'): FernRoutePlan {
  const content = defineFernProject({
    source: {
      kind: 'snapshots',
      snapshots: [
        { id: 'v1', source: widgetsSpec },
        { id: 'v2', source: widgetsSpec, default: true },
        { id: 'v3', source: widgetsSpec },
      ],
    },
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [
        { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
        { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
      ],
    }),
  }).getData();
  return composeFernRoutePlan(content.catalog, resolveRuntimeConfig({ routing: { target } }));
}

function pageForSnapshot(data: FernRoutePlan, snapshotId: string) {
  const page = data.catalog.products[0]?.snapshots.find((snapshot) => snapshot.id === snapshotId)?.pages[0];
  assert.ok(page);
  return page;
}

test('resolves product, snapshot and operation for a default-snapshot page', () => {
  const data = snapshotProject();
  const page = pageForSnapshot(data, 'v2');
  const context = buildSnapshotSwitch(data, page.pathname);
  assert.equal(context.product, 'widgets');
  assert.equal(context.snapshot, 'v2');
  assert.equal(context.operationId, page.operationId);
});

test('lists one switcher option per snapshot, flagging current and default', () => {
  const data = snapshotProject();
  const page = pageForSnapshot(data, 'v2');
  const context = buildSnapshotSwitch(data, page.pathname);

  assert.deepEqual(
    context.snapshots.map((option) => option.id),
    ['v1', 'v2', 'v3'],
  );
  const current = context.snapshots.find((option) => option.current);
  assert.equal(current?.id, 'v2');
  assert.ok(current?.default);
  assert.equal(context.snapshots.filter((option) => option.default).length, 1);
});

test('each option href points at the same operation in that snapshot', () => {
  const data = snapshotProject();
  const page = pageForSnapshot(data, 'v2');
  const context = buildSnapshotSwitch(data, page.pathname);

  for (const option of context.snapshots) {
    const sibling = data.catalog.products[0]?.snapshots
      .find((snapshot) => snapshot.id === option.id)
      ?.pages.find((candidate) => candidate.operationId === context.operationId);
    assert.equal(option.href, sibling?.pathname);
  }
  // The non-default snapshots are URL-prefixed; the default is served unprefixed.
  assert.ok(context.snapshots.find((option) => option.id === 'v1')?.href.includes('/widgets/v1/'));
  assert.ok(!context.snapshots.find((option) => option.id === 'v2')?.href.includes('/v2/'));
});

test('page IDs are opaque to snapshot routing', () => {
  const data = structuredClone(snapshotProject('path'));
  const replacements = new Map<string, string>();
  let nextId = 0;
  for (const product of data.catalog.products) {
    for (const snapshot of product.snapshots) {
      for (const page of snapshot.pages) {
        const replacement = `opaque-page-${nextId++}`;
        replacements.set(page.id, replacement);
        page.id = replacement;
      }
    }
  }
  for (const route of data.humanRoutes) {
    const replacement = replacements.get(route.pageId);
    assert.ok(replacement);
    route.pageId = replacement;
  }
  const current = pageForSnapshot(data, 'v2');
  const context = buildSnapshotSwitch(data, current.pathname);

  assert.equal(context.operationId, current.operationId);
  assert.equal(context.snapshots.length, 3);
});

test('resolves from a non-default-snapshot pathname too', () => {
  const data = snapshotProject();
  const page = pageForSnapshot(data, 'v3');
  const context = buildSnapshotSwitch(data, page.pathname);
  assert.equal(context.snapshot, 'v3');
  assert.equal(context.snapshots.find((option) => option.current)?.id, 'v3');
});

test('preserves the execution target when switching from a target route', () => {
  const data = snapshotProject('path');
  const targetRoute = data.humanRoutes.find((route) => route.target === 'python');
  assert.ok(targetRoute);
  const context = buildSnapshotSwitch(data, targetRoute.pathname);

  assert.equal(context.snapshots.length, 3);
  for (const option of context.snapshots) {
    // Path target routing addresses a variant as `{prefix}/{target}/{tail}`, so a
    // target-preserving switch keeps the `/python/` segment in every snapshot's href.
    assert.ok(option.href.includes('/python/'), `expected target-preserving href, got ${option.href}`);
  }
  // And the switch stays on the target route, not the canonical page.
  assert.ok(context.snapshots.find((option) => option.id === 'v1')?.href.includes('/widgets/v1/python/'));
});

test('exposes the current target on a per-target route and omits it on the canonical page', () => {
  const data = snapshotProject('path');
  const targetRoute = data.humanRoutes.find((route) => route.target === 'python');
  assert.ok(targetRoute);
  assert.equal(buildSnapshotSwitch(data, targetRoute.pathname).target, 'python');

  // The canonical (target-less) route for the same page carries no target.
  const canonical = data.humanRoutes.find((route) => route.pageId === targetRoute.pageId && !route.target);
  assert.ok(canonical);
  assert.equal(buildSnapshotSwitch(data, canonical.pathname).target, undefined);
});

test('matches regardless of a trailing slash on the incoming pathname', () => {
  const data = snapshotProject();
  const page = pageForSnapshot(data, 'v2');
  const withoutSlash = page.pathname.replace(/\/$/, '');
  assert.deepEqual(buildSnapshotSwitch(data, withoutSlash), buildSnapshotSwitch(data, page.pathname));
});

test('returns an empty context for an unknown pathname', () => {
  const data = snapshotProject();
  assert.deepEqual(buildSnapshotSwitch(data, '/api/widgets/does-not-exist/'), { snapshots: [] });
});

test('a single configured snapshot yields one switcher option', () => {
  const content = defineFernProject({
    source: widgetsSpec,
    manifest: defineFernManifest({
      products: [widgetsProduct],
      targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
    }),
  }).getData();
  const data = composeFernRoutePlan(content.catalog, resolveRuntimeConfig({}));
  const page = pageForSnapshot(data, 'current');
  const context = buildSnapshotSwitch(data, page.pathname);
  assert.equal(context.snapshots.length, 1);
  assert.ok(context.snapshots[0]?.current);
});
