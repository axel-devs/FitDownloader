const stopAllButtonEl = document.getElementById("stop-all-button");
const blockedBannerEl = document.getElementById("blocked-banner");
const sessionsContainerEl = document.getElementById("sessions-container");
const noSessionsEl = document.getElementById("no-sessions");

let allSessions = {};
let isBlocked = false;
const speedSamples = new Map();

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

function computeSpeed(key, bytesWritten) {
  const now = Date.now();
  if (!speedSamples.has(key)) {
    speedSamples.set(key, []);
  }
  const samples = speedSamples.get(key);
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

function createItemActions(sessionId, item, index) {
  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (item.state === "downloading" || item.state === "starting" || item.state === "queued") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-item-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "cancel_single_item", sessionId, index });
    });
    actions.appendChild(cancelBtn);
  } else if (item.state === "stopped") {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "btn-item-resume";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "resume_single_item", sessionId, index });
    });
    actions.appendChild(resumeBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-item-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "cancel_single_item", sessionId, index });
    });
    actions.appendChild(cancelBtn);
  } else if (item.state === "error" || item.state === "cancelled") {
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn-item-retry";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "retry_single_item", sessionId, index });
    });
    actions.appendChild(retryBtn);

    const openBtn = document.createElement("button");
    openBtn.className = "btn-item-open";
    openBtn.textContent = "Open";
    openBtn.title = "Open the FuckingFast link in a new tab";
    openBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "open_item_link", url: item.url });
    });
    actions.appendChild(openBtn);
  }

  return actions;
}

function renderSessions() {
  const sessionIds = Object.keys(allSessions);
  const activeSessions = sessionIds.filter((id) => {
    const s = allSessions[id];
    return s && s.hasStarted && Array.isArray(s.items) && s.items.length > 0;
  });

  if (!activeSessions.length) {
    sessionsContainerEl.innerHTML = "";
    sessionsContainerEl.appendChild(noSessionsEl);
    noSessionsEl.style.display = "";
    return;
  }

  // preserve scroll positions across re-renders
  const scrollPositions = {};
  sessionsContainerEl.querySelectorAll(".session-items").forEach((el) => {
    const card = el.closest(".session-card");
    if (card?.dataset.sessionId) {
      scrollPositions[card.dataset.sessionId] = el.scrollTop;
    }
  });
  const pageScroll = window.scrollY;

  noSessionsEl.style.display = "none";
  sessionsContainerEl.innerHTML = "";

  for (const sessionId of activeSessions) {
    const session = allSessions[sessionId];
    const card = document.createElement("div");
    card.className = "session-card";
    card.dataset.sessionId = sessionId;

    const header = document.createElement("div");
    header.className = "session-header";
    const titleEl = document.createElement("span");
    titleEl.className = "session-title";
    titleEl.textContent = session.title || session.sourceUrl || "Download Session";
    const metaEl = document.createElement("span");
    metaEl.className = "session-meta";
    metaEl.textContent = session.destinationName ? `→ ${session.destinationName}` : "";
    header.appendChild(titleEl);
    header.appendChild(metaEl);
    card.appendChild(header);

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "session-items";

    let totalBytes = 0;
    let totalWritten = 0;

    session.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "item-row";

      const label = document.createElement("span");
      label.className = "item-label";
      label.textContent = item.label || item.url;
      label.title = item.label || item.url;

      const status = document.createElement("span");
      status.className = "item-status";
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
      row.appendChild(createItemActions(sessionId, item, index));
      itemsContainer.appendChild(row);

      if (item.state === "downloading" && item.bytesWritten > 0) {
        const speedKey = `${sessionId}:${index}`;
        const speed = computeSpeed(speedKey, item.bytesWritten);

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
        itemsContainer.appendChild(progressRow);
      }

      if (item.totalBytes > 0) {
        totalBytes += item.totalBytes;
        totalWritten += item.state === "completed" ? item.totalBytes : (item.bytesWritten || 0);
      } else if (item.state === "completed" && item.bytesWritten > 0) {
        totalBytes += item.bytesWritten;
        totalWritten += item.bytesWritten;
      }
    });

    card.appendChild(itemsContainer);

    const counts = { queued: 0, starting: 0, downloading: 0, completed: 0, error: 0, cancelled: 0, stopped: 0 };
    session.items.forEach((i) => { counts[i.state] = (counts[i.state] || 0) + 1; });
    const parts = [];
    if (counts.completed) parts.push(`${counts.completed} completed`);
    if (counts.downloading) parts.push(`${counts.downloading} downloading`);
    if (counts.starting) parts.push(`${counts.starting} resolving`);
    if (counts.queued) parts.push(`${counts.queued} queued`);
    if (counts.error) parts.push(`${counts.error} failed`);
    if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
    if (counts.stopped) parts.push(`${counts.stopped} stopped`);

    const countsEl = document.createElement("div");
    countsEl.className = "session-counts";
    countsEl.textContent = parts.join(" · ");
    card.appendChild(countsEl);

    if (totalBytes > 0) {
      const progressSection = document.createElement("div");
      progressSection.className = "session-progress";
      const barContainer = document.createElement("div");
      barContainer.className = "progress-bar-container";
      const barFill = document.createElement("div");
      barFill.className = "progress-bar-fill";
      const pct = Math.min(100, (totalWritten / totalBytes) * 100);
      barFill.style.width = pct.toFixed(1) + "%";
      barContainer.appendChild(barFill);
      progressSection.appendChild(barContainer);

      const textEl = document.createElement("div");
      textEl.className = "session-progress-text";
      textEl.textContent = `${formatBytes(totalWritten)} / ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`;
      progressSection.appendChild(textEl);
      card.appendChild(progressSection);
    }

    sessionsContainerEl.appendChild(card);
  }

  // restore scroll positions
  sessionsContainerEl.querySelectorAll(".session-items").forEach((el) => {
    const card = el.closest(".session-card");
    if (card?.dataset.sessionId && scrollPositions[card.dataset.sessionId]) {
      el.scrollTop = scrollPositions[card.dataset.sessionId];
    }
  });
  window.scrollTo(0, pageScroll);
}

function loadAllSessions() {
  chrome.storage.local.get(["ffSessions", "ffBlocked"], (stored) => {
    if (stored.ffSessions && typeof stored.ffSessions === "object") {
      allSessions = stored.ffSessions;
    }
    isBlocked = stored.ffBlocked === true;
    updateBlockedUi();
    renderSessions();
  });
}

stopAllButtonEl.addEventListener("click", () => {
  if (isBlocked) {
    chrome.runtime.sendMessage({ type: "unblock_downloads" }, (response) => {
      if (response?.ok) {
        isBlocked = false;
        updateBlockedUi();
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: "stop_all_downloads" }, (response) => {
      if (response?.ok) {
        isBlocked = true;
        updateBlockedUi();
        loadAllSessions();
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "session_updated" && message.session) {
    allSessions[message.sessionId] = message.session;
    renderSessions();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadAllSessions();
});
