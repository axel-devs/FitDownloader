// FitGirl FuckingFast Batch Downloader - background service worker (MV3)

// Default maximum number of FuckingFast links we will actively process at once
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

function parseTrustedUrl(value, hosts, upgradeHttp = false) {
  try {
    const url = new URL(value);
    if (upgradeHttp && url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) ||
        url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function isSupportedSource(value) {
  return !!parseTrustedUrl(value, ["fitgirl-repacks.site"]);
}

function normalizeLandingUrl(value) {
  const url = parseTrustedUrl(value, ["fuckingfast.co"], true);
  return url ? url.href : null;
}

function validateDirectUrl(value) {
  const url = parseTrustedUrl(value, ["fuckingfast.co", "dl.fuckingfast.co"]);
  if (!url || !url.pathname.startsWith("/dl/")) {
    throw new Error("Rejected an unsafe or unsupported download URL.");
  }
  return url.href;
}

// In-memory sessions keyed by Chrome tab ID
// sessions[tabId] = { tabId, sourceUrl, hasStarted, items: [{ url, label, state, downloadId|null }] }
let sessions = {};
let sessionsLoaded = false;

// Map downloadId -> { tabId, index } into sessions[tabId].items
let downloadIdToKey = new Map();
let downloadMapLoaded = false;
const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "downloading", "paused"]);

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  // Hard limit between 1 and 20 to avoid abuse
  return Math.max(1, Math.min(20, Math.round(n)));
}

async function getCurrentSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    concurrency: clampConcurrency(stored.concurrency)
  };
}

async function loadDownloadMap() {
  if (downloadMapLoaded) return;
  const stored = await chrome.storage.local.get("ffDownloadMap");
  if (stored.ffDownloadMap && typeof stored.ffDownloadMap === "object") {
    downloadIdToKey = new Map(
      Object.entries(stored.ffDownloadMap).map(([id, key]) => [
        Number(id),
        key
      ])
    );
  }
  downloadMapLoaded = true;
}

async function saveDownloadMap() {
  const obj = {};
  for (const [id, key] of downloadIdToKey.entries()) {
    obj[id] = key;
  }
  await chrome.storage.local.set({ ffDownloadMap: obj });
}

async function loadSessions() {
  if (sessionsLoaded) return;
  const stored = await chrome.storage.local.get("ffSessions");
  if (stored.ffSessions && typeof stored.ffSessions === "object") {
    sessions = stored.ffSessions;
  }
  sessionsLoaded = true;
}

async function saveSessions() {
  await chrome.storage.local.set({ ffSessions: sessions });
}

function normalizeLink(link) {
  if (!link || typeof link.url !== "string" || !link.url.length) return null;
  const url = normalizeLandingUrl(link.url);
  if (!url) return null;
  return {
    url,
    label: typeof link.label === "string" && link.label.length ? link.label : link.url
  };
}

function toQueuedItem(link) {
  return {
    url: link.url,
    label: link.label || link.url,
    state: "queued",
    downloadId: null
  };
}

function normalizeSessionItem(item) {
  const link = normalizeLink(item);
  if (!link) return null;
  return {
    url: link.url,
    label: link.label,
    state: typeof item?.state === "string" ? item.state : "queued",
    error: typeof item?.error === "string" ? item.error : "",
    downloadId: Number.isInteger(item?.downloadId) ? item.downloadId : null
  };
}

function normalizeSessionShape(session) {
  if (!session || typeof session !== "object") {
    return {
      tabId: null,
      sourceUrl: "",
      title: "",
      hasStarted: false,
      paused: false,
      generation: 0,
      allItems: [],
      items: []
    };
  }

  const normalizedItems = Array.isArray(session.items)
    ? session.items.map(normalizeSessionItem).filter(Boolean)
    : [];

  const rawAllItems = Array.isArray(session.allItems) ? session.allItems : [];
  const normalizedAllItems = rawAllItems.map(normalizeLink).filter(Boolean);
  const allItems =
    normalizedAllItems.length > 0
      ? normalizedAllItems
      : normalizedItems.map((item) => ({ url: item.url, label: item.label }));

  return {
    ...session,
    sourceUrl: typeof session.sourceUrl === "string" ? session.sourceUrl : "",
    title: typeof session.title === "string" ? session.title : "",
    hasStarted: session.hasStarted === true,
    paused: session.paused === true,
    generation: Number.isInteger(session.generation) ? session.generation : 0,
    allItems,
    items: normalizedItems
  };
}

