const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pageHarness } = require('./helpers/page.cjs');
function session(states = ['queued', 'queued'], extra = {}) {
  return { hasStarted: false, paused: false, items: states.map((state, i) => ({
    url: `https://fuckingfast.co/file${i}`, label: `Archive part ${i + 1}`, state
  })), ...extra };
}
function setup(t, value = session()) {
  const h = pageHarness(); t.after(h.close);
  h.state.session = value; h.start(); return h;
}

test('popup initializes settings and displays scanned files', t => {
  const h = setup(t);
  assert.equal(h.document.querySelectorAll('.file-row').length, 2);
  assert.equal(h.el('parallel-input').value, '5');
  assert.equal(h.el('select-all').checked, true);
  assert.equal(h.el('start-button').disabled, false);
  assert.match(h.el('selection-info').textContent, /2 of 2/);
});

test('untrusted filename labels are rendered as text, never injected HTML', t => {
  const value = session(); value.items[0].label = '<img src=x onerror="alert(1)">';
  const h = setup(t, value);
  assert.equal(h.el('files-list').querySelectorAll('img').length, 0);
  assert.match(h.el('files-list').textContent, /<img/);
});

test('empty scan disables Start and hides selection controls', t => {
  const h = setup(t, session([]));
  assert.equal(h.el('start-button').disabled, true);
  assert.equal(h.el('select-all-row').hidden, true);
  assert.match(h.el('status').textContent, /No FuckingFast/);
});

for (const state of ['starting', 'downloading', 'paused', 'completed', 'error', 'cancelled']) {
  test(`status view renders ${state}`, t => {
    const h = setup(t, session([state], { hasStarted: true }));
    assert.equal(h.document.querySelector('.file-status').textContent, state);
    assert.equal(h.el('select-all-row').hidden, true);
    if (state === 'error') assert.notEqual(h.el('retry-button').style.display, 'none');
  });
}

test('verification pause displays reason and Resume even when every file is queued', t => {
  const value = session(['queued'], { hasStarted: true, paused: true });
  value.items[0].error = 'Complete browser verification';
  const h = setup(t, value);
  assert.match(h.el('status').textContent, /verification/);
  assert.equal(h.el('pause-resume-button').textContent, 'Resume');
});

test('Select All clears and restores selection and Start availability', t => {
  const h = setup(t);
  h.el('select-all').click();
  assert.equal(h.el('start-button').disabled, true);
  h.el('select-all').click();
  assert.equal(h.el('start-button').disabled, false);
});

test('direct checkbox activation keeps its native toggle and updates the selection summary', t => {
  const h = setup(t);
  const checkbox = h.document.querySelector('#files-list input');
  checkbox.click();
  assert.equal(checkbox.checked, false);
  assert.match(h.el('selection-info').textContent, /1 of 2/);
  checkbox.click();
  assert.equal(checkbox.checked, true);
  assert.match(h.el('selection-info').textContent, /2 of 2/);
});

test('row, range, and modifier selection update summary and indeterminate state', t => {
  const h = setup(t, session(['queued', 'queued', 'queued']));
  const rows = h.document.querySelectorAll('.file-row');
  rows[0].click();
  assert.equal(h.el('select-all').indeterminate, true);
  rows[2].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.equal(h.el('start-button').disabled, true);
  rows[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  assert.match(h.el('selection-info').textContent, /1 of 3/);
});

test('updates for another tab do not replace the current list', t => {
  const h = setup(t);
  h.broadcast({ type: 'session_updated', tabId: 999, session: session([]) });
  assert.equal(h.document.querySelectorAll('.file-row').length, 2);
  h.broadcast({ type: 'session_updated', tabId: 1, session: session([]) });
  assert.equal(h.document.querySelectorAll('.file-row').length, 0);
});

test('settings navigation and valid Apply keep both inputs synchronized', async t => {
  const h = setup(t);
  h.el('settings-button').click();
  assert.equal(h.document.body.dataset.view, 'settings');
  h.el('concurrency-input').value = '7'; h.el('save-settings-button').click();
  assert.equal(h.el('parallel-input').value, '7');
  h.el('back-button').click();
  assert.equal(h.document.body.dataset.view, 'main');
  h.el('parallel-input').value = '3'; h.el('apply-parallel-button').click();
  assert.equal(h.el('concurrency-input').value, '3');
});

test('invalid concurrency is explained and never sent to storage', t => {
  const h = setup(t);
  const before = h.messages.length;
  h.el('parallel-input').value = '1.5'; h.el('apply-parallel-button').click();
  assert.match(h.el('status').textContent, /whole number/);
  assert.equal(h.messages.length, before);
});

test('scan and settings failures leave controls usable with an error explanation', t => {
  const h = pageHarness(); t.after(h.close);
  h.state.error = 'Permission denied'; h.start();
  assert.match(h.el('status').textContent, /Permission denied/);
  assert.equal(h.el('start-button').disabled, true);
  h.el('parallel-input').value = '5'; h.el('apply-parallel-button').click();
  assert.match(h.el('settings-status').textContent, /Permission denied/);
});

test('pause, resume, cancel and retry controls send their intended messages', t => {
  const h = setup(t, session(['downloading'], { hasStarted: true }));
  h.el('pause-resume-button').click();
  assert.equal(h.messages.at(-1).type, 'pause_downloads');
  h.el('pause-resume-button').textContent = 'Resume'; h.el('pause-resume-button').click();
  assert.equal(h.messages.at(-1).type, 'resume_downloads');
  h.el('cancel-button').click();
  assert.ok(h.messages.some(m => m.type === 'cancel_downloads'));
  h.el('retry-button').click();
  assert.ok(h.messages.some(m => m.type === 'retry_failed'));
});

test('standalone options page loads, clamps, and saves settings', t => {
  const h = pageHarness('options'); t.after(h.close); h.start();
  assert.equal(h.el('concurrency-input').value, '5');
  h.el('concurrency-input').value = '99'; h.el('save-button').click();
  assert.equal(h.state.concurrency, 20);
  assert.match(h.el('status').textContent, /saved/);
  h.el('concurrency-input').value = ''; h.el('save-button').click();
  assert.equal(h.state.concurrency, 5);
});

test('standalone options page shows load and save failures', t => {
  const h = pageHarness('options'); t.after(h.close);
  h.state.error = 'Storage unavailable'; h.start();
  assert.match(h.el('status').textContent, /Storage unavailable/);
  h.el('save-button').click();
  assert.match(h.el('status').textContent, /Storage unavailable/);
});
