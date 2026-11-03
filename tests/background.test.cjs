const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { harness, tick, root } = require('./helpers/background.cjs');

test('all application scripts parse and manifest references exist', () => {
  for (const file of ['background.js', 'popup.js', 'options.js']) {
    new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});

test('reported HTTP landing URL is upgraded before fetch, with fragment removed', async () => {
  const h = harness();
  await h.context.getDirectDownloadUrl('http://fuckingfast.co/dqy8n6yocv2t#CoD_MW4.part01.rar');
  assert.equal(h.requests[0].url, 'https://fuckingfast.co/dqy8n6yocv2t');
  assert.equal(h.requests[0].options.redirect, 'error');
  assert.equal(h.requests[0].options.credentials, 'include');
});

test('fetch failures never retry over HTTP', async () => {
  const h = harness();
  let calls = 0;
  h.context.fetch = async () => { calls++; throw new Error('Network failure'); };
  await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/file'), /Reload the extension/);
  assert.equal(calls, 1);
});

test('rejects spoofed hosts, credentials, ports and unsafe schemes', () => {
  const h = harness();
  for (const url of [
    'https://example.com/?fitgirl-repacks.site',
    'https://fitgirl-repacks.site.example.com/',
    'https://fitgirl-repacks.site@example.com/',
    'http://fitgirl-repacks.site/',
    'https://fitgirl-repacks.site:8443/'
  ]) assert.equal(h.context.isSupportedSource(url), false, url);
  for (const url of ['https://example.com/', 'javascript:alert(1)', 'https://user@fuckingfast.co/file']) {
    assert.equal(h.context.normalizeLink({ url }), null);
  }
  assert.equal(h.context.isSupportedSource('https://fitgirl-repacks.site/game/'), true);
});

test('scan refuses unrelated active page before script injection', async () => {
  const h = harness();
  h.chrome.tabs.query = async () => [{ id: 1, url: 'https://example.com/?fitgirl-repacks.site' }];
  const result = await h.message({ type: 'scan_current_tab' });
  assert.equal(result.ok, false);
});

test('scanner uses isolated execution; untrusted returned links are filtered', async () => {
  const h = harness();
  h.chrome.scripting = { executeScript: async options => {
    assert.equal(options.world, 'ISOLATED');
    return [{ result: { title: 'Game', items: [{ url: 'https://example.com/evil', label: 'archive.rar' }] } }];
  } };
  const links = await h.context.extractFuckingFastLinks(1);
  const session = h.context.createSessionFromExtractedLinks({ id: 1 }, links.title, links.items, 0);
  assert.equal(session.items.length, 0);
});

test('parses escaped secure download links without executing scripts', async () => {
  const h = harness();
  h.context.fetch = async () => ({ ok: true, text: async () => String.raw`<script>download("https:\/\/dl.fuckingfast.co\/dl\/file?x=1&amp;y=2")</script>` });
  assert.equal(await h.context.getDirectDownloadUrl('https://fuckingfast.co/file'), 'https://dl.fuckingfast.co/dl/file?x=1&y=2');
});

test('rejects HTTP direct downloads and blocked host responses', async () => {
  const h = harness();
  await assert.rejects(h.context.startDownload('http://dl.fuckingfast.co/dl/file'), /unsafe/);
  assert.equal(h.downloads.length, 0);
});

test('HTTP-only HTML and host challenges produce useful errors', async () => {
  const h = harness();
  h.context.fetch = async () => ({ ok: true, text: async () => 'http://dl.fuckingfast.co/dl/file' });
  await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/file'), /No secure direct/);
  h.context.fetch = async () => ({ ok: false, status: 403, text: async () => '<title>Just a moment...</title>' });
  await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/file'), /browser verification.*HTTP 403/);
});

// This DOWNLOAD element was read from the live page DOM on 2026-11-03.
const liveDownloadControl = '<a class="link-button text-5xl gay-button" hx-post="/f/dqy8n6yocv2t/go" hx-swap="none" rel="noopener">DOWNLOAD</a>';

function modernHost(response) {
  const h = harness();
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return h.requests.length === 1
      ? { ok: true, text: async () => liveDownloadControl }
      : response;
  };
  return h;
}

