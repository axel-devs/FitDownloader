// IndexedDB helpers for per-tab DirectoryHandle storage.
// Shared by popup, background, and offscreen (same extension origin).

const FS_DB_NAME = "fitdownloader-fs";
const FS_DB_VERSION = 1;
const FS_STORE = "directoryHandles";

function openFsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB_NAME, FS_DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FS_STORE)) {
        db.createObjectStore(FS_STORE);
      }
    };
  });
}

async function idbPut(key, value) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB put failed"));
    tx.objectStore(FS_STORE).put(value, String(key));
  });
}

async function idbGet(key) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readonly");
    const req = tx.objectStore(FS_STORE).get(String(key));
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
  });
}

async function idbDelete(key) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
    tx.objectStore(FS_STORE).delete(String(key));
  });
}

async function storeDirectoryHandle(tabId, handle) {
  await idbPut(tabId, handle);
}

async function loadDirectoryHandle(tabId) {
  return idbGet(tabId);
}

async function clearDirectoryHandle(tabId) {
  await idbDelete(tabId);
}

async function ensureReadWritePermission(handle, { request = false } = {}) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  let state = await handle.queryPermission(opts);
  if (state === "granted") return true;
  if (!request) return false;
  state = await handle.requestPermission(opts);
  return state === "granted";
}

function sanitizeFilename(name) {
  const cleaned = String(name || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "download";
}

function filenameFromItem(item, contentDisposition) {
  if (contentDisposition) {
    const utf = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf?.[1]) {
      try {
        return sanitizeFilename(decodeURIComponent(utf[1].trim()));
      } catch (e) {
        // fall through
      }
    }
    const plain = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i)
      || contentDisposition.match(/filename\s*=\s*([^;]+)/i);
    if (plain?.[1]) {
      return sanitizeFilename(plain[1].trim());
    }
  }

  const label = typeof item?.label === "string" ? item.label.trim() : "";
  if (label && /\.\w{2,5}$/i.test(label) && !/^https?:/i.test(label)) {
    return sanitizeFilename(label);
  }

  try {
    const parsed = new URL(item?.url || "");
    if (parsed.hash && parsed.hash.length > 1) {
      return sanitizeFilename(decodeURIComponent(parsed.hash.slice(1)));
    }
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last) return sanitizeFilename(last);
  } catch (e) {
    // fall through
  }

  return sanitizeFilename(label || "download.bin");
}
