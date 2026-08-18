import { pull, push, isConfigured, setupSync } from "../sync/syncClient.js";

// ---- Icon rail ----
for (const btn of document.querySelectorAll(".rail-btn")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rail-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    document.querySelectorAll(".panel-view").forEach((p) => {
      p.classList.toggle("active", p.id === `panel-${btn.dataset.panel}`);
    });
  });
}

// ---- Update ----
// House style: green = up to date, yellow = update available (click to
// download), hollow ring = downloading, blue = ready (click applies the
// downloaded AppImage isn't possible from extension code -- see below --
// so this state instead tells the user how to finish it), red = can't
// connect. State lives in chrome.storage, set by background.js so the
// check logic isn't duplicated here.
const appUpdateDot = document.getElementById("appUpdateDot");
const railUpdateDot = document.getElementById("railUpdateDot");
const updateStatusText = document.getElementById("updateStatusText");
const updateActionBtn = document.getElementById("updateActionBtn");
const updateHint = document.getElementById("updateHint");
const footerUpdateDot = document.getElementById("footerUpdateDot");
const footerUpdateVersion = document.getElementById("footerUpdateVersion");
const footerUpdateWidget = document.getElementById("footerUpdateWidget");

const DOT_CLASS = { ok: "ok", available: "update", downloading: "downloading", ready: "ready", error: "error" };

let currentUpdateState = "checking";

function renderUpdateStatus(status) {
  const state = status?.state || "checking";
  currentUpdateState = state;
  appUpdateDot.className = "status-dot";
  updateActionBtn.hidden = true;
  updateActionBtn.dataset.action = "download";
  updateHint.textContent = "";
  railUpdateDot.hidden = state !== "available" && state !== "ready";

  // The permanent footer widget mirrors the same state.
  footerUpdateDot.className = "update-dot";
  if (DOT_CLASS[state]) footerUpdateDot.classList.add(DOT_CLASS[state]);
  const footerTitles = {
    checking: "Checking for updates…",
    ok: "Up to date — click to check again",
    available: `Update available (${status?.latestTag ?? ""}) — click to download`,
    downloading: "Downloading update…",
    ready: "Downloaded — quit, swap the AppImage in place, relaunch",
    error: "Can't reach GitHub to check for updates",
  };
  footerUpdateWidget.title = footerTitles[state] ?? "";

  if (state === "checking") {
    updateStatusText.textContent = "Checking for updates…";
  } else if (state === "ok") {
    appUpdateDot.classList.add("ok");
    updateStatusText.textContent = "Up to date";
  } else if (state === "available") {
    appUpdateDot.classList.add("update");
    updateStatusText.textContent = `Update available (${status.latestTag})`;
    updateActionBtn.hidden = false;
    updateActionBtn.textContent = "Download update";
  } else if (state === "downloading") {
    appUpdateDot.classList.add("downloading");
    updateStatusText.textContent = "Downloading…";
  } else if (state === "ready") {
    appUpdateDot.classList.add("ready");
    updateStatusText.textContent = "Downloaded and ready";
    updateActionBtn.hidden = false;
    updateActionBtn.textContent = "Install & restart";
    updateActionBtn.dataset.action = "install";
    updateHint.textContent = status?.manual
      ? "Couldn't auto-install -- the new file was revealed in your Downloads. Replace your current LMB AppImage with it and relaunch."
      : "Installs the downloaded update and restarts the browser. Your tabs are restored afterwards.";
  } else {
    appUpdateDot.classList.add("error");
    updateStatusText.textContent = "Couldn't check for updates";
  }
}

async function loadUpdateStatus() {
  const info = await fetch(chrome.runtime.getURL("version.json")).then((r) => r.json());
  footerUpdateVersion.textContent = info.browserVersion ? `v${info.browserVersion}` : info.releaseTag;
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  renderUpdateStatus(updateStatus);
}

updateActionBtn.addEventListener("click", () => {
  const type =
    updateActionBtn.dataset.action === "install"
      ? "lightmorphic-install-update"
      : "lightmorphic-download-update";
  chrome.runtime.sendMessage({ type });
});

// Footer widget click affordances by state:
//   available -> download; ready (blue) -> install & restart;
//   ok/error -> re-check.
footerUpdateWidget.addEventListener("click", () => {
  if (currentUpdateState === "available") {
    chrome.runtime.sendMessage({ type: "lightmorphic-download-update" });
  } else if (currentUpdateState === "ready") {
    chrome.runtime.sendMessage({ type: "lightmorphic-install-update" });
  } else if (currentUpdateState === "ok" || currentUpdateState === "error") {
    footerUpdateDot.classList.add("pulse");
    setTimeout(() => footerUpdateDot.classList.remove("pulse"), 1300);
    chrome.runtime.sendMessage({ type: "lightmorphic-check-update" });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.updateStatus) renderUpdateStatus(changes.updateStatus.newValue);
});

