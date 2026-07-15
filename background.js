// FitDownloader — background service worker (MV3)

importScripts("idb-fs.js");

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;
const RESOLVE_GAP_MS = 1100;
const RETRY_429_MS = 6000;
const RECONCILE_ALARM = "fitdl-reconcile";
const KEEPALIVE_ALARM = "fitdl-keepalive";
const STALL_TIMEOUT_MS = 45000;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "downloading"]);

let sessions = {};
let tabSessionMap = {};
let downloadingBlocked = false;
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

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getCurrentSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { concurrency: clampConcurrency(stored.concurrency) };
}

async function loadSessions() {
  if (sessionsLoaded) return;
  const stored = await chrome.storage.local.get(["ffSessions", "ffTabSessionMap", "ffBlocked"]);
  if (stored.ffSessions && typeof stored.ffSessions === "object") {
    sessions = stored.ffSessions;
  }
  if (stored.ffTabSessionMap && typeof stored.ffTabSessionMap === "object") {
    tabSessionMap = stored.ffTabSessionMap;
  }
  downloadingBlocked = stored.ffBlocked === true;

  // migrate old format: sessions keyed by tabId (numeric-looking keys, no .id field)
  const keys = Object.keys(sessions);
  let migrated = false;
  for (const key of keys) {
    const s = sessions[key];
    if (s && !s.id && /^\d+$/.test(key)) {
      const newId = generateSessionId();
      s.id = newId;
      s.tabId = Number(key);
      if (!Array.isArray(s.completedUrls)) s.completedUrls = [];
      sessions[newId] = normalizeSessionShape(s);
      tabSessionMap[key] = newId;
      delete sessions[key];
      migrated = true;
    }
  }
  if (migrated) {
    await saveSessions();
  }

  sessionsLoaded = true;
}

async function saveSessions() {
  await chrome.storage.local.set({
    ffSessions: sessions,
    ffTabSessionMap: tabSessionMap,
    ffBlocked: downloadingBlocked
  });
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
    totalBytes: -1,
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
    totalBytes: Number.isFinite(item?.totalBytes) ? item.totalBytes : -1,
    directUrl: typeof item?.directUrl === "string" ? item.directUrl : null,
    error: typeof item?.error === "string" ? item.error : null
  };
}

