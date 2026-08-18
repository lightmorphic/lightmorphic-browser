// New tab page: DuckDuckGo search plus the house update-widget (version
// number + coloured circle, bottom-left). Update state comes from
// chrome.storage, written by background.js -- same source the sidebar's
// Settings panel reads, so the two can't disagree.

const searchForm = document.getElementById("searchForm");
const searchBox = document.getElementById("searchBox");
const updateDot = document.getElementById("updateDot");
const updateVersion = document.getElementById("updateVersion");
const updateWidget = document.getElementById("updateWidget");

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchBox.value.trim();
  if (!q) return;
  // Bare domains / URLs navigate directly; anything else searches.
  const looksLikeUrl = /^(https?:\/\/|[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$))/i.test(q);
  const url = looksLikeUrl
    ? (q.startsWith("http") ? q : `https://${q}`)
    : `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
  location.href = url;
});

let currentState = "checking";

async function loadVersion() {
  const info = await fetch(chrome.runtime.getURL("version.json")).then((r) => r.json());
  updateVersion.textContent = info.browserVersion ? `v${info.browserVersion}` : info.releaseTag;
}

function render(status) {
  currentState = status?.state || "checking";
  updateDot.className = "update-dot";
  const titles = {
    checking: "Checking for updates…",
    ok: "Up to date — click to check again",
    available: `Update available (${status?.latestTag ?? ""}) — click to download`,
    downloading: "Downloading update…",
    ready: "Downloaded — quit, swap the AppImage in place, relaunch",
    error: "Can't reach GitHub to check for updates",
  };
  const dotClass = { ok: "ok", available: "update", downloading: "downloading", ready: "ready", error: "error" }[currentState];
  if (dotClass) updateDot.classList.add(dotClass);
  updateWidget.title = titles[currentState] ?? "";
}

updateWidget.addEventListener("click", () => {
  if (currentState === "available") {
    chrome.runtime.sendMessage({ type: "lightmorphic-download-update" });
  } else if (currentState === "ok" || currentState === "error") {
    // Gentle pulse acknowledges the manual re-check.
    updateDot.classList.add("pulse");
    setTimeout(() => updateDot.classList.remove("pulse"), 1300);
    chrome.runtime.sendMessage({ type: "lightmorphic-check-update" });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.updateStatus) render(changes.updateStatus.newValue);
});

loadVersion();
chrome.storage.local.get("updateStatus").then(({ updateStatus }) => render(updateStatus));
