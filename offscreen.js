// Offscreen download worker: fetch → write into per-tab DirectoryHandle.

const activeJobs = new Map();
const PROGRESS_INTERVAL_MS = 500;

async function writeResponseToFile(response, fileHandle, { signal, startOffset = 0, onProgress }) {
  const writable = await fileHandle.createWritable({
    keepExistingData: startOffset > 0
  });
  try {
    if (startOffset > 0) {
      await writable.seek(startOffset);
    }
    if (!response.body) {
      const buf = await response.arrayBuffer();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await writable.write(buf);
      const total = startOffset + buf.byteLength;
      if (onProgress) onProgress(total);
      return total;
    }

    const reader = response.body.getReader();
    let written = startOffset;
    let lastReport = Date.now();
    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;

      const now = Date.now();
      if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onProgress(written);
      }
    }
    if (onProgress) onProgress(written);
    return written;
  } finally {
    try {
      if (signal?.aborted) {
        await writable.abort();
      } else {
        await writable.close();
      }
    } catch (e) {
      // ignore errors after abort
    }
  }
}

async function downloadJob(message) {
  const {
    jobId,
    sessionId,
    tabId,
    index,
    url,
    item,
    resumeFrom = 0
  } = message;

  const controller = new AbortController();
  activeJobs.set(jobId, { controller });

  let dirHandle = null;
  let filename = null;

  try {
    dirHandle = await loadDirectoryHandle(tabId);
    if (!dirHandle) {
      throw new Error("No destination folder for this tab. Pick a folder in the popup.");
    }
    const allowed = await ensureReadWritePermission(dirHandle, { request: false });
    if (!allowed) {
      throw new Error("Folder permission lost. Re-select the destination in the popup.");
    }

    const headers = {};
    if (resumeFrom > 0) {
      headers.Range = `bytes=${resumeFrom}-`;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers,
      redirect: "follow"
    });

    if (response.status === 429) {
      throw Object.assign(new Error("Rate limited (429)"), { status: 429 });
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`Download HTTP ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get("content-length"), 10);
    let totalBytes = -1;
    if (Number.isFinite(contentLength) && contentLength > 0) {
      totalBytes = (response.status === 206 ? resumeFrom : 0) + contentLength;
    }

    filename = filenameFromItem(item, response.headers.get("content-disposition"));
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });

    let offset = resumeFrom;
    if (resumeFrom > 0 && response.status !== 206) {
      offset = 0;
    }

    const onProgress = (bytesWritten) => {
      chrome.runtime.sendMessage({
        type: "offscreen_download_progress",
        jobId,
        sessionId,
        index,
        bytesWritten,
        totalBytes
      }, () => { void chrome.runtime.lastError; });
    };

    await writeResponseToFile(response, fileHandle, {
      signal: controller.signal,
      startOffset: offset,
      onProgress
    });

    activeJobs.delete(jobId);
    chrome.runtime.sendMessage({
      type: "offscreen_download_done",
      jobId,
      sessionId,
      index,
      filename
    }, () => { void chrome.runtime.lastError; });
  } catch (err) {
    activeJobs.delete(jobId);
    const aborted = err?.name === "AbortError" || controller.signal.aborted;

    if (dirHandle && filename) {
      try {
        await dirHandle.removeEntry(filename);
      } catch (e) {
        // file might not exist yet or already removed
      }
    }

    chrome.runtime.sendMessage({
      type: "offscreen_download_failed",
      jobId,
      sessionId,
      index,
      cancelled: aborted,
      status: err?.status,
      error: err?.message || String(err)
    }, () => { void chrome.runtime.lastError; });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "offscreen_start_download") {
    downloadJob(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "offscreen_cancel_job") {
    const job = activeJobs.get(message.jobId);
    if (job) {
      job.controller.abort();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "offscreen_audit_jobs") {
    const requestedIds = message.jobIds || [];
    const aliveJobIds = requestedIds.filter((id) => activeJobs.has(id));
    sendResponse({ ok: true, aliveJobIds });
    return true;
  }

  if (message.type === "offscreen_ping") {
    sendResponse({ ok: true });
    return true;
  }
});
