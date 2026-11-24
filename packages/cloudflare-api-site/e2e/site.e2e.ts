import { expect, test } from '@playwright/test';

const operation = '/api/zero-trust/devices/ip-profiles/methods/list/';

test.describe('routes', () => {
  const routes: [path: string, status: number, contentType: string, location?: string][] = [
    ['/api/', 200, 'text/html'],
    ['/api/zero-trust/', 200, 'text/html'],
    ['/api/zero-trust/devices/ip-profiles/', 200, 'text/html'],
    ['/api/zero-trust/devices/ip-profiles/?version=2026-11-30.air', 200, 'text/html'],
    ['/api/tags/zero-trust/', 404, 'text/html'],
    ['/api/tagging/', 200, 'text/html'],
    [operation, 200, 'text/html'],
    [`${operation}?lang=terraform`, 200, 'text/html'],
    [`${operation}?lang=python`, 200, 'text/html'],
    [`${operation}?lang=nope`, 200, 'text/html'],
    [`${operation}?version=2026-11-30.air`, 200, 'text/html'],
    [`${operation}?version=nope`, 404, 'text/html'],
    [
      '/api/zero-trust/devices/ip-profiles/methods/list.md',
      301,
      '',
      '/api/zero-trust/devices/ip-profiles/methods/list/index.md',
    ],
    ['/api/zero-trust/devices/ip-profiles/methods/list/index.md', 200, 'text/markdown'],
    ['/api/index.md', 200, 'text/markdown'],
    ['/api.md', 301, '', '/api/index.md'],
    ['/api/o11y/agents/traces/methods/list/', 302, '', '/api/observability/agents/traces/methods/list/'],
    ['/api/hyperdrive/integration/planetscale/', 302, '', '/api/hyperdrive/'],
    ['/api/tags/', 302, '', '/api/tagging/'],
    ['/api/tags/keys/methods/list/', 302, '', '/api/tagging/keys/methods/list/'],
    // The retired Stainless site, redirected by the middleware.
    ['/api/resources/zones/', 301, '', '/api/zones/'],
    ['/api/resources/zones/?a=1', 301, '', '/api/zones/?a=1'],
    ['/api/operations/zones-get/', 301, '', '/api/zones/methods/list/'],
    ['/api/python/resources/zones/', 301, '', '/api/zones/?lang=python'],
    ['/api/node/resources/zones/methods/list/', 301, '', '/api/zones/methods/list/?lang=typescript'],
    ['/api/resources/zones/methods/list/index.md', 301, '', '/api/zones/methods/list/index.md'],
    ['/api/terraform/resources/zones/methods/list/', 301, '', '/api/zones/methods/list/?lang=terraform'],
    ['/api/resources/nope/', 404, 'text/html'],
    ['/api/llms.txt', 200, 'text/plain'],
    ['/api/zero-trust/llms.txt', 200, 'text/plain'],
    ['/api/tooling/', 200, 'text/html'],
    ['/api/d1/tooling/migrations/list/', 200, 'text/html'],
    ['/api/.well-known/ard.json', 200, 'application/json'],
    ['/api/nope.txt', 404, 'text/html'],
  ];

  for (const [path, status, contentType, location] of routes) {
    test(`${path} responds ${status}${location ? ` → ${location}` : ` ${contentType}`}`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(status);
      if (location)
        expect(
          new URL(response.headers()['location']!, 'http://x').pathname +
            new URL(response.headers()['location']!, 'http://x').search,
        ).toBe(location);
      else expect(response.headers()['content-type']).toContain(contentType);
    });
  }
});