test('observed live control uses its exact POST endpoint without loading ads or running scripts', async () => {
  const h = modernHost({ ok: true, text: async () => '', headers: new Headers({ 'HX-Redirect': 'https://dl.fuckingfast.co/dl/test.rar' }) });
  assert.equal(await h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t#file.rar'), 'https://dl.fuckingfast.co/dl/test.rar');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, 'https://fuckingfast.co/f/dqy8n6yocv2t/go');
  assert.equal(h.requests[1].options.method, 'POST');
  assert.equal(h.requests[1].options.headers['HX-Request'], 'true');
  assert.equal(h.requests[1].options.credentials, 'include');
  assert.equal(h.requests[1].options.redirect, 'error');
});

test('supports HTMX location headers and returned HTML without executing it', async () => {
  for (const [headers, body] of [
    [{ 'HX-Location': '{"path":"/dl/test.rar"}' }, ''],
    [{ 'HX-Location': 'https://dl.fuckingfast.co/dl/test.rar' }, ''],
    [{}, '<script>window.location="https://dl.fuckingfast.co/dl/test.rar"</script>']
  ]) {
    const h = modernHost({ ok: true, text: async () => body, headers: new Headers(headers) });
    const direct = await h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t');
    assert.match(direct, /^https:\/\/(dl\.)?fuckingfast\.co\/dl\/test.rar$/);
  }
});

test('rejects untrusted POST controls before sending requests', async () => {
  for (const endpoint of ['https://evil.example/f/file/go', '/f/other/go', '/f/file/go?redirect=evil']) {
    const h = harness();
    h.context.fetch = async (url, options) => {
      h.requests.push({ url, options });
      return { ok: true, text: async () => `<a hx-post="${endpoint}">DOWNLOAD</a>` };
    };
    await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/file'), /supported download control/);
    assert.equal(h.requests.length, 1);
  }
});

test('rejects ad destinations and HTTP URLs returned by the POST endpoint', async () => {
  for (const target of ['https://ads.example/download.exe', 'http://dl.fuckingfast.co/dl/file']) {
    const h = modernHost({ ok: true, text: async () => '', headers: new Headers({ 'HX-Redirect': target }) });
    await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t'), /unsafe/);
    assert.equal(h.downloads.length, 0);
  }
});

test('POST challenges are reported without loading challenge or ad pages', async () => {
  const h = modernHost({ ok: false, status: 403, text: async () => '<title>Just a moment...</title>' });
  await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t'), /browser verification/);
  assert.equal(h.requests.length, 2);
});

test('supports a secure URL in an HTMX event payload', async () => {
  const h = modernHost({ ok: true, text: async () => '', headers: new Headers({
    'HX-Trigger': '{"download":{"url":"https://dl.fuckingfast.co/dl/test.rar"}}'
  }) });
  assert.equal(await h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t'), 'https://dl.fuckingfast.co/dl/test.rar');
});

test('verification pauses the batch and keeps files queued for resume', async () => {
  const h = harness();
  h.seed(30);
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return { ok: false, status: 403, text: async () => '<title>Just a moment...</title>' };
  };
  await h.run('pumpQueueForTab(1)');
  await tick();
  assert.equal(h.run('sessions[1].paused'), true);
  assert.equal(h.run('sessions[1].items.filter(i => i.state === "queued").length'), 30);
  assert.equal(h.requests.length, 2); // only the two slots already reserved
  assert.equal(h.downloads.length, 0);
});

test('unknown successful POST response is explicit, rather than claiming a completed download', async () => {
  const h = modernHost({ ok: true, text: async () => 'Unknown response', headers: new Headers() });
  await assert.rejects(h.context.getDirectDownloadUrl('https://fuckingfast.co/dqy8n6yocv2t'), /unsupported response/);
  assert.equal(h.downloads.length, 0);
});

test('simultaneous queue pumps respect configured concurrency', async () => {
  const h = harness();
  h.seed();
  await Promise.all([h.run('pumpQueueForTab(1)'), h.run('pumpQueueForTab(1)'), h.run('pumpQueueForTab(1)')]);
  await tick();
  assert.equal(h.downloads.length, 2);
});

test('applying a higher parallel limit fills new slots without duplicating active downloads', async () => {
  const h = harness();
  h.seed(5);
  let concurrency = 1;
  h.chrome.storage.sync.get = async () => ({ concurrency });
  h.chrome.storage.sync.set = (settings, callback) => { concurrency = settings.concurrency; callback(); };
  await h.run('pumpQueueForTab(1)');
  await tick();
  assert.equal(h.downloads.length, 1);
  await h.message({ type: 'save_settings', settings: { concurrency: 3 } });
  await tick();
  assert.equal(h.downloads.length, 3);
  await h.message({ type: 'save_settings', settings: { concurrency: 1 } });
  await tick();
  assert.equal(h.downloads.length, 3);
});

test('pause during lookup prevents new downloads; resume processes queued work', async () => {
  const h = harness();
  h.seed(1);
  let release;
  h.context.fetch = () => new Promise(resolve => { release = resolve; });
  await h.run('pumpQueueForTab(1)');
  await h.message({ type: 'pause_downloads' });
  release({ ok: true, text: async () => 'https://dl.fuckingfast.co/dl/file' });
  await tick();
  assert.equal(h.downloads.length, 0);
  assert.equal(h.run('sessions[1].items[0].state'), 'queued');
  h.context.fetch = async () => ({ ok: true, text: async () => 'https://dl.fuckingfast.co/dl/file' });
  await h.message({ type: 'resume_downloads' });
  await tick();
  assert.equal(h.downloads.length, 1);
});

test('pause during download creation pauses the newly created download', async () => {
  const h = harness();
  h.seed(1);
  let created;
  h.chrome.downloads.download = (_options, callback) => { created = callback; };
  await h.run('pumpQueueForTab(1)');
  await tick();
  await h.message({ type: 'pause_downloads' });
  created(42);
  await tick();
  assert.deepEqual(h.paused, [42]);
});

test('cancel during lookup prevents download creation', async () => {
  const h = harness();
  h.seed(1);
  h.chrome.tabs.query = async () => [{ id: 1, url: 'https://example.com/' }];
  let release;
  h.context.fetch = () => new Promise(resolve => { release = resolve; });
  await h.run('pumpQueueForTab(1)');
  await h.message({ type: 'cancel_downloads' });
  release({ ok: true, text: async () => 'https://dl.fuckingfast.co/dl/file' });
  await tick();
  assert.equal(h.downloads.length, 0);
});
