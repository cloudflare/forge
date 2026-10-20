import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.VISUAL_BASE_URL ?? 'http://localhost:8788';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  outputDir: 'e2e/__test-results__',
  snapshotPathTemplate: 'e2e/__snapshots__/{arg}{ext}',
  projects: [
    { name: 'e2e', testMatch: 'site.e2e.ts', use: { ...devices['Desktop Chrome'], headless: true } },
    { name: 'visual', testMatch: 'visual.e2e.ts', use: { ...devices['Desktop Chrome'], headless: true } },
  ],
  testDir: 'e2e',
  timeout: 120_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled' } },
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: process.env.VISUAL_BASE_URL
    ? undefined
    : { command: 'astro preview --port 8788', url: `${baseURL}/api/`, reuseExistingServer: true, timeout: 120_000 },
});
