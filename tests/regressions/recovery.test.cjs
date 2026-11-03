// Intentionally failing desired-behavior specifications for the next recovery
// changes. Run explicitly with npm run test:regressions. No skips or TODO masks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick } = require('../helpers/background.cjs');

test('REL-01: closing the source tab preserves ownership of the active batch', async () => {
  const h = harness(); h.seed(3);
  await h.run('pumpQueueForTab(1)'); await tick();
  await h.emit('removed', 1);
  assert.equal(h.run('Object.values(sessions).filter(s => s.hasStarted).length'), 1);
  assert.equal(h.run('downloadIdToKey.size'), 2);
});

test('REL-03: orphaned starting work is requeued after worker recreation', async () => {
  const h = harness(); h.seed(1);
  h.run('sessions[1].items[0].state="starting"');
  await h.context.reconcileSessionForTab(1);
  assert.equal(h.run('sessions[1].items[0].state'), 'queued');
});

test('REL-04: reopening a failed batch retains its result and retry view', async () => {
  const h = harness(); h.seed(1);
  h.run('sessions[1].items[0].state="error"');
  const result = await h.message({ type: 'scan_current_tab' });
  assert.equal(result.session.hasStarted, true);
  assert.equal(result.session.items[0].state, 'error');
});

test('REL-02: worker recreation followed by an explicit scan restarts eligible queued work', async () => {
  const first = harness(); first.seed(1);
  await first.context.saveSessions();
  const recreated = harness({ local: first.state.local });
  await recreated.message({ type: 'scan_current_tab' }); await tick();
  assert.equal(recreated.downloads.length, 1);
});
