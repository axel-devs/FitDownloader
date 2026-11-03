const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ local = {}, concurrency = 2, records = new Map() } = {}) {
  const listeners = {};
  const requests = [], downloads = [], paused = [], resumed = [], cancelled = [], broadcasts = [], warnings = [];
  const state = { local, concurrency, records, activeTab: { id: 1, url: 'https://fitgirl-repacks.site/game/' }, storageError: null };
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      onMessage: event('message'),
      sendMessage(message, callback) { broadcasts.push(clone(message)); callback(); }
    },
    storage: {
      local: {
        async get(key) { if (state.storageError) throw state.storageError; return { [key]: clone(local[key]) }; },
        async set(value) { if (state.storageError) throw state.storageError; Object.assign(local, clone(value)); }
      },
      sync: {
        get: async () => ({ concurrency: state.concurrency }),
        set(settings, callback) { state.concurrency = settings.concurrency; callback(); }
      }
    },
    tabs: { query: async () => state.activeTab ? [state.activeTab] : [], onRemoved: event('removed') },
    downloads: {
      onChanged: event('changed'),
      search(query, callback) { callback(records.has(query.id) ? [clone(records.get(query.id))] : []); },
      download(options, callback) {
        const id = downloads.length + 1;
        downloads.push(clone(options));
        records.set(id, { id, state: 'in_progress', paused: false });
        callback(id);
      },
      async pause(id) { paused.push(id); const item = records.get(id); if (item) item.paused = true; },
      async resume(id) { resumed.push(id); const item = records.get(id); if (item) item.paused = false; },
      async cancel(id) { cancelled.push(id); const item = records.get(id); if (item) item.state = 'interrupted'; }
    },
    scripting: { executeScript: async () => [{ result: { title: 'Game', items: [{ url: 'https://fuckingfast.co/file0', label: 'File 0' }] } }] }
  };
  const context = vm.createContext({
    URL, AbortSignal, chrome,
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => 'https://dl.fuckingfast.co/dl/test.rar' };
    }
  });
  vm.runInContext(source, context, { filename: pathToFileURL(path.join(root, 'background.js')).href });
  const run = code => vm.runInContext(code, context);
  const message = payload => new Promise(resolve => {
    const keepAlive = listeners.message(payload, {}, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
  const seed = (count = 4) => run(`
    sessionsLoaded = true; downloadMapLoaded = true;
    sessions[1] = createSessionFromExtractedLinks(
      {id: 1, url: 'https://fitgirl-repacks.site/game/'}, 'Game',
      Array.from({length: ${count}}, (_, i) => ({url: 'https://fuckingfast.co/file' + i, label: 'File ' + i})), 0);
    sessions[1].hasStarted = true;
  `);
  const emit = async (name, value) => { listeners[name](value); await tick(); };
  return { context, chrome, requests, downloads, paused, resumed, cancelled, broadcasts, warnings, state, listeners, run, message, seed, emit };
}
module.exports = { harness, tick, deferred, root };
