const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.resolve(__dirname, '../node_modules/.cache/ms-playwright') }
});
process.exitCode = result.status ?? 1;
