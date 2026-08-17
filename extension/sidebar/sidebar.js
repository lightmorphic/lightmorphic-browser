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

function renderUpdateStatus(status) {
  const state = status?.state || "checking";
  appUpdateDot.className = "status-dot";
  updateActionBtn.hidden = true;
  updateHint.textContent = "";
  railUpdateDot.hidden = state !== "available" && state !== "ready";

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
    updateHint.textContent =
      "Saved to your Downloads folder. An extension can't replace the running AppImage itself -- quit, swap the old file for the new one, and relaunch.";
  } else {
    appUpdateDot.classList.add("error");
    updateStatusText.textContent = "Couldn't check for updates";
  }
}

async function loadUpdateStatus() {
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  renderUpdateStatus(updateStatus);
}

updateActionBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "lightmorphic-download-update" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.updateStatus) renderUpdateStatus(changes.updateStatus.newValue);
});

// ---- Search engine ----
document.getElementById("changeSearchEngineBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/searchEngines" });
});

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

async function loadWebPanels() {
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  webPanelList.innerHTML = "";
  for (const url of webPanels) {
    const item = document.createElement("div");
    item.className = "panel-item";

    const label = document.createElement("span");
    label.textContent = url;
    label.addEventListener("click", () => {
      webPanelFrame.src = url;
      webPanelFrame.hidden = false;
    });

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
  webPanelFrame.src = tab.url;
  webPanelFrame.hidden = false;
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
        bookmarkFrame.src = node.url;
        bookmarkFrame.hidden = false;
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