function getSessionGeneration(session) {
  return Number.isInteger(session?.generation) ? session.generation : 0;
}

function hasActiveItems(session) {
  if (!session || session.hasStarted !== true || !Array.isArray(session.items)) {
    return false;
  }
  return session.items.some((item) => ACTIVE_ITEM_STATES.has(item.state));
}

function normalizeSessionUrl(url) {
  if (typeof url !== "string" || !url.length) return "";

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (e) {
    return url.split("#")[0];
  }
}

function shouldReuseSessionForTab(session, tab) {
  if (!session) return false;

  const activeRun = hasActiveItems(session);
  const samePage =
    normalizeSessionUrl(session.sourceUrl) === normalizeSessionUrl(tab?.url);

  if (activeRun) {
    // While work is actively queued/running, preserve tab-scoped batch state
    // even if the user navigates within the tab.
    return true;
  }

  // Pre-start state can be reused on the same page.
  if (!session.hasStarted && samePage) {
    return true;
  }

  // Terminal or cancelled runs should not linger across page changes.
  return false;
}

function isSessionGenerationCurrent(tabId, generation) {
  const session = sessions[tabId];
  if (!session) return false;
  return getSessionGeneration(session) === generation;
}

function getSessionItemForRun(tabId, index, generation) {
  if (!isSessionGenerationCurrent(tabId, generation)) return null;
  const session = sessions[tabId];
  if (!session || !Array.isArray(session.items) || !session.items[index]) {
    return null;
  }
  return session.items[index];
}

function createSessionFromExtractedLinks(tab, title, links, generation) {
  const allItems = Array.isArray(links) ? links.map(normalizeLink).filter(Boolean) : [];
  return normalizeSessionShape({
    tabId: tab.id,
    sourceUrl: tab.url,
    title: title || "",
    hasStarted: false,
    paused: false,
    generation,
    allItems,
    items: allItems.map(toQueuedItem)
  });
}

function searchDownloadById(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(Array.isArray(results) && results.length ? results[0] : null);
    });
  });
}

async function reconcileSessionForTab(tabId) {
  await loadSessions();
  await loadDownloadMap();

  const existing = sessions[tabId];
  if (!existing) return;

  const session = normalizeSessionShape(existing);
  let sessionsChanged = false;
  let mapChanged = false;

  for (let i = 0; i < session.items.length; i++) {
    const item = session.items[i];

    if (item.downloadId == null) {
      if (item.state === "starting") {
        continue;
      }
      if (item.state === "downloading" || item.state === "paused") {
        item.state = "error";
        sessionsChanged = true;
      }
      continue;
    }

    const downloadId = item.downloadId;
    const download = await searchDownloadById(downloadId);

    if (!download) {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      if (ACTIVE_ITEM_STATES.has(item.state)) {
        item.state = "cancelled";
      }
      sessionsChanged = true;
      continue;
    }

    if (download.state === "complete") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.state = "completed";
      sessionsChanged = true;
      continue;
    }

    if (download.state === "interrupted") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.state = download.error === "USER_CANCELED" ? "cancelled" : "error";
      sessionsChanged = true;
      continue;
    }

    const nextState = download.paused ? "paused" : "downloading";
    if (item.state !== nextState) {
      item.state = nextState;
      sessionsChanged = true;
    }

    const existingKey = downloadIdToKey.get(downloadId);
    const generation = getSessionGeneration(session);
    if (
      !existingKey ||
      existingKey.tabId !== tabId ||
      existingKey.index !== i ||
      existingKey.generation !== generation
    ) {
      downloadIdToKey.set(downloadId, { tabId, index: i, generation });
      mapChanged = true;
    }
  }

  if (session.hasStarted && !hasActiveItems(session)) {
    session.hasStarted = false;
    session.paused = false;
    sessionsChanged = true;
  }

  if (sessionsChanged) {
    sessions[tabId] = session;
    broadcastSessionUpdate(tabId);
  }

  if (sessionsChanged || mapChanged) {
    await Promise.all([
      sessionsChanged ? saveSessions() : Promise.resolve(),
      mapChanged ? saveDownloadMap() : Promise.resolve()
    ]);
  }
}

