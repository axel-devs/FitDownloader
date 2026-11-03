const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const elements = new Map();
  const messages = [];
  const document = {
    getElementById(id) {
      assert.ok(html.includes(`id="${id}"`), `Missing popup element: ${id}`);
      if (!elements.has(id)) elements.set(id, {
        value: '5', textContent: '', style: {}, dataset: {},
        addEventListener(type, fn) { this[type] = fn; },
        querySelectorAll() { return []; }
      });
      return elements.get(id);
    },
    addEventListener() {}
  };
  const context = vm.createContext({
    document, setTimeout() {},
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        messages.push(message);
        callback(message.type === 'save_settings'
          ? { ok: true, settings: message.settings }
          : { ok: false, error: 'Mock start stopped' });
      }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);
  return { context, elements, messages };
}

test('parallel input persists and synchronizes both settings controls', async () => {
  const h = harness();
  assert.equal(await h.context.persistConcurrency('8'), true);
  assert.equal(h.messages[0].settings.concurrency, 8);
  assert.equal(h.elements.get('parallel-input').value, 8);
  assert.equal(h.elements.get('concurrency-input').value, 8);
});

test('parallel input rejects empty, fractional and out-of-range values', async () => {
  const h = harness();
  for (const value of ['', '0', '-1', '21', '1.5', 'NaN']) {
    assert.equal(await h.context.persistConcurrency(value), false);
  }
  assert.equal(h.messages.length, 0);
});

test('starting a batch saves the visible parallel limit before sending selected files', async () => {
  const h = harness();
  h.elements.get('parallel-input').value = '3';
  h.elements.get('files-list').querySelectorAll = () => [{ checked: true, dataset: { index: '0' } }];
  vm.runInContext('currentSession = {items: [{url: "https://fuckingfast.co/file", label: "file"}]}', h.context);
  await h.elements.get('start-button').click();
  assert.equal(h.messages[0].type, 'save_settings');
  assert.equal(h.messages[0].settings.concurrency, 3);
  assert.equal(h.messages[1].type, 'start_downloads');
  assert.equal(h.messages[1].items[0].url, 'https://fuckingfast.co/file');
});
