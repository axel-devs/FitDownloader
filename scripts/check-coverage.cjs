const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function checkCoverage(report) {
  const entries = Object.entries(report).filter(([name]) => name !== 'total');
  for (const name of ['background.js', 'popup.js', 'options.js']) {
    const entry = entries.find(([file]) => path.basename(file) === name);
    assert.ok(entry, `Application coverage missing ${name}; an empty 100% report is invalid`);
    assert.ok(entry[1].lines.total > 0, `${name} has no measured source lines`);
  }
  assert.ok(entries.every(([file]) => !file.includes('node_modules') && !file.includes(`${path.sep}tests${path.sep}`)), 'Coverage contains non-application code');
  return true;
}
module.exports = { checkCoverage };
if (require.main === module) {
  checkCoverage(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../coverage/coverage-summary.json'), 'utf8')));
  console.log('Coverage contains all three application scripts; harness/dependency code excluded.');
}
