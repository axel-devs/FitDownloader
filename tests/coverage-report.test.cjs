const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkCoverage } = require('../scripts/check-coverage.cjs');
function report() {
  return Object.fromEntries(['background.js', 'popup.js', 'options.js'].map(name => [path.resolve(name), { lines: { total: 10, pct: 0 } }]));
}
test('coverage accepts named application files even when some have zero coverage', () => {
  assert.equal(checkCoverage(report()), true);
});
test('an empty 100% coverage report is rejected', () => {
  assert.throws(() => checkCoverage({ total: { lines: { pct: 100 } } }), /missing/);
});
test('omitting the unexecuted options script cannot produce a valid coverage report', () => {
  const value = report(); delete value[path.resolve('options.js')];
  assert.throws(() => checkCoverage(value), /options.js/);
});
test('files with no measured lines cannot satisfy coverage accounting', () => {
  const value = report(); value[path.resolve('options.js')].lines.total = 0;
  assert.throws(() => checkCoverage(value), /no measured source/);
});
test('test harness code cannot be included in the application coverage denominator', () => {
  const value = report(); value[path.resolve('tests/helper.cjs')] = { lines: { total: 100 } };
  assert.throws(() => checkCoverage(value), /non-application/);
});
