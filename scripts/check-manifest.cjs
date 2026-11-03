const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function checkManifest(manifest, exists = file => fs.existsSync(path.join(root, file))) {
  assert.equal(manifest.manifest_version, 3, 'Only MV3 is supported');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(\.\d+)?$/);
  assert.equal(manifest.version, require('../package.json').version, 'Package/manifest versions differ');
  assert.deepEqual([...manifest.host_permissions].sort(), [
    'https://fitgirl-repacks.site/*', 'https://fuckingfast.co/*', 'https://dl.fuckingfast.co/*'
  ].sort(), 'Production host permissions changed; review explicitly');
  assert.deepEqual([...manifest.permissions].sort(), ['scripting', 'tabs', 'activeTab', 'downloads', 'storage'].sort());
  for (const file of [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
    assert.ok(typeof file === 'string' && !file.includes('..') && exists(file), `Missing/unsafe manifest asset: ${file}`);
  }
  return true;
}
module.exports = { checkManifest };
if (require.main === module) {
  checkManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
  console.log('Manifest, versions, assets and production permissions validated.');
}
