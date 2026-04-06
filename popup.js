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
const pauseResumeButtonEl = document.getElementById("pause-resume-button");
const retryButtonEl = document.getElementById("retry-button");

let currentSession = null;
let currentTabId = null;

let lastClickedIndex = -1;
let highlightedIndices = new Set();

function setView(view) {
  document.body.dataset.view = view;
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
  startButtonEl.disabled = checked === 0;
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

// ---------------------------------------------------------------------------
// Selection view (pre-start)
// ---------------------------------------------------------------------------

function renderSelectionView(session) {
  const items = session?.items || [];
  filesListEl.innerHTML = "";
  lastClickedIndex = -1;
  highlightedIndices.clear();
  startButtonEl.style.display = "";
  activeControlsEl.classList.remove("visible");
  retryButtonEl.style.display = "none";

  if (!items.length) {
    statusEl.textContent = "No FuckingFast links were detected on this page.";
    startButtonEl.disabled = true;
    selectAllRowEl.hidden = true;
    if (selectionInfoEl) selectionInfoEl.textContent = "";
    return;
  }

  selectAllRowEl.hidden = false;
  selectAllEl.checked = true;
  selectAllEl.indeterminate = false;

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "file-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const label = document.createElement("label");
    label.textContent = item.label || item.url;
    label.title = item.label || item.url;

    row.appendChild(checkbox);
    row.appendChild(label);

    row.addEventListener("click", (e) => {
      if (e.target === checkbox) e.preventDefault();
      handleRowClick(e, index);
    });

    row.addEventListener("mousedown", (e) => {
      if (e.shiftKey) e.preventDefault();
    });

    filesListEl.appendChild(row);
  });

  startButtonEl.disabled = false;
  statusEl.textContent =
    `Found ${items.length} FuckingFast link(s). ` +
    "Shift+Click for range, Ctrl+Click to toggle individually.";
  updateSelectionInfo();
}

// ---------------------------------------------------------------------------
// Status view (downloads running / finished)
// ---------------------------------------------------------------------------

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

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "file-row";

    const label = document.createElement("label");
    label.textContent = item.label || item.url;
    label.title = item.label || item.url;

    const status = document.createElement("span");
    status.className = "file-status";

    let text = item.state || "queued";
    let cls = "status-queued";
    if (item.state === "starting") { text = "starting"; cls = "status-downloading"; }
    else if (item.state === "downloading") { text = "downloading"; cls = "status-downloading"; }
    else if (item.state === "completed") { text = "completed"; cls = "status-completed"; }
    else if (item.state === "error") { text = "error"; cls = "status-error"; }
    else if (item.state === "paused") { text = "paused"; cls = "status-paused"; }
    else if (item.state === "cancelled") { text = "cancelled"; cls = "status-cancelled"; }

    status.textContent = text;
    status.classList.add(cls);

    row.appendChild(label);
    row.appendChild(status);
    filesListEl.appendChild(row);
  });

  const counts = { queued: 0, starting: 0, downloading: 0, completed: 0, error: 0, paused: 0, cancelled: 0 };
  items.forEach((i) => { counts[i.state] = (counts[i.state] || 0) + 1; });

  const parts = [];
  if (counts.starting) parts.push(`${counts.starting} starting`);
  if (counts.completed) parts.push(`${counts.completed} completed`);
  if (counts.downloading) parts.push(`${counts.downloading} downloading`);
  if (counts.paused) parts.push(`${counts.paused} paused`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (counts.error) parts.push(`${counts.error} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);

  if (selectionInfoEl) {
    selectionInfoEl.textContent = parts.join(" \u00b7 ");
  }

  const anyActive = items.some(
    (i) =>
      i.state === "queued" ||
      i.state === "starting" ||
      i.state === "downloading" ||
      i.state === "paused"
  );
  const hasErrors = counts.error > 0;

  if (anyActive) {
    statusEl.textContent = `${counts.completed} of ${items.length} downloads finished.`;
    activeControlsEl.classList.add("visible");
    startButtonEl.style.display = "none";
    retryButtonEl.style.display = "none";

    const anyPaused = items.some((i) => i.state === "paused");
    pauseResumeButtonEl.textContent = anyPaused ? "Resume" : "Pause";
    pauseResumeButtonEl.className = anyPaused ? "btn-success" : "btn-warning";
  } else {
    activeControlsEl.classList.remove("visible");
    startButtonEl.style.display = "";
    startButtonEl.disabled = true;

    if (hasErrors) {
      statusEl.textContent = `Finished \u2014 ${counts.error} download(s) failed.`;
      retryButtonEl.style.display = "";
    } else {
      statusEl.textContent = "All selected downloads have finished.";
      retryButtonEl.style.display = "none";
    }
  }
}

// ---------------------------------------------------------------------------
// Session render dispatcher
// ---------------------------------------------------------------------------

function renderSession(session) {
  currentSession = session;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

selectAllEl.addEventListener("change", () => {
  const checkboxes = filesListEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = selectAllEl.checked;
  });
  highlightedIndices.clear();
  updateHighlights();
  updateSelectionInfo();
});

startButtonEl.addEventListener("click", () => {
  const selected = getSelectedItemsForStart();
  if (!selected.length) {
    statusEl.textContent = "No files selected.";
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

pauseResumeButtonEl.addEventListener("click", () => {
  const isPaused = pauseResumeButtonEl.textContent.trim() === "Resume";
  chrome.runtime.sendMessage(
    { type: isPaused ? "resume_downloads" : "pause_downloads" },
    () => {}
  );
});

retryButtonEl.addEventListener("click", () => {
  retryButtonEl.style.display = "none";
  chrome.runtime.sendMessage({ type: "retry_failed" }, (response) => {
    if (response?.ok) scanCurrentTab();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tab scanning & live updates
// ---------------------------------------------------------------------------

function scanCurrentTab() {
  chrome.runtime.sendMessage({ type: "scan_current_tab" }, (response) => {
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
    renderSession(response.session);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "session_updated") return;
  if (currentTabId == null || message.tabId !== currentTabId) return;
  if (message.session) renderSession(message.session);
});

document.addEventListener("DOMContentLoaded", () => {
  setView("main");
  loadSettingsForDisplay();
  scanCurrentTab();
});
