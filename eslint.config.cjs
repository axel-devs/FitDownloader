const browser = ['chrome', 'document', 'window', 'console', 'setTimeout', 'clearTimeout', 'URL', 'AbortSignal', 'fetch'];
const node = ['require', 'module', 'exports', '__dirname', 'process', 'console', 'Buffer', 'URL', 'AbortSignal', 'AbortController', 'Headers', 'setImmediate', 'setTimeout', 'clearTimeout', 'structuredClone'];
const globals = names => Object.fromEntries(names.map(name => [name, 'readonly']));
module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
  { files: ['**/*.js', '**/*.cjs'], languageOptions: { ecmaVersion: 'latest' }, rules: {
    'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-args': 'error',
    'no-dupe-keys': 'error', 'no-unsafe-optional-chaining': 'error', 'valid-typeof': 'error'
  } },
  { files: ['background.js', 'popup.js', 'options.js'], languageOptions: { globals: globals(browser) } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals([...node, ...browser]) } },
  { files: ['tests/browser/*.cjs'], languageOptions: { globals: {
    extractFuckingFastLinks: 'readonly', createSessionFromExtractedLinks: 'readonly', reconcileSessionForTab: 'readonly', loadSessions: 'readonly', getCurrentSettings: 'readonly',
    sessionsLoaded: 'writable', downloadMapLoaded: 'writable', sessions: 'writable'
  } } }
];
