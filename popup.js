const statusEl = document.getElementById("status");
const filesListEl = document.getElementById("files-list");
const selectAllRowEl = document.getElementById("select-all-row");
const selectAllEl = document.getElementById("select-all");
const startButtonEl = document.getElementById("start-button");
const concurrencyInfoEl = document.getElementById("concurrency-info");
const backButtonEl = document.getElementById("back-button");
const settingsButtonEl = document.getElementById("settings-button");
const concurrencyInputEl = document.getElementById("concurrency-input");
const saveSettingsButtonEl = document.getElementById("save-settings-button");
const settingsStatusEl = document.getElementById("settings-status");
const selectionInfoEl = document.getElementById("selection-info");
const activeControlsEl = document.getElementById("active-controls");
const cancelButtonEl = document.getElementById("cancel-button");
const retryButtonEl = document.getElementById("retry-button");
const destinationLabelEl = document.getElementById("destination-label");
const pickFolderButtonEl = document.getElementById("pick-folder-button");
const gameTitleEl = document.getElementById("game-title");
const stopAllButtonEl = document.getElementById("stop-all-button");
const managerButtonEl = document.getElementById("manager-button");
const blockedBannerEl = document.getElementById("blocked-banner");

let currentSession = null;
let currentTabId = null;
let hasFolderPermission = false;
let isBlocked = false;

let lastClickedIndex = -1;
let highlightedIndices = new Set();

const speedSamples = new Map();

function setView(view) {
  document.body.dataset.view = view;
}

function formatBytes(bytes) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i > 1 ? 1 : 0) + " " + units[i];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return "";
  return formatBytes(bytesPerSec) + "/s";
}

function computeSpeed(index, bytesWritten) {
  const now = Date.now();
  if (!speedSamples.has(index)) {
    speedSamples.set(index, []);
  }
  const samples = speedSamples.get(index);
  samples.push({ time: now, bytes: bytesWritten });
  while (samples.length > 1 && now - samples[0].time > 5000) {
    samples.shift();
  }
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.time - first.time) / 1000;
  if (dt <= 0) return 0;
  return (last.bytes - first.bytes) / dt;
}

function updateBlockedUi() {
  if (isBlocked) {
    stopAllButtonEl.textContent = "Unblock";
    stopAllButtonEl.classList.add("blocked");
    blockedBannerEl.classList.add("visible");
  } else {
    stopAllButtonEl.textContent = "STOP ALL";
    stopAllButtonEl.classList.remove("blocked");
    blockedBannerEl.classList.remove("visible");
  }
}

function updateDestinationUi(session) {
  const name = session?.destinationName || "";
  if (name && hasFolderPermission) {
    destinationLabelEl.textContent = name;
    destinationLabelEl.classList.add("has-folder");
    destinationLabelEl.title = name;
    pickFolderButtonEl.textContent = "Change…";
  } else if (name && !hasFolderPermission) {
    destinationLabelEl.textContent = `${name} (permission needed)`;
    destinationLabelEl.classList.remove("has-folder");
    destinationLabelEl.title = "Click Choose folder to re-grant write access";
    pickFolderButtonEl.textContent = "Grant access";
  } else {
    destinationLabelEl.textContent = "No folder selected";
    destinationLabelEl.classList.remove("has-folder");
    destinationLabelEl.title = "";
    pickFolderButtonEl.textContent = "Choose folder";
  }
}

function canStart() {
  if (isBlocked) return false;
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  const checked = Array.from(checkboxes).some((cb) => cb.checked);
  return checked && hasFolderPermission;
}

function updateHighlights() {
  const rows = filesListEl.querySelectorAll(".file-row");
  rows.forEach((row, i) => {
    row.classList.toggle("highlighted", highlightedIndices.has(i));
  });
}

function updateSelectionInfo() {
  if (!selectionInfoEl) return;
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  if (!checkboxes.length) {
    selectionInfoEl.textContent = "";
    return;
  }
  const total = checkboxes.length;
  const checked = Array.from(checkboxes).filter((cb) => cb.checked).length;
  selectionInfoEl.textContent = `${checked} of ${total} file(s) selected`;
  startButtonEl.disabled = !canStart();
}

