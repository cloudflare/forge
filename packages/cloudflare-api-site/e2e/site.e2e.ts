import { expect, test } from '@playwright/test';

const operation = '/api/zero-trust/devices/ip-profiles/methods/list/';

test.describe('routes', () => {
  const routes: [path: string, status: number, contentType: string][] = [
    ['/api/', 200, 'text/html'],
    ['/api/zero-trust/', 200, 'text/html'],
    ['/api/zero-trust/devices/ip-profiles/', 200, 'text/html'],
    [operation, 200, 'text/html'],
    [`${operation}?lang=typescript`, 200, 'text/html'],
    [`${operation}?lang=nope`, 404, 'text/plain'],
    ['/api/zero-trust/devices/ip-profiles/methods/list.md', 200, 'text/markdown'],
    ['/api/zero-trust/devices/ip-profiles/methods/list.md?lang=typescript', 200, 'text/markdown'],
    ['/api/llms.txt', 200, 'text/markdown'],
    ['/api/zero-trust/llms.txt', 200, 'text/markdown'],
    ['/api/tooling/', 200, 'text/html'],
    ['/api/.well-known/ard.json', 200, 'application/json'],
    ['/api/nope.txt', 404, 'text/html'],
  ];

  for (const [path, status, contentType] of routes) {
    test(`${path} responds ${status} ${contentType}`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(status);
      expect(response.headers()['content-type']).toContain(contentType);
    });
  }
});

test('overview renders with product navigation', async ({ page }) => {
  await page.goto('/api/');
  await expect(page).toHaveTitle('API Reference | Cloudflare API');
  await expect(page.locator('main h1')).toBeVisible();
  // Products are listed in the sidebar, collapsed by default.
  await expect(page.locator('a[href="/api/zero-trust/"]').first()).toBeAttached();
});

test('operation page renders the operation and its samples', async ({ page }) => {
  await page.goto(operation);
  await expect(page).toHaveTitle('List IP profiles | Cloudflare API');
  await expect(page.locator('h1')).toHaveText('List IP profiles');
  await expect(page.locator('.forge-verb')).toHaveText('GET');
  await expect(page.locator('.forge-sample-code code.language-bash').first()).toContainText(
    'https://api.cloudflare.com/client/v4/accounts/',
  );
});

test('execution target selector switches the code sample', async ({ page }) => {
  await page.goto(operation);
  const target = page.locator('select[data-forge-target]');
  await expect(target).toHaveValue('curl');
  await target.selectOption('typescript');
  await expect(page).toHaveURL(/[?&]lang=typescript\b/);
  await expect(page.locator('select[data-forge-target]')).toHaveValue('typescript');
  await expect(page.locator('.forge-sample-code code.language-bash')).toHaveCount(0);
});

test('operation links its agent Markdown', async ({ page, request }) => {
  await page.goto(operation);
  const href = await page.locator('link[rel="alternate"][type="text/markdown"]').getAttribute('href');
  expect(href).not.toBeNull();
  const response = await request.get(new URL(href!).pathname);
  expect(response.status()).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain('# List IP profiles');
  expect(markdown).toContain('- Path: `/accounts/{account_id}/devices/ip-profiles`');
});

test('llms.txt indexes the API', async ({ request }) => {
  const response = await request.get('/api/llms.txt');
  expect(await response.text()).toMatch(/^# Cloudflare API\n/);
});

test('unknown pages render the not-found page', async ({ page }) => {
  const response = await page.goto('/api/nope.txt');
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle('Page not found | Cloudflare API');
});