function normalizeSessionShape(session) {
  if (!session || typeof session !== "object") {
    return {
      id: generateSessionId(),
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

  let completedUrls = Array.isArray(session.completedUrls)
    ? session.completedUrls.filter((u) => typeof u === "string" && u.length)
    : [];

  // migrate: pick up completed items from a run in progress (handles old sessions)
  if (Array.isArray(session.items)) {
    const existing = new Set(completedUrls);
    for (const item of session.items) {
      if (item?.state === "completed" && item?.url && !existing.has(item.url)) {
        completedUrls.push(item.url);
        existing.add(item.url);
      }
    }
  }

  return {
    ...session,
    id: session.id || generateSessionId(),
    sourceUrl: typeof session.sourceUrl === "string" ? session.sourceUrl : "",
    title: typeof session.title === "string" ? session.title : "",
    hasStarted: session.hasStarted === true,
    paused: false,
    generation: Number.isInteger(session.generation) ? session.generation : 0,
    destinationName:
      typeof session.destinationName === "string" ? session.destinationName : "",
    failedUrls,
    completedUrls,
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
  if (!Array.isArray(session.completedUrls)) session.completedUrls = [];

  if (captureFailures && Array.isArray(session.items)) {
    session.failedUrls = session.items
      .filter((item) => item.state === "error" || item.state === "cancelled")
      .map((item) => item.url);

    const newlyCompleted = session.items
      .filter((item) => item.state === "completed")
      .map((item) => item.url);
    const existing = new Set(session.completedUrls);
    for (const url of newlyCompleted) {
      if (!existing.has(url)) session.completedUrls.push(url);
    }
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

function getSessionById(sessionId) {
  return sessions[sessionId] || null;
}

function getSessionForTab(tabId) {
  const sessionId = tabSessionMap[tabId];
  if (!sessionId) return null;
  return sessions[sessionId] || null;
}

function findSessionBySourceUrl(url) {
  const normalized = normalizeSessionUrl(url);
  if (!normalized) return null;
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (normalizeSessionUrl(s.sourceUrl) === normalized) return s;
  }
  return null;
}

function shouldReuseSession(session, tabUrl) {
  if (!session) return false;
  const activeRun = hasActiveItems(session);
  const samePage =
    normalizeSessionUrl(session.sourceUrl) === normalizeSessionUrl(tabUrl);

  if (activeRun) return true;
  if (!session.hasStarted && samePage) return true;
  return false;
}

function isSessionGenerationCurrent(sessionId, generation) {
  const session = sessions[sessionId];
  if (!session) return false;
  return getSessionGeneration(session) === generation;
}

function getSessionItemForRun(sessionId, index, generation) {
  if (!isSessionGenerationCurrent(sessionId, generation)) return null;
  const session = sessions[sessionId];
  if (!session || !Array.isArray(session.items) || !session.items[index]) {
    return null;
  }
  return session.items[index];
}

function createSessionFromExtractedLinks(tab, title, links, generation, destinationName) {
  const allItems = Array.isArray(links) ? links.map(normalizeLink).filter(Boolean) : [];
  const sessionId = generateSessionId();
  return normalizeSessionShape({
    id: sessionId,
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

function broadcastSessionUpdate(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;
  try {
    chrome.runtime.sendMessage({ type: "session_updated", sessionId, session }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // ignore
  }
}

function updateBadge() {
  if (downloadingBlocked) {
    chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
    chrome.action.setBadgeText({ text: "!" });
    return;
  }
  let activeCount = 0;
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (s.hasStarted && hasActiveItems(s)) activeCount++;
  }
  if (activeCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#43a047" });
    chrome.action.setBadgeText({ text: String(activeCount) });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function manageAlarms() {
  let anyActive = false;
  for (const id of Object.keys(sessions)) {
    if (hasActiveItems(sessions[id])) { anyActive = true; break; }
  }
  if (anyActive && !downloadingBlocked) {
    chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 1 });
    // keepalive every 25s prevents Chrome from killing the service worker
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  } else {
    chrome.alarms.clear(RECONCILE_ALARM);
    chrome.alarms.clear(KEEPALIVE_ALARM);
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
  sessions[rebuilt.id] = rebuilt;
  tabSessionMap[tab.id] = rebuilt.id;
  await saveSessions();
  return rebuilt;
}

async function ensureSessionForTab(tab) {
  await loadSessions();

  const existingId = tabSessionMap[tab.id];
  let session = existingId ? normalizeSessionShape(sessions[existingId]) : null;

  if (!session) {
    session = findSessionBySourceUrl(tab.url);
    if (session) session = normalizeSessionShape(session);
  }

  if (session) {
    sessions[session.id] = session;
    tabSessionMap[tab.id] = session.id;

    if (session.hasStarted && !hasActiveItems(session)) {
      restoreSelectionItems(session, { captureFailures: true });
      await saveSessions();
    }
    if (shouldReuseSession(session, tab.url)) {
      return session;
    }
  }

  const nextGeneration = session ? getSessionGeneration(session) + 1 : 0;
  return rebuildSessionForTab(tab, nextGeneration);
}

function makeJobId(sessionId, index, generation) {
  return `${sessionId}:${generation}:${index}:${Date.now()}`;
}

async function startOffscreenDownload(sessionId, index, generation, item) {
  await ensureOffscreenDocument();
  const jobId = makeJobId(sessionId, index, generation);
  item.jobId = jobId;
  item.state = "downloading";
  item.error = null;
  await saveSessions();
  broadcastSessionUpdate(sessionId);

  const session = sessions[sessionId];
  const tabId = session?.tabId;

  chrome.runtime.sendMessage({
    type: "offscreen_start_download",
    jobId,
    sessionId,
    tabId,
    index,
    generation,
    url: item.directUrl,
    resumeFrom: 0,
    item: { url: item.url, label: item.label }
  }, () => {
    void chrome.runtime.lastError;
  });
}

async function pumpQueueForSession(sessionId, expectedGeneration) {
  await loadSessions();

  if (downloadingBlocked) return;

  const existingSession = sessions[sessionId];
  if (!existingSession) return;
  const session = normalizeSessionShape(existingSession);
  sessions[sessionId] = session;
  if (!session?.items?.length) return;

  if (!session.hasStarted) return;

  const runGeneration =
    expectedGeneration == null ? getSessionGeneration(session) : expectedGeneration;
  if (!isSessionGenerationCurrent(sessionId, runGeneration)) return;

  const { concurrency } = await getCurrentSettings();
  const maxConcurrent = clampConcurrency(concurrency);

  const activeCount = session.items.filter(
    (item) => item.state === "starting" || item.state === "downloading"
  ).length;

  let availableSlots = maxConcurrent - activeCount;
  if (availableSlots <= 0) return;

  const tabId = session.tabId;
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
    broadcastSessionUpdate(sessionId);
    return;
  }

  for (let i = 0; i < session.items.length && availableSlots > 0; i++) {
    const item = getSessionItemForRun(sessionId, i, runGeneration);
    if (!item || item.state !== "queued") continue;

    availableSlots--;
    item.state = "starting";
    item.error = null;
    await saveSessions();
    broadcastSessionUpdate(sessionId);

    (async (index, generation) => {
      try {
        if (downloadingBlocked) return;
        const before = getSessionItemForRun(sessionId, index, generation);
        if (!before || before.state !== "starting") return;

        let dlUrl = before.directUrl;
        if (!dlUrl) {
          dlUrl = await rateLimitedResolve(before.url);
        }

        if (downloadingBlocked) return;
        const mid = getSessionItemForRun(sessionId, index, generation);
        if (!mid || mid.state !== "starting") return;

        mid.directUrl = dlUrl;
        await startOffscreenDownload(sessionId, index, generation, mid);
      } catch (err) {
        const onError = getSessionItemForRun(sessionId, index, generation);
        if (!onError) return;
        console.warn("Failed to start FuckingFast URL:", onError.url, err);
        onError.state = "error";
        onError.jobId = null;
        onError.error = err?.message || String(err);
        await saveSessions();
        broadcastSessionUpdate(sessionId);
        pumpQueueForSession(sessionId, generation);
      }
    })(i, runGeneration);
  }

  manageAlarms();
}

function finishRunIfIdle(sessionId) {
  const session = sessions[sessionId];
  if (!session) return false;
  if (!session.hasStarted) return false;
  if (hasActiveItems(session)) return false;
  session.generation = getSessionGeneration(session) + 1;
  restoreSelectionItems(session, { captureFailures: true });
  manageAlarms();
  updateBadge();
  return true;
}

async function stopAllDownloads() {
  await loadSessions();
  downloadingBlocked = true;

  for (const sessionId of Object.keys(sessions)) {
    const session = sessions[sessionId];
    if (!session?.items) continue;
    for (const item of session.items) {
      if (item.jobId) {
        try {
          chrome.runtime.sendMessage({
            type: "offscreen_cancel_job",
            jobId: item.jobId
          }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* ignore */ }
      }
      if (ACTIVE_ITEM_STATES.has(item.state)) {
        item.state = "stopped";
      }
      item.jobId = null;
    }
  }

  await saveSessions();
  updateBadge();
  manageAlarms();

  for (const sessionId of Object.keys(sessions)) {
    broadcastSessionUpdate(sessionId);
  }
}

async function unblockDownloads() {
  await loadSessions();
  downloadingBlocked = false;
  await saveSessions();
  updateBadge();
}

async function reconcileStaleJobs() {
  await loadSessions();
  if (downloadingBlocked) return;

  const activeJobIds = [];
  const jobIndex = {};
  let fixedStuck = false;

  for (const sessionId of Object.keys(sessions)) {
    const session = sessions[sessionId];
    if (!session?.items || !session.hasStarted) continue;
    for (let i = 0; i < session.items.length; i++) {
      const item = session.items[i];
      if ((item.state === "downloading" || item.state === "starting") && item.jobId) {
        activeJobIds.push(item.jobId);
        jobIndex[item.jobId] = { sessionId, index: i };
      }
      // catch "starting" items with no jobId (resolve died with worker)
      if (item.state === "starting" && !item.jobId) {
        item.state = "queued";
        item.error = null;
        fixedStuck = true;
      }
    }
  }

  if (fixedStuck) {
    await saveSessions();
    for (const sessionId of Object.keys(sessions)) {
      const s = sessions[sessionId];
      if (s.hasStarted) {
        broadcastSessionUpdate(sessionId);
        pumpQueueForSession(sessionId, getSessionGeneration(s));
      }
    }
  }

  if (!activeJobIds.length) {
    manageAlarms();
    return;
  }

  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: "offscreen_audit_jobs",
      jobIds: activeJobIds
    });

    if (!response?.aliveJobIds) return;
    const alive = new Set(response.aliveJobIds);
    let changed = false;

    for (const jobId of activeJobIds) {
      if (alive.has(jobId)) continue;
      const { sessionId, index } = jobIndex[jobId];
      const session = sessions[sessionId];
      if (!session?.items?.[index]) continue;
      const item = session.items[index];
      if (item.jobId !== jobId) continue;

      item.state = "queued";
      item.jobId = null;
      item.error = null;
      item.bytesWritten = 0;
      item.directUrl = null;
      changed = true;
    }

    if (changed) {
      await saveSessions();
      for (const sessionId of Object.keys(sessions)) {
        const s = sessions[sessionId];
        if (s.hasStarted) {
          pumpQueueForSession(sessionId, getSessionGeneration(s));
        }
        broadcastSessionUpdate(sessionId);
      }
    }
  } catch (e) {
    console.warn("Reconciliation failed:", e);
  }
  manageAlarms();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) {
    reconcileStaleJobs();
  }
  if (alarm.name === KEEPALIVE_ALARM) {
    repumpStuckSessions();
  }
});

async function repumpStuckSessions() {
  await loadSessions();
  if (downloadingBlocked) return;

  for (const sessionId of Object.keys(sessions)) {
    const session = sessions[sessionId];
    if (!session?.hasStarted) continue;
    if (!Array.isArray(session.items)) continue;

    let hasStuck = false;
    for (const item of session.items) {
      // items in "starting" with no jobId are stuck (resolve died with the worker)
      if (item.state === "starting" && !item.jobId) {
        item.state = "queued";
        item.error = null;
        hasStuck = true;
      }
    }

    if (hasStuck) {
      await saveSessions();
      broadcastSessionUpdate(sessionId);
      pumpQueueForSession(sessionId, getSessionGeneration(session));
    } else {
      // also re-pump if there are queued items but nothing active (pump stalled)
      const hasQueued = session.items.some((i) => i.state === "queued");
      const hasActive = session.items.some(
        (i) => i.state === "starting" || i.state === "downloading"
      );
      if (hasQueued && !hasActive) {
        pumpQueueForSession(sessionId, getSessionGeneration(session));
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "offscreen_download_progress") {
    (async () => {
      await loadSessions();
      const { sessionId, index, jobId, bytesWritten, totalBytes } = message;
      const session = sessions[sessionId];
      if (!session?.items?.[index]) return;
      const item = session.items[index];
      if (item.jobId && jobId && item.jobId !== jobId) return;

      item.bytesWritten = bytesWritten;
      if (totalBytes > 0) item.totalBytes = totalBytes;
      broadcastSessionUpdate(sessionId);
    })();
    return;
  }

  if (message.type === "offscreen_download_done") {
    (async () => {
      await loadSessions();
      const { sessionId, index, jobId } = message;
      const session = sessions[sessionId];
      if (!session?.items?.[index]) return;
      const item = session.items[index];
      if (item.jobId && jobId && item.jobId !== jobId) return;

      item.state = "completed";
      item.jobId = null;
      item.error = null;
      if (item.totalBytes > 0) item.bytesWritten = item.totalBytes;

      if (!Array.isArray(session.completedUrls)) session.completedUrls = [];
      if (!session.completedUrls.includes(item.url)) {
        session.completedUrls.push(item.url);
      }

      const runFinished = finishRunIfIdle(sessionId);
      await saveSessions();
      broadcastSessionUpdate(sessionId);
      if (!runFinished) {
        pumpQueueForSession(sessionId, getSessionGeneration(session));
      }
    })();
    return;
  }

  if (message.type === "offscreen_download_failed") {
    (async () => {
      await loadSessions();
      const { sessionId, index, jobId, cancelled, status, error } = message;
      const session = sessions[sessionId];
      if (!session?.items?.[index]) return;
      const item = session.items[index];
      if (item.jobId && jobId && item.jobId !== jobId) return;

      item.jobId = null;
      if (cancelled) {
        item.state = "cancelled";
      } else {
        item.state = "error";
        item.error = error || "Download failed";
        if (status === 429) {
          item.error = "Rate limited (429). Retry later.";
        }
      }

      const runFinished = finishRunIfIdle(sessionId);
      await saveSessions();
      broadcastSessionUpdate(sessionId);
      if (!runFinished && item.state === "error") {
        pumpQueueForSession(sessionId, getSessionGeneration(session));
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
          getSessionForTab(tab.id) || (await ensureSessionForTab(tab))
        );
        session.destinationName =
          typeof message.name === "string" ? message.name : "";
        sessions[session.id] = session;
        tabSessionMap[tab.id] = session.id;
        await saveSessions();
        broadcastSessionUpdate(session.id);
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
        sendResponse({ ok: true, session: sess, tabId: tab.id, blocked: downloadingBlocked });
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

        if (downloadingBlocked) {
          sendResponse({ ok: false, error: "Downloads are blocked. Unblock first." });
          return;
        }

        const tabId = tab.id;
        const session = normalizeSessionShape(await ensureSessionForTab(tab));
        sessions[session.id] = session;
        tabSessionMap[tabId] = session.id;

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
        sessions[session.id] = session;
        await saveSessions();
        broadcastSessionUpdate(session.id);
        updateBadge();

        await ensureOffscreenDocument();
        pumpQueueForSession(session.id, runGeneration);
        manageAlarms();

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

  if (message.type === "stop_all_downloads") {
    (async () => {
      try {
        await stopAllDownloads();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "unblock_downloads") {
    (async () => {
      try {
        await unblockDownloads();
        sendResponse({ ok: true, blocked: false });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "get_blocked_state") {
    (async () => {
      await loadSessions();
      sendResponse({ ok: true, blocked: downloadingBlocked });
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
        if (!tab?.url) {
          sendResponse({ ok: false, error: "No active FitGirl tab found." });
          return;
        }
        const tabId = tab.id;
        const session = getSessionForTab(tabId);
        if (!session) {
          sendResponse({ ok: true });
          return;
        }
        const normalized = normalizeSessionShape(session);
        const sessionId = normalized.id;

        for (const item of normalized.items) {
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

        normalized.generation = getSessionGeneration(normalized) + 1;
        restoreSelectionItems(normalized, { captureFailures: true });
        sessions[sessionId] = normalized;
        await saveSessions();

        if (tab.url?.includes("fitgirl-repacks.site")) {
          const destName = normalized.destinationName;
          const refreshed = await rebuildSessionForTab(tab, normalized.generation);
          refreshed.destinationName = destName;
          sessions[refreshed.id] = refreshed;
          tabSessionMap[tabId] = refreshed.id;
          await saveSessions();
        }

        broadcastSessionUpdate(tabSessionMap[tabId] || sessionId);
        updateBadge();
        manageAlarms();
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
        if (downloadingBlocked) {
          sendResponse({ ok: false, error: "Downloads are blocked. Unblock first." });
          return;
        }
        const tabId = tab.id;
        const session = getSessionForTab(tabId);
        if (!session) {
          sendResponse({ ok: true });
          return;
        }
        const normalized = normalizeSessionShape(session);
        const sessionId = normalized.id;

        const failedSet = new Set(
          (normalized.failedUrls || []).filter((u) => typeof u === "string")
        );
        for (const item of normalized.items) {
          if (item.state === "error" || item.state === "cancelled") {
            failedSet.add(item.url);
          }
        }

        if (!failedSet.size) {
          sendResponse({ ok: true });
          return;
        }

        const candidateLinks =
          Array.isArray(normalized.allItems) && normalized.allItems.length
            ? normalized.allItems
            : normalized.items.map((item) => ({
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

        normalized.generation = getSessionGeneration(normalized) + 1;
        normalized.items = retryItems;
        normalized.failedUrls = [];
        normalized.hasStarted = true;
        normalized.paused = false;
        sessions[sessionId] = normalized;
        await saveSessions();
        broadcastSessionUpdate(sessionId);
        updateBadge();
        pumpQueueForSession(sessionId, normalized.generation);
        manageAlarms();

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  // per-item operations
  if (message.type === "cancel_single_item") {
    (async () => {
      try {
        await loadSessions();
        const { sessionId, index } = message;
        const session = sessions[sessionId];
        if (!session?.items?.[index]) { sendResponse({ ok: true }); return; }
        const item = session.items[index];

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

        const runFinished = finishRunIfIdle(sessionId);
        await saveSessions();
        broadcastSessionUpdate(sessionId);
        if (!runFinished) {
          pumpQueueForSession(sessionId, getSessionGeneration(session));
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }


  if (message.type === "resume_single_item") {
    (async () => {
      try {
        await loadSessions();
        if (downloadingBlocked) {
          sendResponse({ ok: false, error: "Downloads are blocked." });
          return;
        }
        const { sessionId, index } = message;
        const session = sessions[sessionId];
        if (!session?.items?.[index]) { sendResponse({ ok: true }); return; }
        const item = session.items[index];

        if (item.state === "stopped") {
          item.state = "queued";
          item.jobId = null;
          item.error = null;
        }

        await saveSessions();
        broadcastSessionUpdate(sessionId);
        if (session.hasStarted) {
          pumpQueueForSession(sessionId, getSessionGeneration(session));
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "retry_single_item") {
    (async () => {
      try {
        await loadSessions();
        if (downloadingBlocked) {
          sendResponse({ ok: false, error: "Downloads are blocked." });
          return;
        }
        const { sessionId, index } = message;
        const session = sessions[sessionId];
        if (!session?.items?.[index]) { sendResponse({ ok: true }); return; }
        const item = session.items[index];

        item.state = "queued";
        item.jobId = null;
        item.error = null;
        item.directUrl = null;
        item.bytesWritten = 0;
        item.totalBytes = -1;

        if (!session.hasStarted) {
          session.hasStarted = true;
          session.paused = false;
        }

        await saveSessions();
        broadcastSessionUpdate(sessionId);
        pumpQueueForSession(sessionId, getSessionGeneration(session));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "open_item_link") {
    const { url } = message;
    if (url) chrome.tabs.create({ url, active: true });
    sendResponse({ ok: true });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await loadSessions();
    if (tabSessionMap[tabId]) {
      delete tabSessionMap[tabId];
      await saveSessions();
    }
  })();
});

async function onWorkerWake() {
  await reconcileStaleJobs();
  await loadSessions();
  if (downloadingBlocked) return;
  for (const sessionId of Object.keys(sessions)) {
    const s = sessions[sessionId];
    if (s.hasStarted && hasActiveItems(s)) {
      manageAlarms();
      return;
    }
  }
}

chrome.runtime.onStartup.addListener(() => {
  onWorkerWake();
});

chrome.runtime.onInstalled.addListener(() => {
  onWorkerWake();
});