test("home keeps its title, description and the sidebar's top entries", async ({ page }) => {
  await page.goto('/api/');
  await expect(page).toHaveTitle('API Reference | Cloudflare API');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'API reference generated from the Cloudflare OpenAPI spec by Forge.',
  );
  const header = page.locator('main [data-slot="page-header"]');
  await expect(header.locator('h1')).toHaveText('API Reference');
  await expect(header.locator('[data-slot="page-description"]')).toHaveText(
    'API reference generated from the Cloudflare OpenAPI spec by Forge.',
  );
  await expect(header).not.toContainText('Welcome to Cloudflare');
  await expect(page.locator('main')).toContainText("Welcome to Cloudflare's API documentation site");
  const nav = page.locator('[data-nb-api-nav]');
  await expect(nav.locator('> ul > li').first().locator('a[href="/api/"]')).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('> ul > li').nth(1).locator('> details > summary')).toHaveText('Developer Tooling');
  await expect(nav.locator('a[href="/api/tooling/"]').first()).toBeAttached();
  await expect(nav.locator('a[href="/api/zero-trust/"]').first()).toBeAttached();
});

test('a product with commands lists its Developer Tooling group', async ({ page }) => {
  await page.goto('/api/d1/');
  const group = page
    .locator('details[data-nb-nav-group="tags.d1"] > ul > li > details')
    .filter({ has: page.locator('summary', { hasText: 'Developer Tooling' }) });
  await expect(group.locator('a[href^="/api/d1/tooling/"]').first()).toBeAttached();
});

test('operation page renders the operation, its samples, its response example and the version', async ({ page }) => {
  await page.goto(operation);
  await expect(page).toHaveTitle('List IP profiles | Cloudflare API');
  await expect(page.locator('h1')).toHaveText('List IP profiles');
  await expect(page.locator('main nav[aria-label="Breadcrumb"] a').first()).toHaveText('API Reference');
  await expect(page.locator('[data-nb-api-coderail]')).toContainText('https://api.cloudflare.com/client/v4/accounts/');
  await expect(page.locator('[data-nb-api-coderail] [data-nb-choice-kind="curl"]').first()).toBeAttached();
  await expect(page.locator('[data-nb-api-coderail] [data-nb-choice-kind="cf"]').first()).toBeVisible();
  await expect(page.locator('[data-nb-api-coderail] [data-nb-choice-kind="cf"]').first()).toContainText(
    'cf zero-trust devices ip-profiles list',
  );
  await expect(page.locator('[data-nb-api-coderail]')).toContainText('Response example');
  await expect(page.locator('header [data-slot="version-switcher"]')).toContainText('2026-11-30 (Air)');
  const groupRow = page.locator('[data-nb-api-nav] details > summary').first();
  expect(await groupRow.evaluate((el) => getComputedStyle(el).listStyleType)).toBe('none');
});

test('code sample picker defaults to the cf CLI and switches samples', async ({ page }) => {
  await page.goto(operation);
  const picker = page.locator('[data-nb-api-coderail] select[data-nb-choice-select]').first();
  await expect(picker).toHaveValue('cf');
  await expect(picker.locator('option')).toHaveText(['cf CLI', 'curl', 'TypeScript', 'Python', 'Go', 'Terraform']);
  await picker.selectOption('curl');
  await expect(page).toHaveURL(/[?&]lang=curl\b/);
  await expect(page.locator('[data-nb-api-coderail] [data-nb-choice-kind="curl"]').first()).toBeVisible();
});

test('operation links its agent Markdown, which carries the cURL sample', async ({ page, request }) => {
  await page.goto(operation);
  const href = await page.locator('link[rel="alternate"][type="text/markdown"]').getAttribute('href');
  expect(href).not.toBeNull();
  const response = await request.get(new URL(href!).pathname);
  expect(response.status()).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain('title: "List IP profiles"');
  expect(markdown.split('\n---\n')[0]).not.toContain('description:');
  expect(markdown).toContain('Lists WARP Device IP profiles.');
  expect(markdown).toContain('```bash');
  expect(markdown).toContain('/accounts/{account_id}/devices/ip-profiles');
});

