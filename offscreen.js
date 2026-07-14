// Offscreen download worker: fetch → write into per-tab DirectoryHandle.

const activeJobs = new Map();

async function writeResponseToFile(response, fileHandle, { signal, startOffset = 0 }) {
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
      return startOffset + buf.byteLength;
    }

    const reader = response.body.getReader();
    let written = startOffset;
    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
    }
    return written;
  } finally {
    try {
      await writable.close();
    } catch (e) {
      // ignore close errors after abort
    }
  }
}

async function downloadJob(message) {
  const {
    jobId,
    tabId,
    index,
    url,
    item,
    resumeFrom = 0
  } = message;

  const controller = new AbortController();
  activeJobs.set(jobId, { controller, paused: false });

  try {
    const dirHandle = await loadDirectoryHandle(tabId);
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

    const filename = filenameFromItem(item, response.headers.get("content-disposition"));
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });

    let offset = resumeFrom;
    if (resumeFrom > 0 && response.status !== 206) {
      // server ignored range — rewrite from scratch
      offset = 0;
    }

    await writeResponseToFile(response, fileHandle, {
      signal: controller.signal,
      startOffset: offset
    });

    activeJobs.delete(jobId);
    chrome.runtime.sendMessage({
      type: "offscreen_download_done",
      jobId,
      tabId,
      index,
      filename
    }, () => { void chrome.runtime.lastError; });
  } catch (err) {
    const job = activeJobs.get(jobId);
    activeJobs.delete(jobId);
    const aborted = err?.name === "AbortError" || controller.signal.aborted;
    const paused = aborted && job?.paused === true;

    chrome.runtime.sendMessage({
      type: "offscreen_download_failed",
      jobId,
      tabId,
      index,
      paused,
      cancelled: aborted && !paused,
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

  if (message.type === "offscreen_pause_job") {
    const job = activeJobs.get(message.jobId);
    if (job) {
      job.paused = true;
      job.controller.abort();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "offscreen_cancel_job") {
    const job = activeJobs.get(message.jobId);
    if (job) {
      job.paused = false;
      job.controller.abort();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "offscreen_ping") {
    sendResponse({ ok: true });
    return true;
  }
});
