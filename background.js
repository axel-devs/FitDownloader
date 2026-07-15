// FitDownloader — background service worker (MV3)

importScripts("idb-fs.js");

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;
const RESOLVE_GAP_MS = 1100;
const RETRY_429_MS = 6000;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "downloading", "paused"]);

let sessions = {};
let sessionsLoaded = false;
let lastResolveAt = 0;
let resolveChain = Promise.resolve();
let offscreenCreating = null;

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHttps(url) {
  if (typeof url !== "string" || !url.length) return url;
  return url.replace(/^http:\/\//i, "https://");
}

async function getCurrentSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { concurrency: clampConcurrency(stored.concurrency) };
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
  return {
    url: toHttps(link.url),
    label: typeof link.label === "string" && link.label.length ? link.label : link.url
  };
}

function toQueuedItem(link) {
  return {
    url: link.url,
    label: link.label || link.url,
    state: "queued",
    jobId: null,
    bytesWritten: 0,
    directUrl: null,
    error: null
  };
}

function normalizeSessionItem(item) {
  const link = normalizeLink(item);
  if (!link) return null;
  return {
    url: link.url,
    label: link.label,
    state: typeof item?.state === "string" ? item.state : "queued",
    jobId: typeof item?.jobId === "string" ? item.jobId : null,
    bytesWritten: Number.isFinite(item?.bytesWritten) ? item.bytesWritten : 0,
    directUrl: typeof item?.directUrl === "string" ? item.directUrl : null,
    error: typeof item?.error === "string" ? item.error : null
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
      destinationName: "",
      failedUrls: [],
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

  const failedUrls = Array.isArray(session.failedUrls)
    ? session.failedUrls.filter((u) => typeof u === "string" && u.length)
    : [];

  return {
    ...session,
    sourceUrl: typeof session.sourceUrl === "string" ? session.sourceUrl : "",
    title: typeof session.title === "string" ? session.title : "",
    hasStarted: session.hasStarted === true,
    paused: session.paused === true,
    generation: Number.isInteger(session.generation) ? session.generation : 0,
    destinationName:
      typeof session.destinationName === "string" ? session.destinationName : "",
    failedUrls,
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

function restoreSelectionItems(session, { captureFailures = false } = {}) {
  if (captureFailures && Array.isArray(session.items)) {
    session.failedUrls = session.items
      .filter((item) => item.state === "error" || item.state === "cancelled")
      .map((item) => item.url);
  }

  const links =
    Array.isArray(session.allItems) && session.allItems.length
      ? session.allItems
      : (session.items || []).map((item) => ({
          url: item.url,
          label: item.label
        }));
  session.items = links.map(toQueuedItem);
  session.hasStarted = false;
  session.paused = false;
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

  if (activeRun) return true;
  if (!session.hasStarted && samePage) return true;
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

function createSessionFromExtractedLinks(tab, title, links, generation, destinationName) {
  const allItems = Array.isArray(links) ? links.map(normalizeLink).filter(Boolean) : [];
  return normalizeSessionShape({
    tabId: tab.id,
    sourceUrl: tab.url,
    title: title || "",
    hasStarted: false,
    paused: false,
    generation,
    destinationName: destinationName || "",
    failedUrls: [],
    allItems,
    items: allItems.map(toQueuedItem)
  });
}

function broadcastSessionUpdate(tabId) {
  const session = sessions[tabId];
  if (!session) return;
  try {
    chrome.runtime.sendMessage({ type: "session_updated", tabId, session }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // ignore
  }
}

async function ensureOffscreenDocument() {
  const path = "offscreen.html";

  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(path)]
    });
    if (existing && existing.length) return;
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: path,
      reasons: ["BLOBS"],
      justification:
        "Write FitGirl downloads into the user-chosen folder via File System Access."
    })
    .catch((err) => {
      const msg = err?.message || String(err);
      if (/already exists/i.test(msg)) return;
      throw err;
    });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

/**
 * Extract all FuckingFast links from the current FitGirl page.
 */
async function extractFuckingFastLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const rawTitle = document.title || "";
      const title = rawTitle.replace(/ - FitGirl Repacks.*/i, "").trim();

      const containers = [
        document.querySelector(".entry-content"),
        document.querySelector(".post"),
        document.body
      ].filter(Boolean);

      const items = [];

      for (const container of containers) {
        const anchors = container.querySelectorAll(
          'a[href*="fuckingfast.co/"]'
        );
        anchors.forEach((a) => {
          if (!a.href) return;
          try {
            const u = new URL(a.href);
            if (!/(^|\.)fuckingfast\.co$/i.test(u.hostname)) return;
            u.protocol = "https:";
            const label = a.textContent.trim() || u.href;
            items.push({ url: u.toString(), label });
          } catch (e) {
            // skip bad hrefs
          }
        });
        if (items.length > 0 && container !== document.body) break;
      }

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

function extractDirectUrlFromHtml(html) {
  if (!html) return null;
  const legacyOpen = html.match(
    /window\.open\(\s*["'](https:\/\/(?:dl\.)?fuckingfast\.co\/dl\/[^"']+)["']/i
  );
  if (legacyOpen?.[1]) return legacyOpen[1];

  const bareDl = html.match(
    /https:\/\/(?:dl\.)?fuckingfast\.co\/dl\/[^\s"'<>\\]+/i
  );
  return bareDl?.[0] || null;
}

function extractHxEndpoint(html, pageUrl) {
  const hx = html.match(/hx-(post|get)=["']([^"']+)["']/i);
  if (hx) {
    return { method: hx[1].toLowerCase(), path: hx[2] };
  }
  try {
    const u = new URL(pageUrl);
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id) return { method: "post", path: `/f/${id}/go` };
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Resolve a FuckingFast landing page to the real download URL.
 * Supports legacy window.open(/dl/...) and current HTMX hx-post="/f/{id}/go".
 */
async function getDirectDownloadUrl(fuckingFastUrl) {
  const pageUrl = toHttps(fuckingFastUrl);
  const res = await fetch(pageUrl, {
    credentials: "include",
    redirect: "follow"
  });

  if (res.status === 429) {
    const err = new Error("FuckingFast rate limited (429)");
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch FuckingFast page (${res.status} ${res.statusText})`);
  }

  const html = await res.text();
  const fromHtml = extractDirectUrlFromHtml(html);
  if (fromHtml) return toHttps(fromHtml);

  const endpoint = extractHxEndpoint(html, pageUrl);
  if (!endpoint) {
    throw new Error("No /dl/ URL or HTMX /go endpoint found on FuckingFast page");
  }

  const endpointUrl = new URL(endpoint.path, pageUrl).toString();
  const headers = {
    "HX-Request": "true",
    "HX-Current-URL": pageUrl,
    Referer: pageUrl
  };

  const apiRes = await fetch(endpointUrl, {
    method: endpoint.method === "get" ? "GET" : "POST",
    credentials: "include",
    redirect: "manual",
    headers
  });

  if (apiRes.status === 429) {
    const err = new Error("FuckingFast rate limited (429) on /go");
    err.status = 429;
    throw err;
  }

  const redirect =
    apiRes.headers.get("HX-Redirect") ||
    apiRes.headers.get("hx-redirect") ||
    apiRes.headers.get("Location") ||
    apiRes.headers.get("location");

  if (redirect) {
    return toHttps(new URL(redirect, endpointUrl).toString());
  }

  const body = await apiRes.text();
  const fromBody = extractDirectUrlFromHtml(body);
  if (fromBody) return toHttps(fromBody);

  throw new Error("Direct download URL not found after HTMX /go request");
}

function rateLimitedResolve(url) {
  const run = async () => {
    const wait = RESOLVE_GAP_MS - (Date.now() - lastResolveAt);
    if (wait > 0) await sleep(wait);
    lastResolveAt = Date.now();

    try {
      return await getDirectDownloadUrl(url);
    } catch (err) {
      if (err?.status === 429) {
        await sleep(RETRY_429_MS);
        lastResolveAt = Date.now();
        return await getDirectDownloadUrl(url);
      }
      throw err;
    }
  };

  const next = resolveChain.then(run, run);
  resolveChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function rebuildSessionForTab(tab, generation) {
  const { title, items } = await extractFuckingFastLinks(tab.id);
  let destinationName = "";
  try {
    const handle = await loadDirectoryHandle(tab.id);
    if (handle) destinationName = handle.name || "";
  } catch (e) {
    // ignore
  }
  const rebuilt = createSessionFromExtractedLinks(
    tab,
    title,
    items,
    generation,
    destinationName
  );
  sessions[tab.id] = rebuilt;
  await saveSessions();
  return rebuilt;
}

async function ensureSessionForTab(tab) {
  await loadSessions();

  const existing = sessions[tab.id];
  let session = existing ? normalizeSessionShape(existing) : null;
  if (session) {
    sessions[tab.id] = session;
    if (session.hasStarted && !hasActiveItems(session)) {
      restoreSelectionItems(session);
      await saveSessions();
    }
    if (shouldReuseSessionForTab(session, tab)) {
      return session;
    }
  }

  const nextGeneration = session ? getSessionGeneration(session) + 1 : 0;
  return rebuildSessionForTab(tab, nextGeneration);
}

function makeJobId(tabId, index, generation) {
  return `${tabId}:${generation}:${index}:${Date.now()}`;
}

async function startOffscreenDownload(tabId, index, generation, item) {
  await ensureOffscreenDocument();
  const jobId = makeJobId(tabId, index, generation);
  item.jobId = jobId;
  item.state = "downloading";
  item.error = null;
  await saveSessions();
  broadcastSessionUpdate(tabId);

  chrome.runtime.sendMessage({
    type: "offscreen_start_download",
    jobId,
    tabId,
    index,
    generation,
    url: item.directUrl,
    resumeFrom: item.bytesWritten || 0,
    item: { url: item.url, label: item.label }
  }, () => {
    void chrome.runtime.lastError;
  });
}

async function pumpQueueForTab(tabId, expectedGeneration) {
  await loadSessions();
  const existingSession = sessions[tabId];
  if (!existingSession) return;
  const session = normalizeSessionShape(existingSession);
  sessions[tabId] = session;
  if (!session?.items?.length) return;

  if (!session.hasStarted) return;

  const runGeneration =
    expectedGeneration == null ? getSessionGeneration(session) : expectedGeneration;
  if (!isSessionGenerationCurrent(tabId, runGeneration)) return;
  if (session.paused) return;

  const { concurrency } = await getCurrentSettings();
  const maxConcurrent = clampConcurrency(concurrency);

  const activeCount = session.items.filter(
    (item) => item.state === "starting" || item.state === "downloading"
  ).length;

  let availableSlots = maxConcurrent - activeCount;
  if (availableSlots <= 0) return;

  const handle = await loadDirectoryHandle(tabId);
  if (!handle) {
    for (const item of session.items) {
      if (item.state === "queued") {
        item.state = "error";
        item.error = "No destination folder selected.";
      }
    }
    session.hasStarted = false;
    await saveSessions();
    broadcastSessionUpdate(tabId);
    return;
  }

  for (let i = 0; i < session.items.length && availableSlots > 0; i++) {
    const item = getSessionItemForRun(tabId, i, runGeneration);
    if (!item || item.state !== "queued") continue;

    availableSlots--;
    item.state = "starting";
    item.error = null;
    await saveSessions();
    broadcastSessionUpdate(tabId);

    (async (index, generation) => {
      try {
        const before = getSessionItemForRun(tabId, index, generation);
        if (!before || before.state !== "starting") return;

        let dlUrl = before.directUrl;
        if (!dlUrl) {
          dlUrl = await rateLimitedResolve(before.url);
        }

        const mid = getSessionItemForRun(tabId, index, generation);
        if (!mid || mid.state !== "starting") return;

        mid.directUrl = dlUrl;
        await startOffscreenDownload(tabId, index, generation, mid);
      } catch (err) {
        const onError = getSessionItemForRun(tabId, index, generation);
        if (!onError) return;
        console.warn("Failed to start FuckingFast URL:", onError.url, err);
        onError.state = "error";
        onError.jobId = null;
        onError.error = err?.message || String(err);
        await saveSessions();
        broadcastSessionUpdate(tabId);
        pumpQueueForTab(tabId, generation);
      }
    })(i, runGeneration);
  }
}

function finishRunIfIdle(tabId) {
  const session = sessions[tabId];
  if (!session) return false;
  if (!session.hasStarted) return false;
  if (hasActiveItems(session)) return false;
  session.generation = getSessionGeneration(session) + 1;
  restoreSelectionItems(session, { captureFailures: true });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "offscreen_download_done") {
    (async () => {
      await loadSessions();
      const { tabId, index, jobId } = message;
      const session = sessions[tabId];
      if (!session?.items?.[index]) return;
      const item = session.items[index];
      if (item.jobId && jobId && item.jobId !== jobId) return;

      item.state = "completed";
      item.jobId = null;
      item.error = null;
      const runFinished = finishRunIfIdle(tabId);
      await saveSessions();
      broadcastSessionUpdate(tabId);
      if (!runFinished) {
        pumpQueueForTab(tabId, getSessionGeneration(session));
      }
    })();
    return;
  }

  if (message.type === "offscreen_download_failed") {
    (async () => {
      await loadSessions();
      const { tabId, index, jobId, paused, cancelled, status, error } = message;
      const session = sessions[tabId];
      if (!session?.items?.[index]) return;
      const item = session.items[index];
      if (item.jobId && jobId && item.jobId !== jobId) return;

      item.jobId = null;
      if (paused || (session.paused && cancelled)) {
        item.state = "paused";
      } else if (cancelled) {
        item.state = "cancelled";
      } else {
        item.state = "error";
        item.error = error || "Download failed";
        if (status === 429) {
          item.error = "Rate limited (429). Retry later.";
        }
      }

      const runFinished = finishRunIfIdle(tabId);
      await saveSessions();
      broadcastSessionUpdate(tabId);
      if (!runFinished && !session.paused && item.state === "error") {
        pumpQueueForTab(tabId, getSessionGeneration(session));
      }
    })();
    return;
  }

  if (message.type === "set_destination") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, error: "No active tab." });
          return;
        }
        await loadSessions();
        const session = normalizeSessionShape(
          sessions[tab.id] || (await ensureSessionForTab(tab))
        );
        session.destinationName =
          typeof message.name === "string" ? message.name : "";
        sessions[tab.id] = session;
        await saveSessions();
        broadcastSessionUpdate(tab.id);
        sendResponse({ ok: true, session });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "scan_current_tab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab?.id || !tab.url?.includes("fitgirl-repacks.site")) {
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
    return true;
  }

  if (message.type === "start_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab?.url) {
          sendResponse({ ok: false, error: "No active FitGirl tab found." });
          return;
        }

        const tabId = tab.id;
        const session = normalizeSessionShape(await ensureSessionForTab(tab));
        sessions[tabId] = session;

        const handle = await loadDirectoryHandle(tabId);
        if (!handle) {
          sendResponse({
            ok: false,
            error: "Choose a destination folder first."
          });
          return;
        }

        const selectedUrls = new Set(
          (message.items || [])
            .map((i) => i.url)
            .filter((u) => typeof u === "string" && u.length)
        );

        if (!selectedUrls.size) {
          sendResponse({ ok: false, error: "No files selected for download." });
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

        session.generation = getSessionGeneration(session) + 1;
        const runGeneration = session.generation;
        session.items = selectedItems;
        session.hasStarted = true;
        session.paused = false;
        session.failedUrls = [];
        if (!session.destinationName && handle.name) {
          session.destinationName = handle.name;
        }
        sessions[tabId] = session;
        await saveSessions();
        broadcastSessionUpdate(tabId);

        await ensureOffscreenDocument();
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
    chrome.storage.sync.set({ concurrency: newConcurrency }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, settings: { concurrency: newConcurrency } });
      }
    });
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
        if (!tab?.url) {
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

        for (const item of session.items) {
          if (item.jobId) {
            chrome.runtime.sendMessage({
              type: "offscreen_cancel_job",
              jobId: item.jobId
            }, () => { void chrome.runtime.lastError; });
          }
          if (ACTIVE_ITEM_STATES.has(item.state)) {
            item.state = "cancelled";
          }
          item.jobId = null;
        }

        session.generation = getSessionGeneration(session) + 1;
        restoreSelectionItems(session);
        sessions[tabId] = session;
        await saveSessions();

        if (tab.url?.includes("fitgirl-repacks.site")) {
          const destName = session.destinationName;
          const refreshed = await rebuildSessionForTab(tab, session.generation);
          refreshed.destinationName = destName;
          sessions[tabId] = refreshed;
          await saveSessions();
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
        if (!tab?.url) {
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
        const shouldPause = message.type === "pause_downloads";
        session.paused = shouldPause;

        if (shouldPause) {
          for (const item of session.items) {
            if (item.state === "downloading" && item.jobId) {
              chrome.runtime.sendMessage({
                type: "offscreen_pause_job",
                jobId: item.jobId
              }, () => { void chrome.runtime.lastError; });
              item.state = "paused";
            } else if (item.state === "starting") {
              item.state = "paused";
              item.jobId = null;
            }
          }
        } else {
          for (const item of session.items) {
            if (item.state === "paused") {
              item.state = "queued";
              item.jobId = null;
            }
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
        if (!tab?.url) {
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

        const failedSet = new Set(
          (session.failedUrls || []).filter((u) => typeof u === "string")
        );
        for (const item of session.items) {
          if (item.state === "error" || item.state === "cancelled") {
            failedSet.add(item.url);
          }
        }

        if (!failedSet.size) {
          sendResponse({ ok: true });
          return;
        }

        const candidateLinks =
          Array.isArray(session.allItems) && session.allItems.length
            ? session.allItems
            : session.items.map((item) => ({
                url: item.url,
                label: item.label || item.url
              }));

        const retryItems = candidateLinks
          .filter((link) => failedSet.has(link.url))
          .map(toQueuedItem);

        if (!retryItems.length) {
          sendResponse({ ok: true });
          return;
        }

        session.generation = getSessionGeneration(session) + 1;
        session.items = retryItems;
        session.failedUrls = [];
        session.hasStarted = true;
        session.paused = false;
        sessions[tabId] = session;
        await saveSessions();
        broadcastSessionUpdate(tabId);
        pumpQueueForTab(tabId, session.generation);

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await loadSessions();
    const session = sessions[tabId];
    if (session?.items) {
      for (const item of session.items) {
        if (item.jobId) {
          chrome.runtime.sendMessage({
            type: "offscreen_cancel_job",
            jobId: item.jobId
          }, () => { void chrome.runtime.lastError; });
        }
      }
    }
    if (sessions[tabId]) {
      delete sessions[tabId];
      await saveSessions();
    }
    try {
      await clearDirectoryHandle(tabId);
    } catch (e) {
      // ignore
    }
  })();
});