// The sidebar always uses the dark theme to match the browser's branded
// dark chrome. (A user-facing light/dark toggle was removed: an extension
// cannot repaint the browser chrome at runtime -- only the sidebar -- and
// the only way to change the chrome is a full restart, which was fragile.
// So rather than a control that only themes the panel, there is none.)
document.documentElement.setAttribute("data-theme", "dark");

// ---- Search engine ----
document.getElementById("changeSearchEngineBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/searchEngines" });
});

// ---- Framing pinned sites ----
// Most big sites (BBC, Google, etc.) send X-Frame-Options or a CSP
// frame-ancestors directive that forbids being loaded in an iframe --
// so a plain iframe just shows "refused to connect". To load them in
// the panel we strip those response headers, but ONLY for the exact
// host the user deliberately pinned/opened, via a per-host session
// declarativeNetRequest rule. Clickjacking protection stays fully intact
// for every other site in the browser; the tradeoff is limited to sites
// the user explicitly chose to embed. (DNR can only remove a whole
// header, not edit within CSP, so the site's entire CSP is dropped for
// its framed load -- documented, and scoped to that one host.)
function hostRuleId(host) {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) & 0x7fffffff;
  return (h % 2000000000) + 1; // DNR ids must be >= 1
}

async function allowFramingFor(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  const id = hostRuleId(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "x-frame-options", operation: "remove" },
            { header: "content-security-policy", operation: "remove" },
            { header: "content-security-policy-report-only", operation: "remove" },
          ],
        },
        condition: { requestDomains: [host], resourceTypes: ["sub_frame"] },
      },
    ],
  });
}

async function loadInFrame(frame, url) {
  await allowFramingFor(url);
  frame.src = url;
  frame.hidden = false;
}

// ---- Notepad ----
const notepad = document.getElementById("notepad");
let notepadSaveTimer = null;

async function loadNotepad() {
  const { notepadText = "" } = await chrome.storage.local.get("notepadText");
  notepad.value = notepadText;

  if (await isConfigured()) {
    const { value } = await pull("settings");
    if (value?.notepadText !== undefined && value.notepadText !== notepadText) {
      notepad.value = value.notepadText;
      await chrome.storage.local.set({ notepadText: value.notepadText });
    }
  }
}

notepad.addEventListener("input", () => {
  clearTimeout(notepadSaveTimer);
  notepadSaveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ notepadText: notepad.value });
    if (await isConfigured()) {
      const { value, version } = await pull("settings");
      await push("settings", { ...(value || {}), notepadText: notepad.value }, version);
    }
  }, 600);
});

// ---- Web panels ----
const webPanelList = document.getElementById("webPanelList");
const webPanelFrame = document.getElementById("webPanelFrame");
const addPanelForm = document.getElementById("addPanelForm");
const addPanelUrl = document.getElementById("addPanelUrl");
const pinCurrentPageBtn = document.getElementById("pinCurrentPageBtn");
const pinCurrentPageLabel = document.getElementById("pinCurrentPageLabel");

async function pinUrl(url) {
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  if (!webPanels.includes(url)) {
    await chrome.storage.local.set({ webPanels: [...webPanels, url] });
  }
  loadWebPanels();
}

// Pinned sites also render as favicon buttons in the rail itself
// (Vivaldi-style), below the section icons with a "+" underneath.
// Favicons come from DuckDuckGo's icon service, consistent with the
// no-Google stance; a broken icon falls back to a plain dot glyph.
const railSites = document.getElementById("railSites");
const railAddSite = document.getElementById("railAddSite");

function openPanelSite(url) {
  document.querySelectorAll(".rail-btn[data-panel]").forEach((b) => {
    const on = b.dataset.panel === "panels";
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".panel-view").forEach((p) => {
    p.classList.toggle("active", p.id === "panel-panels");
  });
  loadInFrame(webPanelFrame, url);
}

function renderRailSites(webPanels) {
  railSites.innerHTML = "";
  for (const url of webPanels) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "rail-btn";
    btn.title = host;
    const img = document.createElement("img");
    img.className = "rail-site-icon";
    img.src = `https://icons.duckduckgo.com/ip3/${host}.ico`;
    img.alt = "";
    img.addEventListener("error", () => {
      img.remove();
      btn.textContent = "•";
    });
    btn.appendChild(img);
    btn.addEventListener("click", () => openPanelSite(url));
    railSites.appendChild(btn);
  }
}

async function loadWebPanels() {
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  renderRailSites(webPanels);
  webPanelList.innerHTML = "";
  for (const url of webPanels) {
    const item = document.createElement("div");
    item.className = "panel-item";

    const label = document.createElement("span");
    label.textContent = url;
    label.addEventListener("click", () => loadInFrame(webPanelFrame, url));

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Unpin";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { webPanels: current = [] } = await chrome.storage.local.get("webPanels");
      await chrome.storage.local.set({ webPanels: current.filter((u) => u !== url) });
      loadWebPanels();
    });

    item.append(label, remove);
    webPanelList.appendChild(item);
  }
}