function updateSelectAllFromChildren() {
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  if (!checkboxes.length) {
    selectAllEl.checked = false;
    selectAllEl.indeterminate = false;
    return;
  }
  const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
  const noneChecked = Array.from(checkboxes).every((cb) => !cb.checked);
  selectAllEl.checked = allChecked;
  selectAllEl.indeterminate = !allChecked && !noneChecked;
}

function handleRowClick(event, index) {
  const rows = filesListEl.querySelectorAll(".file-row");
  const row = rows[index];
  if (!row) return;
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (!checkbox) return;

  if (event.target === checkbox) {
    event.preventDefault();
  }

  if (event.shiftKey && lastClickedIndex >= 0) {
    const anchorCb = rows[lastClickedIndex]?.querySelector('input[type="checkbox"]');
    const targetState = anchorCb ? anchorCb.checked : true;
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);

    if (!event.ctrlKey && !event.metaKey) {
      highlightedIndices.clear();
    }

    for (let i = start; i <= end; i++) {
      const cb = rows[i]?.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = targetState;
      highlightedIndices.add(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    checkbox.checked = !checkbox.checked;
    if (highlightedIndices.has(index)) {
      highlightedIndices.delete(index);
    } else {
      highlightedIndices.add(index);
    }
    lastClickedIndex = index;
  } else {
    checkbox.checked = !checkbox.checked;
    highlightedIndices.clear();
    highlightedIndices.add(index);
    lastClickedIndex = index;
  }

  updateHighlights();
  updateSelectAllFromChildren();
  updateSelectionInfo();
}

function renderSelectionView(session) {
  const items = session?.items || [];
  filesListEl.innerHTML = "";
  lastClickedIndex = -1;
  highlightedIndices.clear();
  speedSamples.clear();
  startButtonEl.style.display = "";
  activeControlsEl.classList.remove("visible");

  const hasFailed = Array.isArray(session?.failedUrls) && session.failedUrls.length > 0;
  retryButtonEl.style.display = hasFailed ? "" : "none";

  if (!items.length) {
    statusEl.textContent = "No FuckingFast links were detected on this page.";
    startButtonEl.disabled = true;
    selectAllRowEl.hidden = true;
    if (selectionInfoEl) selectionInfoEl.textContent = "";
    return;
  }

  const completedSet = new Set(
    Array.isArray(session?.completedUrls) ? session.completedUrls : []
  );
  for (const url of filesOnDisk) completedSet.add(url);

  selectAllRowEl.hidden = false;
  selectAllEl.checked = true;
  selectAllEl.indeterminate = false;
  const existingRestBtn = selectAllRowEl.querySelector(".select-rest-btn");
  if (existingRestBtn) existingRestBtn.remove();

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const isAlreadyDone = completedSet.has(item.url);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const label = document.createElement("label");
    label.textContent = item.label || item.url;
    label.title = item.label || item.url;

    if (isAlreadyDone) {
      label.style.opacity = "0.5";
      label.title += " (already downloaded)";
    }

    row.appendChild(checkbox);
    row.appendChild(label);

    if (isAlreadyDone) {
      const doneTag = document.createElement("span");
      doneTag.textContent = "done";
      doneTag.style.cssText = "font-size:10px;color:#81c784;margin-left:6px;opacity:0.8;";
      row.appendChild(doneTag);
    }

    row.addEventListener("click", (e) => {
      if (e.target === checkbox) e.preventDefault();
      handleRowClick(e, index);
    });

    row.addEventListener("mousedown", (e) => {
      if (e.shiftKey) e.preventDefault();
    });

    filesListEl.appendChild(row);
  });

  const hasCompleted = completedSet.size > 0 &&
    items.some((item) => completedSet.has(item.url));

  let statusText = `Found ${items.length} FuckingFast link(s). ` +
    "Shift+Click for range, Ctrl+Click to toggle individually.";
  if (hasCompleted) {
    const doneCount = items.filter((i) => completedSet.has(i.url)).length;
    statusText = `Found ${items.length} link(s) — ${doneCount} already downloaded previously.`;
  }
  statusEl.textContent = statusText;

  if (hasCompleted) {
    const selectRestBtn = document.createElement("button");
    selectRestBtn.className = "select-rest-btn";
    selectRestBtn.textContent = "Select the rest";
    selectRestBtn.style.cssText = "margin-left:8px;font-size:11px;padding:2px 8px;";
    selectRestBtn.addEventListener("click", () => {
      const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => {
        const idx = Number(cb.dataset.index);
        const item = items[idx];
        cb.checked = item ? !completedSet.has(item.url) : false;
      });
      highlightedIndices.clear();
      updateHighlights();
      updateSelectAllFromChildren();
      updateSelectionInfo();
    });
    selectAllRowEl.appendChild(selectRestBtn);
  }

  updateSelectionInfo();
}

