const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/background.cjs');
function host(response) {
  const h = harness(); let calls = 0;
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return ++calls === 1
      ? { ok: true, text: async () => '<a hx-post="/f/file/go">DOWNLOAD</a>' }
      : response;
  };
  return h;
}
const resolve = h => h.context.getDirectDownloadUrl('https://fuckingfast.co/file');

for (const header of ['HX-Trigger', 'HX-Trigger-After-Swap', 'HX-Trigger-After-Settle']) {
  test(`${header} can carry a secure event URL`, async () => {
    const h = host({ ok: true, text: async () => '', headers: new Headers({ [header]: '{"url":"https://dl.fuckingfast.co/dl/part.rar"}' }) });
    assert.equal(await resolve(h), 'https://dl.fuckingfast.co/dl/part.rar');
  });
}

for (const [headers, pattern] of [
  [{ 'HX-Location': '{broken' }, /invalid download response/],
  [{ 'HX-Location': '{}' }, /unsafe/],
  [{ 'HX-Redirect': 'javascript:alert(1)' }, /unsafe/],
  [{ 'HX-Redirect': '//evil.example/dl/file' }, /unsafe/],
  [{ 'HX-Redirect': 'https://user@fuckingfast.co/dl/file' }, /unsafe/],
  [{ 'HX-Redirect': 'https://dl.fuckingfast.co:8443/dl/file' }, /unsafe/]
]) {
  test(`rejects malformed/unsafe host header ${JSON.stringify(headers)}`, async () => {
    const h = host({ ok: true, text: async () => '', headers: new Headers(headers) });
    await assert.rejects(resolve(h), pattern);
    assert.equal(h.downloads.length, 0);
  });
}

for (const status of [404, 429, 500, 503]) {
  test(`reports POST HTTP ${status} without retrying indefinitely`, async () => {
    const h = host({ ok: false, status, text: async () => 'Error' });
    await assert.rejects(resolve(h), new RegExp(`HTTP ${status}`));
    assert.equal(h.requests.length, 2);
  });
}

test('HTTP 200 challenge returned by POST requests verification', async () => {
  const h = host({ ok: true, status: 200, text: async () => '<title>Just a moment...</title>', headers: new Headers() });
  await assert.rejects(resolve(h), error => error.code === 'HOST_VERIFICATION');
});

test('HTTP 200 challenge on the landing page is not treated as a file', async () => {
  const h = harness();
  h.context.fetch = async () => ({ ok: true, status: 200, text: async () => '<title>Just a moment...</title>' });
  await assert.rejects(resolve(h), error => error.code === 'HOST_VERIFICATION');
});

test('POST network rejection reports the failed link-generation request', async () => {
  const h = host(null); let calls = 0;
  h.context.fetch = async () => {
    if (++calls === 1) return { ok: true, text: async () => '<a hx-post="/f/file/go">DOWNLOAD</a>' };
    throw new Error('timeout');
  };
  await assert.rejects(resolve(h), /download-link request failed.*timeout/);
});

test('unsupported landing URLs are rejected before a request is sent', async () => {
  const h = harness();
  for (const value of ['invalid', 'https://evil.example/file', 'file:///private', 'https://user:password@fuckingfast.co/file']) {
    await assert.rejects(h.context.getDirectDownloadUrl(value), /unsupported/);
  }
  assert.equal(h.requests.length, 0);
});

test('scan extracts actual fixture anchors, scopes to entry content and deduplicates', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<title>Game - FitGirl Repacks</title><div class="entry-content"><a href="https://fuckingfast.co/file">Part 1</a><a href="https://fuckingfast.co/file">Duplicate</a><a href="https://evil.example/">Ignore</a></div><a href="https://fuckingfast.co/unrelated">Footer</a>');
  const h = harness(); h.context.document = dom.window.document;
  h.chrome.scripting.executeScript = async options => [{ result: h.run(`(${options.func.toString()})()`) }];
  try {
    const result = await h.context.extractFuckingFastLinks(1);
    assert.equal(result.title, 'Game');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].label, 'Part 1');
  } finally { dom.window.close(); }
});

test('timeout uses a cancellable signal and does not fall back to HTTP', async () => {
  const h = harness();
  const controller = new AbortController();
  h.context.AbortSignal = { timeout(ms) { assert.equal(ms, 20000); return controller.signal; } };
  h.context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
  });
  const pending = resolve(h);
  controller.abort();
  await assert.rejects(pending, /Timed out/);
});

test('body-read errors reject resolution instead of producing a download', async () => {
  const h = harness();
  h.context.fetch = async () => ({ ok: true, text: async () => { throw new Error('Body stream interrupted'); } });
  await assert.rejects(resolve(h), /Body stream interrupted/);
  assert.equal(h.downloads.length, 0);
});

test('large fixture HTML is parsed without executing embedded scripts', async () => {
  // Characterizes parsing, NOT a size protection guarantee: see ARCH-06.
  const h = harness();
  h.context.fetch = async () => ({ ok: true, text: async () => ' '.repeat(1024 * 1024) +
    '<script>throw new Error("must not execute")</script>https://dl.fuckingfast.co/dl/tiny.txt' });
  assert.equal(await resolve(h), 'https://dl.fuckingfast.co/dl/tiny.txt');
});

test('missing download control produces a useful unsupported-page error', async () => {
  const h = harness();
  h.context.fetch = async () => ({ ok: true, text: async () => '<html><p>File no longer available</p></html>' });
  await assert.rejects(resolve(h), /supported download control/);
});

test('absolute same-host POST control resolves its relative download header', async () => {
  const h = harness(); let calls = 0;
  h.context.fetch = async () => ++calls === 1
    ? { ok: true, text: async () => "<a hx-post='https://fuckingfast.co/f/file/go'>Download</a>" }
    : { ok: true, text: async () => '', headers: new Headers({ 'HX-Redirect': '/dl/tiny.txt' }) };
  assert.equal(await resolve(h), 'https://fuckingfast.co/dl/tiny.txt');
});

test('scanner falls back to body when entry and post containers are absent', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<a href="http://fuckingfast.co/file">Part</a>');
  const h = harness(); h.context.document = dom.window.document;
  h.chrome.scripting.executeScript = async options => [{ result: h.run(`(${options.func.toString()})()`) }];
  try { assert.equal((await h.context.extractFuckingFastLinks(1)).items.length, 1); }
  finally { dom.window.close(); }
});
