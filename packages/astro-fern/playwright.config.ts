import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  outputDir: 'e2e/__test-results__',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
      },
    },
  ],
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 40_000,
  use: { trace: 'retain-on-failure' },
});