railAddSite.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) return;
  await pinUrl(tab.url);
  openPanelSite(tab.url);
});

addPanelForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = addPanelUrl.value.trim();
  if (!url) return;
  await pinUrl(url);
  addPanelUrl.value = "";
});

// Vivaldi-style quick add: grab whatever the user is actually looking at
// right now instead of making them copy/paste the URL.
pinCurrentPageBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    pinCurrentPageLabel.textContent = "Can't pin this page";
    setTimeout(() => { pinCurrentPageLabel.textContent = "Pin this page"; }, 1500);
    return;
  }
  await pinUrl(tab.url);
  loadInFrame(webPanelFrame, tab.url);
});

// ---- Bookmarks ----
const bookmarkFrame = document.getElementById("bookmarkFrame");
const bookmarkCurrentPageBtn = document.getElementById("bookmarkCurrentPageBtn");
const bookmarkCurrentPageLabel = document.getElementById("bookmarkCurrentPageLabel");

async function loadBookmarks() {
  const tree = document.getElementById("bookmarkTree");
  tree.innerHTML = "";
  const [root] = await chrome.bookmarks.getTree();

  function render(node, container) {
    if (node.children) {
      if (node.title) {
        const heading = document.createElement("div");
        heading.className = "bookmark-folder";
        heading.textContent = node.title;
        container.appendChild(heading);
      }
      node.children.forEach((child) => render(child, container));
    } else if (node.url) {
      // Opens inside the sidebar's own frame rather than a new tab --
      // bookmarks behave the same way pinned panels do.
      const link = document.createElement("a");
      link.href = node.url;
      link.textContent = node.title || node.url;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        loadInFrame(bookmarkFrame, node.url);
      });
      container.appendChild(link);
    }
  }

  render(root, tree);
}

bookmarkCurrentPageBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    bookmarkCurrentPageLabel.textContent = "Can't bookmark this page";
    setTimeout(() => { bookmarkCurrentPageLabel.textContent = "Bookmark this page"; }, 1500);
    return;
  }
  await chrome.bookmarks.create({ title: tab.title || tab.url, url: tab.url });
  bookmarkCurrentPageLabel.textContent = "Bookmarked";
  setTimeout(() => { bookmarkCurrentPageLabel.textContent = "Bookmark this page"; }, 1500);
});

// ---- Snippets ----
const snippetList = document.getElementById("snippetList");
const addSnippetForm = document.getElementById("addSnippetForm");
const addSnippetLabel = document.getElementById("addSnippetLabel");
const addSnippetText = document.getElementById("addSnippetText");

async function loadSnippets() {
  const { snippets = [] } = await chrome.storage.local.get("snippets");
  snippetList.innerHTML = "";
  for (const snippet of snippets) {
    const item = document.createElement("div");
    item.className = "panel-item";

    const label = document.createElement("span");
    label.textContent = snippet.label || snippet.text.slice(0, 40);
    label.title = snippet.text;

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Delete";
    remove.addEventListener("click", async () => {
      const { snippets: current = [] } = await chrome.storage.local.get("snippets");
      await chrome.storage.local.set({ snippets: current.filter((s) => s.id !== snippet.id) });
      loadSnippets();
    });

    item.append(label, remove);
    snippetList.appendChild(item);
  }
}

addSnippetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = addSnippetText.value.trim();
  if (!text) return;
  const { snippets = [] } = await chrome.storage.local.get("snippets");
  const next = [...snippets, { id: crypto.randomUUID(), label: addSnippetLabel.value.trim(), text }];
  await chrome.storage.local.set({ snippets: next });
  addSnippetLabel.value = "";
  addSnippetText.value = "";
  loadSnippets();
});

// ---- Status row ----
async function loadStatus() {
  const dot = document.getElementById("syncStatusDot");
  const text = document.getElementById("statusText");
  const configured = await isConfigured();
  dot.className = `status-dot ${configured ? "ok" : ""}`;
  text.textContent = configured ? "Synced" : "Sync not set up";
}

// ---- Sync setup (lives inline in the Settings panel, not a modal) ----
const syncSetupForm = document.getElementById("syncSetupForm");

syncSetupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const passphrase = document.getElementById("syncPassphrase").value;
  const serverInput = document.getElementById("syncServerUrl").value.trim();
  const isNewAccount = document.getElementById("syncIsNewAccount").checked;
  if (!passphrase) return;

  try {
    await setupSync({
      passphrase,
      server: serverInput || undefined,
      isNewAccount,
    });
    await loadStatus();
  } catch (err) {
    alert(`Sync setup failed: ${err.message}`);
  }
});

loadNotepad();
loadWebPanels();
loadBookmarks();
loadSnippets();
loadStatus();
loadUpdateStatus();

chrome.bookmarks.onCreated.addListener(loadBookmarks);
chrome.bookmarks.onRemoved.addListener(loadBookmarks);
chrome.bookmarks.onChanged.addListener(loadBookmarks);
