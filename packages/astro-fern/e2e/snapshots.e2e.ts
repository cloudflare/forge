import { fixturePath } from './fixtures.ts';
import { expect, testFactory } from './test-utils.ts';

const CURRENT_OPERATION = '/api/widgets/sections/management/operations/widgets-read/';
const LEGACY_OPERATION = '/api/widgets/v1/sections/archive/operations/widgets-read/';
const snapshotsPath = (pathname: string) => fixturePath('snapshots', pathname);
const test = testFactory('./fixtures/snapshots/');

test('navigates between divergent snapshots of one semantic operation', async ({ page, getDevServer }) => {
  const site = await getDevServer();
  const response = await site.goto(snapshotsPath(CURRENT_OPERATION));
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { level: 1, name: 'Read current widget' })).toBeVisible();
  await expect(page.getByText('Snapshot: current')).toBeVisible();
  await expect(page.getByText('operation:7:widgets12:widgets_read')).toBeVisible();
  await expect(page.getByText('current_name', { exact: true })).toBeVisible();
  await expect(page.getByText('legacy_name', { exact: true })).not.toBeAttached();
  await expect(page.getByText('curl current /widgets/{widget_id}', { exact: true })).toBeVisible();

  await page.getByText('API version: Current').click();
  const legacyLink = page.getByRole('link', { name: 'Legacy', exact: true });
  await expect(legacyLink).toHaveAttribute('href', snapshotsPath(LEGACY_OPERATION));
  await legacyLink.click();

  await expect(page.getByRole('heading', { level: 1, name: 'Read legacy widget' })).toBeVisible();
  await expect(page.getByText('Snapshot: legacy')).toBeVisible();
  await expect(page.getByText('operation:7:widgets12:widgets_read')).toBeVisible();
  await expect(page.getByText('legacy_name', { exact: true })).toBeVisible();
  await expect(page.getByText('current_name', { exact: true })).not.toBeAttached();
  await expect(page.getByText('curl legacy /widgets/{widget_id}', { exact: true })).toBeVisible();
});

test('keeps historical-only operations and sparse products snapshot-scoped', async ({ request, getDevServer }) => {
  const site = await getDevServer();
  const removed = await request.get(
    site.resolveUrl(snapshotsPath('/api/widgets/v1/sections/archive/operations/widgets-remove/')),
  );
  expect(removed.status()).toBe(200);
  expect(await removed.text()).toContain('Remove legacy widget');

  const removedFromCurrent = await request.get(
    site.resolveUrl(snapshotsPath('/api/widgets/sections/archive/operations/widgets-remove/')),
  );
  expect(removedFromCurrent.status()).toBe(404);

  const retired = await request.get(
    site.resolveUrl(snapshotsPath('/api/retired/v1/sections/status/operations/retired-status/')),
  );
  expect(retired.status()).toBe(200);
  const retiredHtml = await retired.text();
  expect(retiredHtml).toContain('Read retired status');
  expect(retiredHtml).toContain('API version: Legacy');
  expect(retiredHtml).toContain('data-scope="snapshot"');
  expect(retiredHtml).not.toContain('data-scope="product"');

  const retiredFromCurrent = await request.get(
    site.resolveUrl(snapshotsPath('/api/retired/sections/status/operations/retired-status/')),
  );
  expect(retiredFromCurrent.status()).toBe(404);
});

test('serves snapshot-specific Markdown and valid sparse llms indexes', async ({ request, getDevServer }) => {
  const site = await getDevServer();
  const currentMarkdown = await request.get(site.resolveUrl(snapshotsPath(CURRENT_OPERATION.replace(/\/$/, '.md'))));
  expect(currentMarkdown.status()).toBe(200);
  expect(currentMarkdown.headers()['content-type']).toContain('text/markdown');
  const currentBody = await currentMarkdown.text();
  expect(currentBody).toContain('# Read current widget');
  expect(currentBody).toContain('curl current /widgets/{widget_id}');

  const legacyMarkdown = await request.get(site.resolveUrl(snapshotsPath(LEGACY_OPERATION.replace(/\/$/, '.md'))));
  expect(legacyMarkdown.status()).toBe(200);
  const legacyBody = await legacyMarkdown.text();
  expect(legacyBody).toContain('# Read legacy widget');
  expect(legacyBody).toContain('curl legacy /widgets/{widget_id}');

  const siteIndex = await request.get(site.resolveUrl(snapshotsPath('/llms.txt')));
  expect(siteIndex.status()).toBe(200);
  const siteBody = await siteIndex.text();
  expect(siteBody).toContain('[Widgets]');
  expect(siteBody).toContain('- Retired API:');
  expect(siteBody).not.toContain('[Retired API]');

  const retiredVersionIndex = await request.get(site.resolveUrl(snapshotsPath('/api/retired/v1/llms.txt')));
  expect(retiredVersionIndex.status()).toBe(200);
  expect(await retiredVersionIndex.text()).toContain('Read retired status');
});
