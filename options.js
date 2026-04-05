const concurrencyInputEl = document.getElementById("concurrency-input");
const saveButtonEl = document.getElementById("save-button");
const statusEl = document.getElementById("status");

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: "get_settings" }, (response) => {
    if (!response || !response.ok) {
      statusEl.textContent =
        response?.error ||
        chrome.runtime.lastError?.message ||
        "Failed to load settings.";
      return;
    }
    const n = response.settings?.concurrency ?? 5;
    concurrencyInputEl.value = n;
    statusEl.textContent = "";
  });
}

saveButtonEl.addEventListener("click", () => {
  const desired = clampConcurrency(concurrencyInputEl.value);
  chrome.runtime.sendMessage(
    {
      type: "save_settings",
      settings: { concurrency: desired }
    },
    (response) => {
      if (!response || !response.ok) {
        statusEl.textContent =
          response?.error ||
          chrome.runtime.lastError?.message ||
          "Failed to save settings.";
        return;
      }
      concurrencyInputEl.value = response.settings?.concurrency ?? desired;
      statusEl.textContent = "Settings saved.";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);
    }
  );
});

document.addEventListener("DOMContentLoaded", loadSettings);


