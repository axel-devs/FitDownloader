const { test } = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../manifest.json');
const { checkManifest } = require('../scripts/check-manifest.cjs');
test('production manifest and referenced assets are valid', () => assert.equal(checkManifest(manifest), true));
test('manifest check rejects missing assets', () => assert.throws(() => checkManifest(manifest, () => false), /asset/));
test('manifest check rejects broader production permissions', () => assert.throws(() => checkManifest({ ...manifest, host_permissions: ['<all_urls>'] }), /permissions/));
test('manifest check rejects a mismatched version', () => assert.throws(() => checkManifest({ ...manifest, version: '9.9.9' }), /versions/));
