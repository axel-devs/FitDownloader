const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
function pageHarness(name = 'popup', responder) {
  const html = fs.readFileSync(path.join(root, `${name}.html`), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://extension.test/${name}.html` });
  const { window } = dom;
  const messages = [];
  let receiver;
  const state = { session: null, tabId: 1, concurrency: 5, error: null };
  window.chrome = { runtime: {
    onMessage: { addListener(fn) { receiver = fn; } },
    sendMessage(message, callback) {
      messages.push(structuredClone(message));
      if (responder) return responder(message, callback, state, window);
      if (state.error) return callback({ ok: false, error: state.error });
      if (message.type === 'get_settings') return callback({ ok: true, settings: { concurrency: state.concurrency } });
      if (message.type === 'save_settings') {
        state.concurrency = message.settings.concurrency;
        return callback({ ok: true, settings: { concurrency: state.concurrency } });
      }
      if (message.type === 'scan_current_tab') return callback({ ok: true, tabId: state.tabId, session: state.session });
      callback({ ok: true });
    }
  } };
  // Name VM-loaded application scripts so c8 measures real source files.
  const vm = require('node:vm');
  vm.runInContext(fs.readFileSync(path.join(root, `${name}.js`), 'utf8'), dom.getInternalVMContext(), {
    filename: pathToFileURL(path.join(root, `${name}.js`)).href
  });
  const el = id => window.document.getElementById(id);
  const start = () => window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const broadcast = message => receiver(message);
  return { window, document: window.document, el, messages, state, start, broadcast, close: () => window.close() };
}
module.exports = { pageHarness };
