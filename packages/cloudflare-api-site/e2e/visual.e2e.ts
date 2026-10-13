import { expect, test } from '@playwright/test';

const pages = {
  overview: '/api/',
  product: '/api/zero-trust/',
  resource: '/api/zero-trust/devices/ip-profiles/',
  operation: '/api/zero-trust/devices/ip-profiles/methods/list/',
  'operation-typescript': '/api/zero-trust/devices/ip-profiles/methods/list/?lang=typescript',
  tooling: '/api/tooling/',
  'not-found': '/api/nope.txt',
};

const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const descriptions = [
  '.api-overview',
  '.forge-operation-desc',
  '.forge-request-body-description',
  '.forge-desc',
  '.forge-enum-description',
  '.forge-response-description',
  '.forge-response-example-description',
].join(', ');

for (const [name, path] of Object.entries(pages)) {
  for (const [viewport, size] of Object.entries(viewports)) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`${name} ${viewport} ${colorScheme}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}-${viewport}-${colorScheme}.png`, {
          fullPage: true,
          mask: [page.locator(descriptions)],
        });
      });
    }
  }
}