async function rebuildSessionForTab(tab, generation) {
  const { title, items } = await extractFuckingFastLinks(tab.id);
  const rebuilt = createSessionFromExtractedLinks(tab, title, items, generation);
  sessions[tab.id] = rebuilt;
  await saveSessions();
  return rebuilt;
}

function broadcastSessionUpdate(tabId) {
  // In MV3, sendMessage may reject with "Receiving end does not exist"
  // when no views (popup, etc.) are open. We explicitly ignore that.
  const session = sessions[tabId];
  if (!session) return;
  try {
    chrome.runtime.sendMessage({ type: "session_updated", tabId, session }, () => {
      // Accessing lastError clears it and prevents "Uncaught (in promise)" noise
      // when there is no receiver (e.g. popup closed).
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // Ignore synchronous errors as well (very rare)
  }
}

/**
 * Extract all FuckingFast links from the current FitGirl page.
 * Runs in the context of the page via chrome.scripting.executeScript.
 */
async function extractFuckingFastLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      const rawTitle = document.title || "";
      const title = rawTitle.replace(/ - FitGirl Repacks.*/i, "").trim();

      // Try to scope to the main post content if possible
      const containers = [
        document.querySelector(".entry-content"),
        document.querySelector(".post"),
        document.body
      ].filter(Boolean);

      const items = [];

      for (const container of containers) {
        const anchors = container.querySelectorAll(
          'a[href^="https://fuckingfast.co/"], a[href^="http://fuckingfast.co/"]'
        );
        anchors.forEach((a) => {
          if (a.href) {
            const label = a.textContent.trim() || a.href;
            items.push({ url: a.href, label });
          }
        });
        // If we found some inside a more specific container, no need to fall back further
        if (items.length > 0 && container !== document.body) {
          break;
        }
      }

      // De-duplicate by URL while preserving first label
      const seen = new Set();
      const unique = [];
      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        unique.push(item);
      }

      return { title, items: unique };
    }
  });

  if (result && Array.isArray(result.items)) {
    return { title: result.title || "", items: result.items };
  }

  return { title: "", items: [] };
}

