// FitGirl FuckingFast Batch Downloader - background service worker (MV3)

// Default maximum number of FuckingFast links we will actively process at once
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

function swapProtocol(url) {
  if (url.startsWith("https://")) return url.replace("https://", "http://");
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

// In-memory sessions keyed by Chrome tab ID
// sessions[tabId] = { tabId, sourceUrl, hasStarted, items: [{ url, label, state, downloadId|null }] }
let sessions = {};
let sessionsLoaded = false;

// Map downloadId -> { tabId, index } into sessions[tabId].items
let downloadIdToKey = new Map();
let downloadMapLoaded = false;

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

  const samePage =
    normalizeSessionUrl(session.sourceUrl) === normalizeSessionUrl(tab?.url);

  if (samePage) {
    return true;
  }

  // Once a batch has been started for a tab, keep showing that tab-scoped
  // batch state even if the user navigates elsewhere in the same tab.
  return session.hasStarted === true;
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
    world: "MAIN",
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

/**
 * Given a FuckingFast landing URL, fetch its HTML and extract the
 * underlying direct /dl/... URL that the page's download() function
 * would open.
 */
async function getDirectDownloadUrl(fuckingFastUrl) {
  const attempts = [fuckingFastUrl, swapProtocol(fuckingFastUrl)];
  let lastError;

  for (const url of attempts) {
    try {
      const res = await fetch(url, { credentials: "include" });

      if (!res.ok) {
        lastError = new Error(
          `Failed to fetch FuckingFast page (${res.status} ${res.statusText})`
        );
        continue;
      }

      const html = await res.text();

      const match = html.match(/https?:\/\/fuckingfast\.co\/dl\/[^"]+/);
      if (!match) {
        lastError = new Error("Direct /dl/ URL not found in FuckingFast page HTML");
        continue;
      }

      return match[0];
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/**
 * Start a Chrome download for the given URL and resolve with its downloadId.
 */
function startDownload(dlUrl) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dlUrl,
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
  await loadSessions();

  let session = sessions[tab.id];
  if (shouldReuseSessionForTab(session, tab)) {
    return session;
  }

  // Need to create a new session for this URL
  const { title, items } = await extractFuckingFastLinks(tab.id);
  if (!items.length) {
    session = {
      tabId: tab.id,
      sourceUrl: tab.url,
      title,
      hasStarted: false,
      items: []
    };
    sessions[tab.id] = session;
    await saveSessions();
    return session;
  }

  session = {
    tabId: tab.id,
    sourceUrl: tab.url,
    title,
    hasStarted: false,
    paused: false,
    items: items.map((l) => ({
      url: l.url,
      label: l.label,
      state: "queued",
      downloadId: null
    }))
  };
  sessions[tab.id] = session;
  await saveSessions();
  return session;
}

/**
 * Pump the queue for a specific FitGirl URL: start new downloads
 * up to the concurrency limit. Called when a batch starts and whenever
 * a download for that URL completes.
 */
async function pumpQueueForTab(tabId) {
  await loadSessions();
  const session = sessions[tabId];
  if (!session || !Array.isArray(session.items) || !session.items.length) return;

  const { concurrency } = await getCurrentSettings();
  const maxConcurrent = clampConcurrency(concurrency);

  if (session.paused) return;

  const activeCount = session.items.filter(
    (item) => item.state === "downloading"
  ).length;

  let availableSlots = maxConcurrent - activeCount;
  if (availableSlots <= 0) return;

  for (let i = 0; i < session.items.length && availableSlots > 0; i++) {
    const item = session.items[i];
    if (item.state !== "queued") continue;

    availableSlots--;
    item.state = "downloading";

    (async (index) => {
      try {
        const dlUrl = await getDirectDownloadUrl(item.url);
        let downloadId;
        try {
          downloadId = await startDownload(dlUrl);
        } catch (dlErr) {
          const altUrl = swapProtocol(dlUrl);
          console.warn("Download failed, retrying with", altUrl, dlErr);
          downloadId = await startDownload(altUrl);
        }
        item.downloadId = downloadId;
        await loadDownloadMap();
        downloadIdToKey.set(downloadId, { tabId, index });
        await Promise.all([saveSessions(), saveDownloadMap()]);
        broadcastSessionUpdate(tabId);
      } catch (err) {
        console.warn("Failed to start FuckingFast URL:", item.url, err);
        item.state = "error";
        item.downloadId = null;
        await saveSessions();
        broadcastSessionUpdate(tabId);
        pumpQueueForTab(tabId);
      }
    })(i);
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
    const session = sessions[key.tabId];
    if (!session || !session.items || !session.items[key.index]) {
      downloadIdToKey.delete(delta.id);
      return;
    }

    const item = session.items[key.index];
    downloadIdToKey.delete(delta.id);
    item.downloadId = null;
    item.state = state === "complete" ? "completed" : "error";
    await Promise.all([saveSessions(), saveDownloadMap()]);
    broadcastSessionUpdate(key.tabId);
    // Try to start the next queued download
    pumpQueueForTab(key.tabId);
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

        if (!tab || !tab.id || !tab.url?.includes("fitgirl-repacks.site")) {
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
        const session = await ensureSessionForTab(tab);

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

        // Keep only selected items and reset their state to queued
        session.items =
          session.items?.filter((item) => selectedUrls.has(item.url)) || [];
        session.hasStarted = true;
        session.paused = false;

        for (const item of session.items) {
          item.state =
            item.state === "completed" || item.state === "error"
              ? item.state
              : "queued";
          item.downloadId = null;
        }

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
        pumpQueueForTab(tabId);

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
        const session = sessions[tabId];
        if (!session) {
          sendResponse({ ok: true });
          return;
        }

        // Cancel all active and queued downloads
        for (let i = 0; i < session.items.length; i++) {
          const item = session.items[i];
          if (item.downloadId != null) {
            try {
              chrome.downloads.cancel(item.downloadId);
            } catch (e) {
              // ignore
            }
            await loadDownloadMap();
            downloadIdToKey.delete(item.downloadId);
            item.downloadId = null;
          }
          if (item.state === "queued" || item.state === "downloading") {
            item.state = "cancelled";
          }
        }
        session.hasStarted = false;
        session.paused = false;
        sessions[tabId] = session;
        await Promise.all([saveSessions(), saveDownloadMap()]);
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
        const session = sessions[tabId];
        if (!session) {
          sendResponse({ ok: true });
          return;
        }

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
        const session = sessions[tabId];
        if (!session) {
          sendResponse({ ok: true });
          return;
        }

        let requeued = 0;
        for (const item of session.items) {
          if (item.state === "error") {
            item.state = "queued";
            item.downloadId = null;
            requeued++;
          }
        }

        if (requeued > 0) {
          session.hasStarted = true;
          session.paused = false;
          sessions[tabId] = session;
          await saveSessions();
          broadcastSessionUpdate(tabId);
          pumpQueueForTab(tabId);
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
