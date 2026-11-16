import { defineConfig } from '@playwright/test';

// BASE_URL: http://localhost:5173 (local stack, see local-stack.sh) or https://ackwell.joemarkgimeno.com.
// QA_EMAIL / QA_PASSWORD: an existing Ackwell user (sign-up is disabled, the user must exist).
export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