function createItemActions(session, item, index) {
  const actions = document.createElement("div");
  actions.className = "item-actions";
  const sessionId = session.id;

  if (item.state === "downloading" || item.state === "starting") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-item-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "cancel_single_item", sessionId, index });
    });
    actions.appendChild(cancelBtn);
  } else if (item.state === "queued") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-item-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "cancel_single_item", sessionId, index });
    });
    actions.appendChild(cancelBtn);
  } else if (item.state === "stopped") {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "btn-item-resume";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "resume_single_item", sessionId, index });
    });
    actions.appendChild(resumeBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-item-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "cancel_single_item", sessionId, index });
    });
    actions.appendChild(cancelBtn);
  } else if (item.state === "error" || item.state === "cancelled") {
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn-item-retry";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "retry_single_item", sessionId, index });
    });
    actions.appendChild(retryBtn);

    const openBtn = document.createElement("button");
    openBtn.className = "btn-item-open";
    openBtn.textContent = "Open";
    openBtn.title = "Open the FuckingFast link in a new tab";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "open_item_link", url: item.url });
    });
    actions.appendChild(openBtn);
  }

  return actions;
}

function renderStatusView(session) {
  const items = session?.items || [];
  filesListEl.innerHTML = "";
  selectAllRowEl.hidden = true;
  lastClickedIndex = -1;
  highlightedIndices.clear();

  if (!items.length) {
    statusEl.textContent = "No active batch for this page.";
    startButtonEl.disabled = true;
    startButtonEl.style.display = "";
    activeControlsEl.classList.remove("visible");
    retryButtonEl.style.display = "none";
    if (selectionInfoEl) selectionInfoEl.textContent = "";
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "file-row";

    const label = document.createElement("label");
    label.textContent = item.label || item.url;
    label.title = item.label || item.url;

    const status = document.createElement("span");
    status.className = "file-status";

    let text = item.state || "queued";
    let cls = "status-queued";
    if (item.state === "starting") { text = "resolving"; cls = "status-starting"; }
    else if (item.state === "downloading") { text = "downloading"; cls = "status-downloading"; }
    else if (item.state === "completed") { text = "completed"; cls = "status-completed"; }
    else if (item.state === "error") { text = "error"; cls = "status-error"; }
    else if (item.state === "cancelled") { text = "cancelled"; cls = "status-cancelled"; }
    else if (item.state === "stopped") { text = "stopped"; cls = "status-stopped"; }

    status.textContent = text;
    status.title = item.error || text;
    status.classList.add(cls);

    row.appendChild(label);
    row.appendChild(status);

    const actions = createItemActions(session, item, index);
    row.appendChild(actions);

    filesListEl.appendChild(row);

    if (item.state === "downloading" && item.bytesWritten > 0) {
      const speed = computeSpeed(index, item.bytesWritten);
      const progressRow = document.createElement("div");
      progressRow.className = "progress-row";

      const barContainer = document.createElement("div");
      barContainer.className = "progress-bar-container";
      const barFill = document.createElement("div");
      barFill.className = "progress-bar-fill";

      let pct = 0;
      if (item.totalBytes > 0) {
        pct = Math.min(100, (item.bytesWritten / item.totalBytes) * 100);
      }
      barFill.style.width = pct > 0 ? pct.toFixed(1) + "%" : "0%";
      if (item.totalBytes <= 0 && item.bytesWritten > 0) {
        barFill.style.width = "100%";
        barFill.style.opacity = "0.4";
      }
      barContainer.appendChild(barFill);

      const progressText = document.createElement("span");
      progressText.className = "progress-text";
      let progressStr = formatBytes(item.bytesWritten);
      if (item.totalBytes > 0) {
        progressStr += " / " + formatBytes(item.totalBytes);
      }
      if (speed > 0) {
        progressStr += " · " + formatSpeed(speed);
      }
      progressText.textContent = progressStr;

      progressRow.appendChild(barContainer);
      progressRow.appendChild(progressText);
      filesListEl.appendChild(progressRow);
    }
  });

  const counts = {
    queued: 0, starting: 0, downloading: 0, completed: 0,
    error: 0, cancelled: 0, stopped: 0
  };
  items.forEach((i) => { counts[i.state] = (counts[i.state] || 0) + 1; });

  const parts = [];
  if (counts.starting) parts.push(`${counts.starting} resolving`);
  if (counts.completed) parts.push(`${counts.completed} completed`);
  if (counts.downloading) parts.push(`${counts.downloading} downloading`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (counts.error) parts.push(`${counts.error} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.stopped) parts.push(`${counts.stopped} stopped`);

  if (selectionInfoEl) {
    selectionInfoEl.textContent = parts.join(" \u00b7 ");
  }

  const anyActive = items.some(
    (i) =>
      i.state === "queued" ||
      i.state === "starting" ||
      i.state === "downloading"
  );
  const hasErrors = counts.error > 0;

  if (anyActive) {
    statusEl.textContent = `${counts.completed} of ${items.length} downloads finished.`;
    activeControlsEl.classList.add("visible");
    startButtonEl.style.display = "none";
    retryButtonEl.style.display = "none";
  } else {
    activeControlsEl.classList.remove("visible");
    startButtonEl.style.display = "";
    startButtonEl.disabled = true;

    if (hasErrors || counts.cancelled > 0 || counts.stopped > 0) {
      statusEl.textContent = `Finished \u2014 ${(counts.error + counts.cancelled + counts.stopped)} download(s) need attention.`;
      retryButtonEl.style.display = "";
    } else {
      statusEl.textContent = "All selected downloads have finished.";
      retryButtonEl.style.display = "none";
    }
  }
}

function renderSession(session) {
  currentSession = session;
  updateDestinationUi(session);

  if (gameTitleEl) {
    if (session?.title) {
      gameTitleEl.style.display = "";
      gameTitleEl.textContent = session.title;
    } else {
      gameTitleEl.style.display = "none";
      gameTitleEl.textContent = "";
    }
  }

  if (!session || !Array.isArray(session.items) || !session.items.length) {
    filesListEl.innerHTML = "";
    selectAllRowEl.hidden = true;
    startButtonEl.disabled = true;
    startButtonEl.style.display = "";
    activeControlsEl.classList.remove("visible");
    retryButtonEl.style.display = "none";
    statusEl.textContent = "No FuckingFast links were detected on this page.";
    if (selectionInfoEl) selectionInfoEl.textContent = "";
    return;
  }

  if (!session.hasStarted) {
    renderSelectionView(session);
  } else {
    renderStatusView(session);
  }
}

function getSelectedItemsForStart() {
  const selected = [];
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    if (!cb.checked) return;
    const idx = Number(cb.dataset.index);
    if (
      Number.isInteger(idx) &&
      currentSession &&
      currentSession.items &&
      currentSession.items[idx]
    ) {
      selected.push(currentSession.items[idx]);
    }
  });
  return selected;
}

async function refreshFolderPermission(tabId) {
  hasFolderPermission = false;
  if (tabId == null) return;
  try {
    const handle = await loadDirectoryHandle(tabId);
    if (!handle) return;
    hasFolderPermission = await ensureReadWritePermission(handle, { request: false });
  } catch (e) {
    hasFolderPermission = false;
  }
}

function normalizeForMatch(name) {
  return name.toLowerCase().replace(/[^a-z0-9.]/g, "");
}

async function scanFolderForExistingFiles(tabId, items) {
  if (!tabId || !items?.length) return new Set();
  try {
    const handle = await loadDirectoryHandle(tabId);
    if (!handle) return new Set();
    const allowed = await ensureReadWritePermission(handle, { request: false });
    if (!allowed) return new Set();

    const existingFiles = new Map();
    const normalizedFiles = new Map();
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        existingFiles.set(name, file.size);
        normalizedFiles.set(normalizeForMatch(name), file.size);
      }
    }

    const doneOnDisk = new Set();
    const MIN_COMPLETE_SIZE = 1024 * 1024;

    for (const item of items) {
      const expectedName = filenameFromItem(item, null);

      // try exact match first
      let size = existingFiles.get(expectedName);

      // try normalized match (handles unicode/encoding differences)
      if (size == null) {
        size = normalizedFiles.get(normalizeForMatch(expectedName));
      }

      // try matching by label directly
      if (size == null && item.label) {
        size = normalizedFiles.get(normalizeForMatch(item.label));
      }

      if (size != null && size >= MIN_COMPLETE_SIZE) {
        doneOnDisk.add(item.url);
      }
    }
    return doneOnDisk;
  } catch (e) {
    return new Set();
  }
}

async function pickDestinationFolder() {
  if (currentTabId == null) {
    statusEl.textContent = "Scan a FitGirl tab first.";
    return;
  }

  let handle;
  try {
    handle = await showDirectoryPicker({
      id: "fitdownloader-dest",
      mode: "readwrite",
      startIn: "downloads"
    });
  } catch (err) {
    if (err?.name === "AbortError") return;
    statusEl.textContent = `Folder picker failed: ${err?.message || err}`;
    return;
  }

  const allowed = await ensureReadWritePermission(handle, { request: true });
  if (!allowed) {
    statusEl.textContent = "Write permission was not granted for that folder.";
    hasFolderPermission = false;
    updateDestinationUi(currentSession);
    return;
  }

  await storeDirectoryHandle(currentTabId, handle);
  hasFolderPermission = true;

  chrome.runtime.sendMessage(
    { type: "set_destination", name: handle.name },
    async (response) => {
      if (response?.ok && response.session) {
        currentSession = response.session;
      } else if (currentSession) {
        currentSession.destinationName = handle.name;
      }

      if (currentSession?.items) {
        filesOnDisk = await scanFolderForExistingFiles(currentTabId, currentSession.items);
      }

      updateDestinationUi(currentSession);
      if (!currentSession?.hasStarted) {
        renderSelectionView(currentSession);
      } else {
        updateSelectionInfo();
      }
    }
  );
}

selectAllEl.addEventListener("change", () => {
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = selectAllEl.checked;
  });
  highlightedIndices.clear();
  updateHighlights();
  updateSelectionInfo();
});

pickFolderButtonEl.addEventListener("click", () => {
  pickDestinationFolder();
});

startButtonEl.addEventListener("click", async () => {
  const selected = getSelectedItemsForStart();
  if (!selected.length) {
    statusEl.textContent = "No files selected.";
    return;
  }

  if (!hasFolderPermission) {
    statusEl.textContent = "Choose a destination folder first.";
    return;
  }

  try {
    const handle = await loadDirectoryHandle(currentTabId);
    const ok = await ensureReadWritePermission(handle, { request: true });
    if (!ok) {
      hasFolderPermission = false;
      statusEl.textContent = "Folder permission lost — choose the folder again.";
      updateDestinationUi(currentSession);
      updateSelectionInfo();
      return;
    }
  } catch (e) {
    statusEl.textContent = "Could not access destination folder.";
    return;
  }

  startButtonEl.disabled = true;
  statusEl.textContent = "Starting downloads\u2026";

  chrome.runtime.sendMessage(
    { type: "start_downloads", items: selected },
    (response) => {
      if (!response || !response.ok) {
        statusEl.textContent = `Error: ${
          response?.error ||
          chrome.runtime.lastError?.message ||
          "Unknown error"
        }`;
        startButtonEl.disabled = false;
        return;
      }
      statusEl.textContent = "Downloads are now running in the background.";
      scanCurrentTab();
    }
  );
});

cancelButtonEl.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "cancel_downloads" }, (response) => {
    if (response?.ok) scanCurrentTab();
  });
});

retryButtonEl.addEventListener("click", () => {
  retryButtonEl.style.display = "none";
  chrome.runtime.sendMessage({ type: "retry_failed" }, (response) => {
    if (response?.ok) scanCurrentTab();
  });
});

stopAllButtonEl.addEventListener("click", () => {
  if (isBlocked) {
    chrome.runtime.sendMessage({ type: "unblock_downloads" }, (response) => {
      if (response?.ok) {
        isBlocked = false;
        updateBlockedUi();
        scanCurrentTab();
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: "stop_all_downloads" }, (response) => {
      if (response?.ok) {
        isBlocked = true;
        updateBlockedUi();
        scanCurrentTab();
      }
    });
  }
});

managerButtonEl.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
});

function loadSettingsForDisplay() {
  chrome.runtime.sendMessage({ type: "get_settings" }, (response) => {
    if (!response || !response.ok) {
      concurrencyInfoEl.textContent = "";
      return;
    }
    const n = response.settings?.concurrency;
    concurrencyInfoEl.textContent = `Max concurrent downloads: ${n}`;
    concurrencyInputEl.value = n;
  });
}

backButtonEl.addEventListener("click", () => setView("main"));
settingsButtonEl.addEventListener("click", () => setView("settings"));

saveSettingsButtonEl.addEventListener("click", () => {
  const desired = Number(concurrencyInputEl.value) || 5;
  chrome.runtime.sendMessage(
    { type: "save_settings", settings: { concurrency: desired } },
    (response) => {
      if (!response || !response.ok) {
        settingsStatusEl.textContent =
          response?.error ||
          chrome.runtime.lastError?.message ||
          "Failed to save settings.";
        return;
      }
      const n = response.settings?.concurrency ?? desired;
      concurrencyInputEl.value = n;
      settingsStatusEl.textContent = "Settings saved.";
      concurrencyInfoEl.textContent = `Max concurrent downloads: ${n}`;
      setTimeout(() => {
        settingsStatusEl.textContent = "";
      }, 2000);
    }
  );
});

let filesOnDisk = new Set();

function scanCurrentTab() {
  chrome.runtime.sendMessage({ type: "scan_current_tab" }, async (response) => {
    if (!response || !response.ok) {
      statusEl.textContent =
        response?.error ||
        chrome.runtime.lastError?.message ||
        "Unable to scan current tab.";
      startButtonEl.disabled = true;
      selectAllRowEl.hidden = true;
      return;
    }
    currentTabId = response.tabId ?? null;
    if (response.blocked != null) {
      isBlocked = response.blocked;
      updateBlockedUi();
    }
    await refreshFolderPermission(currentTabId);

    if (response.session?.items) {
      filesOnDisk = await scanFolderForExistingFiles(currentTabId, response.session.items);
    } else {
      filesOnDisk = new Set();
    }

    renderSession(response.session);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "session_updated") return;
  if (!currentSession || message.sessionId !== currentSession.id) return;
  if (message.session) renderSession(message.session);
});

document.addEventListener("DOMContentLoaded", () => {
  setView("main");
  loadSettingsForDisplay();
  scanCurrentTab();
});