test('the SDK samples are the retired Stainless snippets, selected by ?lang=', async ({ page }) => {
  await page.goto('/api/zones/methods/list/?lang=python');
  const sample = page.locator('[data-nb-choice-panel]:visible');
  await expect(sample).toContainText('client.zones.list()');
  await page.locator('[data-nb-choice-select]').selectOption('typescript');
  await expect(page).toHaveURL(/\/list\/\?lang=typescript$/);
  await expect(sample).toContainText('client.zones.list()');
  await expect(sample).toContainText("import Cloudflare from 'cloudflare'");
  await page.locator('[data-nb-choice-select]').selectOption('go');
  await expect(sample).toContainText('client.Zones.List(');
});

test('the Terraform view shows the declarations in place of the HTTP reference', async ({ page, request }) => {
  await page.goto('/api/dns/records/methods/create/');
  await expect(page.locator('[data-api-terraform]')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
  await page.locator('[data-nb-choice-select]').selectOption('terraform');
  await expect(page).toHaveURL(/\/create\/\?lang=terraform$/);
  await expect(page.locator('[data-api-terraform] h3').first()).toContainText('cloudflare_dns_record');
  await expect(page.getByRole('heading', { name: 'Authorization' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Returns' })).toHaveCount(0);
  const markdown = await (await request.get('/api/dns/records/methods/create/index.md')).text();
  expect(markdown).toContain('```terraform');
});

test('the Terraform view follows links, and another sample leaves it', async ({ page }) => {
  await page.goto('/api/dns/records/methods/create/?lang=terraform');
  await page
    .locator('[data-nb-api-nav]:visible')
    .getByRole('link', { name: 'DNS Record Details', exact: true })
    .click();
  await expect(page).toHaveURL(/\/get\/\?lang=terraform$/);
  await expect(page.locator('[data-api-terraform] .forge-terraform-declaration')).toHaveCount(2);
  await page.locator('[data-nb-choice-select]').selectOption('curl');
  await expect(page).toHaveURL(/\/get\/\?lang=curl$/);
  await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
  await expect(page.locator('[data-api-terraform]')).toBeHidden();
  // Terraform is never the saved sample: a plain URL opens the HTTP reference.
  await page.goto('/api/dns/records/methods/create/');
  await expect(page.locator('[data-api-terraform]')).toBeHidden();
});

test('a link to a Terraform heading lands on it', async ({ page }) => {
  await page.goto('/api/dns/records/methods/create/?lang=terraform#terraform-1');
  await expect(page.locator('#terraform-1')).toBeInViewport();
});

test('a resource page lists its endpoints, then its child resources', async ({ page }) => {
  await page.goto('/api/zero-trust/devices/');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Devices API resources and endpoints.',
  );
  const headings = page.locator('main h2');
  await expect(headings.nth(0)).toHaveText(/^Endpoints\s*4 endpoints$/);
  await expect(headings.nth(1)).toHaveText('Resources');
  await expect(page.locator('main a[href="/api/zero-trust/devices/ip-profiles/"]')).toHaveText('IP Profiles');
});

test('a resource marks its deprecated endpoints', async ({ page }) => {
  await page.goto('/api/accounts/roles/');
  const row = page.locator('main [data-slot="api-operation-list"] li').first();
  await expect(row).toContainText('List Roles');
  await expect(row.getByText('Deprecated', { exact: true })).toBeVisible();
});

test('a resource lists its endpoints in lifecycle order, on the page and in the sidebar', async ({ page }) => {
  await page.goto('/api/zero-trust/devices/ip-profiles/');
  const lifecycle = [
    'List IP profiles',
    'Get IP profile',
    'Create IP profile',
    'Update IP profile',
    'Delete IP profile',
  ];
  await expect(page.locator('main [data-slot="api-operation-name"]')).toHaveText(lifecycle);
  await expect(page.locator('[data-nb-api-nav] a[href^="/api/zero-trust/devices/ip-profiles/methods/"]')).toHaveText(
    lifecycle,
  );
});

test('a request body opens a nested union down to its record types', async ({ page }) => {
  await page.goto('/api/dns/records/methods/create/');
  const body = page.locator('main section[data-api-section]', { hasText: 'Request body' }).first();
  const groups = body.locator('.fl-list').first().locator('> li');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator('.fl-count-text').first()).toHaveText('8 variants');
  const records = groups.first().locator('.fl-children--union').first();
  await expect(records.locator('.fl-union-label').first()).toHaveText('One of the following:');
  const record = records.locator('.fl-list').first().locator('> li').first();
  await expect(record.locator('.fl-name').first()).toHaveText('A Record');
  await expect(record.locator('.fl-count-text').first()).toHaveText('9 properties');
});

test('an empty object body still shows its Request body section', async ({ page }) => {
  await page.goto('/api/cloudforce-one/threat-signals/articles/skills/methods/run/');
  const body = page.locator('main section[data-api-section]', { hasText: 'Request body' }).first();
  await expect(body).toContainText('No documented fields.');
});

test('command pages keep their URLs with the command sidebar', async ({ page }) => {
  await page.goto('/api/d1/tooling/migrations/list/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('a[href="/api/tooling/"]').first()).toBeAttached();
});

test('command pages have a Markdown version, listed in llms.txt', async ({ page, request }) => {
  await page.goto('/api/d1/tooling/migrations/list/');
  await expect(page.getByRole('link', { name: 'View as Markdown' })).toHaveAttribute(
    'href',
    '/api/d1/tooling/migrations/list/index.md',
  );
  const markdown = await request.get('/api/d1/tooling/migrations/list/index.md');
  expect(markdown.headers()['content-type']).toContain('text/markdown');
  const body = await markdown.text();
  expect(body).toContain('# List');
  expect(body).toContain('cf d1 migrations list');
  const llms = await (await request.get('/api/llms.txt')).text();
  expect(llms).toContain('## Developer tooling');
  expect(llms).toContain('/api/d1/tooling/migrations/list/index.md');
});

test('the sidebar filter finds cf commands beside API pages', async ({ page }) => {
  await page.goto('/api/tooling/');
  await page.getByPlaceholder('Filter sidebar').first().fill('migrations list');
  const results = page.locator('[data-nb-nav-results] a');
  await expect(results.filter({ hasText: 'cf d1 migrations list' })).toHaveAttribute(
    'href',
    '/api/d1/tooling/migrations/list/',
  );
});

test('sidebar filter results look like tree rows and open at the top', async ({ page }) => {
  await page.goto('/api/dns/records/methods/create/');
  const row = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((a) => {
        const s = getComputedStyle(a);
        return [s.fontSize, s.fontWeight, s.color, s.paddingLeft, s.minHeight].join(' ');
      });
  const treeRow = await row('[data-nb-api-nav] li > a:not([aria-current])');
  const scroller = page.locator('[data-nb-api-tree]');
  await scroller.evaluate((el) => (el.scrollTop = 1500));

  await page.locator('[data-nb-sidebar-filter-input]').fill('dns record');
  const status = page.locator('[data-nb-nav-status]');
  await expect(status).toHaveText(/^\d+ pages$/);
  expect(await row('[data-nb-nav-results] li > a')).toBe(treeRow);
  // The status line sits below the sticky filter bar, not under it.
  const barBottom = await page.locator('.sb-filter-bar').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(await status.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(barBottom - 1);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-nb-api-nav]')).toBeVisible();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(1500);
});

test('the phone menu lists the header links the header has no room for', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/api/dns/records/methods/get/');
  await expect(page.locator('.site-header nav')).toBeHidden();
  await page.locator('[data-menu-btn]').click();
  await expect(page.locator('dialog[open] .site-links a')).toHaveText(['Directory', 'API', 'SDKs', 'Changelog']);
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