function extractSecureDownloadUrl(text) {
  const decoded = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const match = decoded.match(/https:\/\/(?:dl\.)?fuckingfast\.co\/dl\/[^\s"'<>\\]+/);
  return match ? validateDirectUrl(match[0]) : null;
}

function hostResponseError(response, html) {
  if (response.status === 403 || /<title[^>]*>\s*Just a moment|cf-chl-|cf-turnstile/i.test(html)) {
    const error = new Error("The file host blocked this request or requires browser verification (HTTP " + response.status + "). Open the original file page, complete any verification yourself, then resume. No ad pages were opened.");
    error.code = "HOST_VERIFICATION";
    return error;
  }
  return new Error(`File host returned HTTP ${response.status}.`);
}

// Follow the host's observed HTMX protocol, never its advertising scripts.
async function getDirectDownloadUrl(fuckingFastUrl) {
  const normalized = normalizeLandingUrl(fuckingFastUrl);
  if (!normalized) throw new Error("Rejected an unsupported file-host URL.");
  const url = new URL(normalized);
  // Fragments contain display filenames, not part of the HTTP resource.
  url.hash = "";
  let res;
  try {
    res = await fetch(url.href, {
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new Error("Unable to fetch the HTTPS file page. Reload the extension and allow access to fuckingfast.co in Chrome's extension Site access settings. The host may also be unavailable or redirecting. " + err.message);
  }
  const html = await res.text();
  if (!res.ok) throw hostResponseError(res, html);
  const legacyLink = extractSecureDownloadUrl(html);
  if (legacyLink) return legacyLink;

  // The current DOWNLOAD control has hx-post="/f/<file-id>/go".
  // Accept only the endpoint belonging to this exact landing page.
  const fileId = url.pathname.slice(1);
  const expectedPath = `/f/${fileId}/go`;
  const postPaths = Array.from(html.matchAll(/\bhx-post\s*=\s*["']([^"']+)["']/gi));
  const endpoint = postPaths.map((match) => {
    try { return new URL(match[1], url); } catch { return null; }
  }).find((candidate) => candidate && candidate.origin === url.origin &&
    candidate.pathname === expectedPath && !candidate.search && !candidate.hash &&
    !candidate.username && !candidate.password);
  if (!/^[A-Za-z0-9_-]+$/.test(fileId) || !endpoint) {
    if (/<title[^>]*>\s*Just a moment|cf-chl-/i.test(html)) throw hostResponseError(res, html);
    throw new Error("No secure direct download link or supported download control found on the file page.");
  }

  let generated;
  try {
    generated = await fetch(endpoint.href, {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "HX-Current-URL": url.href,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "",
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new Error("The host's download-link request failed or redirected unexpectedly. No ad pages were opened. " + err.message);
  }
  const body = await generated.text();
  if (!generated.ok) throw hostResponseError(generated, body);
  // HTMX commonly returns navigation instructions in response headers.
  const redirect = generated.headers.get("HX-Redirect");
  if (redirect) return validateDirectUrl(new URL(redirect, url).href);
  const location = generated.headers.get("HX-Location");
  if (location) {
    let target = location;
    if (location.trim().startsWith("{")) {
      try { target = JSON.parse(location).path; }
      catch { throw new Error("The file host returned an invalid download response."); }
    }
    return validateDirectUrl(new URL(target, url).href);
  }
  const direct = extractSecureDownloadUrl(body);
  if (direct) return direct;
  // Some HTMX integrations deliver the URL as an event payload.
  for (const name of ["HX-Trigger", "HX-Trigger-After-Swap", "HX-Trigger-After-Settle"]) {
    const eventLink = extractSecureDownloadUrl(generated.headers.get(name) || "");
    if (eventLink) return eventLink;
  }
  if (/Just a moment|cf-chl-|cf-turnstile/i.test(body)) throw hostResponseError(generated, body);
  throw new Error("The host's download request succeeded but returned an unsupported response. No ad pages were opened.");
}

/**
 * Start a Chrome download for the given URL and resolve with its downloadId.
 */
function startDownload(dlUrl) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: validateDirectUrl(dlUrl),
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(
            chrome.runtime.lastError ||
              new Error("chrome.downloads.download() failed")
          );
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

/**
 * Ensure we have a session for the given active FitGirl tab.
 */
async function ensureSessionForTab(tab) {
  if (!isSupportedSource(tab?.url)) throw new Error("Please open an HTTPS FitGirl repack page first.");
  await loadSessions();
  await reconcileSessionForTab(tab.id);

  const existing = sessions[tab.id];
  let session = existing ? normalizeSessionShape(existing) : null;
  if (session) {
    sessions[tab.id] = session;
    if (shouldReuseSessionForTab(session, tab)) {
      return session;
    }
  }

  const nextGeneration = session ? getSessionGeneration(session) + 1 : 0;
  return rebuildSessionForTab(tab, nextGeneration);
}

/**
 * Pump the queue for a specific FitGirl URL: start new downloads
 * up to the concurrency limit. Called when a batch starts and whenever
 * a download for that URL completes.
 */
async function pumpQueueForTab(tabId, expectedGeneration) {
  await loadSessions();
  const { concurrency } = await getCurrentSettings();
  await loadDownloadMap();
  // Read current state after all awaits, then reserve slots synchronously.
  const existingSession = sessions[tabId];
  if (!existingSession) return;
  const session = normalizeSessionShape(existingSession);
  sessions[tabId] = session;
  if (!session.hasStarted || !Array.isArray(session.items) || !session.items.length) return;

  const runGeneration =
    expectedGeneration == null ? getSessionGeneration(session) : expectedGeneration;
  if (!isSessionGenerationCurrent(tabId, runGeneration)) return;

  const maxConcurrent = clampConcurrency(concurrency);

  if (session.paused) return;

  const activeCount = session.items.filter(
    (item) => item.state === "starting" || item.state === "downloading"
  ).length;

  let availableSlots = maxConcurrent - activeCount;
  if (availableSlots <= 0) return;

  for (let i = 0; i < session.items.length && availableSlots > 0; i++) {
    const item = getSessionItemForRun(tabId, i, runGeneration);
    if (!item) continue;
    if (item.state !== "queued") continue;

    availableSlots--;
    item.state = "starting";
    item.error = "";

    (async (index, generation) => {
      try {
        const activeItemBeforeFetch = getSessionItemForRun(tabId, index, generation);
        if (!activeItemBeforeFetch || activeItemBeforeFetch.state !== "starting") {
          return;
        }

        const dlUrl = await getDirectDownloadUrl(activeItemBeforeFetch.url);

        const activeItemBeforeDownload = getSessionItemForRun(tabId, index, generation);
        if (!activeItemBeforeDownload || activeItemBeforeDownload.state !== "starting") {
          return;
        }

        if (sessions[tabId].paused) {
          activeItemBeforeDownload.state = "queued";
          await saveSessions();
          broadcastSessionUpdate(tabId);
          return;
        }
        const downloadId = await startDownload(dlUrl);

        const activeItemAfterDownload = getSessionItemForRun(tabId, index, generation);
        if (!activeItemAfterDownload || activeItemAfterDownload.state !== "starting") {
          try {
            chrome.downloads.cancel(downloadId);
          } catch (e) {
            // ignore
          }
          return;
        }

        activeItemAfterDownload.downloadId = downloadId;
        activeItemAfterDownload.state = "downloading";
        downloadIdToKey.set(downloadId, { tabId, index, generation });
        // Pause may arrive while Chrome is creating the download.
        if (sessions[tabId].paused) {
          await chrome.downloads.pause(downloadId);
          const current = getSessionItemForRun(tabId, index, generation);
          if (current) current.state = "paused";
        }
        await Promise.all([saveSessions(), saveDownloadMap()]);
        broadcastSessionUpdate(tabId);
      } catch (err) {
        const activeItemOnError = getSessionItemForRun(tabId, index, generation);
        if (!activeItemOnError) return;
        console.warn("Failed to start FuckingFast URL:", activeItemOnError.url, err);
        activeItemOnError.state = err.code === "HOST_VERIFICATION" ? "queued" : "error";
        if (err.code === "HOST_VERIFICATION") sessions[tabId].paused = true;
        activeItemOnError.error = err.message || String(err);
        activeItemOnError.downloadId = null;
        await saveSessions();
        broadcastSessionUpdate(tabId);
        pumpQueueForTab(tabId, generation);
      }
    })(i, runGeneration);
  }
}

// Track completion of underlying Chrome downloads
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !delta.state.current) return;

  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  (async () => {
    await loadDownloadMap();
    const key = downloadIdToKey.get(delta.id);
    if (!key) return;

    await loadSessions();
    const existingSession = sessions[key.tabId];
    if (!existingSession) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }
    const session = normalizeSessionShape(existingSession);
    sessions[key.tabId] = session;
    if (!isSessionGenerationCurrent(key.tabId, key.generation)) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }
    if (!session || !session.items || !session.items[key.index]) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }

    const item = session.items[key.index];
    downloadIdToKey.delete(delta.id);
    item.downloadId = null;
    if (state === "complete") {
      item.state = "completed";
    } else {
      item.state = delta.error?.current === "USER_CANCELED" ? "cancelled" : "error";
    }
    await Promise.all([saveSessions(), saveDownloadMap()]);
    broadcastSessionUpdate(key.tabId);
    // Try to start the next queued download
    pumpQueueForTab(key.tabId, key.generation);
  })();
});

