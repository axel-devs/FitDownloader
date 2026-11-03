const path = require('node:path');
const { defineConfig } = require('@playwright/test');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(__dirname, 'node_modules/.cache/ms-playwright');
module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' }
});