// Clean up tab-scoped sessions when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await loadSessions();
    if (sessions[tabId]) {
      delete sessions[tabId];
      await saveSessions();
    }

    await loadDownloadMap();
    let changed = false;
    for (const [downloadId, key] of Array.from(downloadIdToKey.entries())) {
      if (key.tabId === tabId) {
        downloadIdToKey.delete(downloadId);
        changed = true;
      }
    }
    if (changed) {
      await saveDownloadMap();
    }
  })();
});

// Message-based API for popup UIs
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "scan_current_tab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab || !tab.id || !isSupportedSource(tab.url)) {
          sendResponse({
            ok: false,
            error: "Please open a FitGirl repack page first."
          });
          return;
        }

        const sess = await ensureSessionForTab(tab);
        sendResponse({ ok: true, session: sess, tabId: tab.id });
      } catch (err) {
        console.error("scan_current_tab failed:", err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep channel open for async response
  }

  if (message.type === "start_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }

        const tabId = tab.id;
        const session = normalizeSessionShape(await ensureSessionForTab(tab));
        sessions[tabId] = session;

        if (hasActiveItems(session)) {
          throw new Error("A batch is already running. Cancel it before starting another.");
        }

        const selectedUrls = new Set(
          (message.items || [])
            .map((i) => i.url)
            .filter((u) => typeof u === "string" && u.length)
        );

        if (!selectedUrls.size) {
          sendResponse({
            ok: false,
            error: "No files selected for download."
          });
          return;
        }

        const candidateLinks =
          Array.isArray(session.allItems) && session.allItems.length
            ? session.allItems
            : (session.items || []).map((item) => ({
                url: item.url,
                label: item.label || item.url
              }));

        const selectedItems = candidateLinks
          .filter((item) => selectedUrls.has(item.url))
          .map(toQueuedItem);

        if (!selectedItems.length) {
          sendResponse({
            ok: false,
            error: "Selected files were not found in the current page scan."
          });
          return;
        }

        // Start a new run generation to invalidate any stale async workers.
        session.generation = getSessionGeneration(session) + 1;
        const runGeneration = session.generation;
        session.items = selectedItems;
        session.hasStarted = true;
        session.paused = false;

        // Clear mapping entries for this tab
        await loadDownloadMap();
        for (const [downloadId, key] of Array.from(downloadIdToKey.entries())) {
          if (key.tabId === tabId) {
            downloadIdToKey.delete(downloadId);
          }
        }
        sessions[tabId] = session;
        await Promise.all([saveSessions(), saveDownloadMap()]);
        broadcastSessionUpdate(tabId);

        // Start the queue pump for this tab (will respect concurrency limit)
        pumpQueueForTab(tabId, runGeneration);

        sendResponse({ ok: true });
      } catch (err) {
        console.error("start_downloads failed:", err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "get_settings") {
    (async () => {
      try {
        const current = await getCurrentSettings();
        sendResponse({ ok: true, settings: current });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "save_settings") {
    const newConcurrency = clampConcurrency(message?.settings?.concurrency);
    chrome.storage.sync.set(
      { concurrency: newConcurrency },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message
          });
        } else {
          sendResponse({
            ok: true,
            settings: { concurrency: newConcurrency }
          });
          for (const tabId of Object.keys(sessions)) {
            pumpQueueForTab(Number(tabId)).catch(console.error);
          }
        }
      }
    );
    return true;
  }

  if (message.type === "get_session") {
    (async () => {
      try {
        await loadSessions();
        sendResponse({ ok: true, sessions });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "cancel_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        // Invalidate current run first so in-flight workers stop mutating state.
        session.generation = getSessionGeneration(session) + 1;
        session.hasStarted = false;
        session.paused = false;

        // Cancel all active and queued downloads
        await loadDownloadMap();
        for (let i = 0; i < session.items.length; i++) {
          const item = session.items[i];
          if (item.downloadId != null) {
            try {
              chrome.downloads.cancel(item.downloadId);
            } catch (e) {
              // ignore
            }
            downloadIdToKey.delete(item.downloadId);
            item.downloadId = null;
          }
          if (ACTIVE_ITEM_STATES.has(item.state)) {
            item.state = "cancelled";
          }
        }
        sessions[tabId] = session;
        await Promise.all([saveSessions(), saveDownloadMap()]);

        // Rebuild immediately for the current page so popup opens into fresh
        // detection state without requiring a manual reset action.
        if (isSupportedSource(tab.url)) {
          const refreshed = await rebuildSessionForTab(tab, session.generation);
          sessions[tabId] = refreshed;
        }

        broadcastSessionUpdate(tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "pause_downloads" || message.type === "resume_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        const shouldPause = message.type === "pause_downloads";
        session.paused = shouldPause;

        for (let i = 0; i < session.items.length; i++) {
          const item = session.items[i];
          if (item.downloadId == null) continue;

          try {
            if (shouldPause && item.state === "downloading") {
              chrome.downloads.pause(item.downloadId);
              item.state = "paused";
            } else if (!shouldPause && item.state === "paused") {
              chrome.downloads.resume(item.downloadId);
              item.state = "downloading";
            }
          } catch (e) {
            // ignore
          }
        }

        sessions[tabId] = session;
        await saveSessions();
        broadcastSessionUpdate(tabId);

        if (!shouldPause) {
          pumpQueueForTab(tabId);
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "retry_failed") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({ ok: false, error: "No active FitGirl tab found." });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        let requeued = 0;
        for (const item of session.items) {
          if (item.state === "error") {
            item.state = "queued";
            item.downloadId = null;
            requeued++;
          }
        }

        if (requeued > 0) {
          session.generation = getSessionGeneration(session) + 1;
          const runGeneration = session.generation;
          session.hasStarted = true;
          session.paused = false;
          sessions[tabId] = session;
          await saveSessions();
          broadcastSessionUpdate(tabId);
          pumpQueueForTab(tabId, runGeneration);
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
