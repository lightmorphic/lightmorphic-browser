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
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  if (!webPanels.includes(url)) {
    await chrome.storage.local.set({ webPanels: [...webPanels, url] });
  }
  addPanelUrl.value = "";
  loadWebPanels();
});

// ---- Bookmarks ----
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
      const link = document.createElement("a");
      link.href = node.url;
      link.textContent = node.title || node.url;
      link.target = "_blank";
      container.appendChild(link);
    }
  }

  render(root, tree);
}

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
  const dot = document.getElementById("updateDot");
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

chrome.bookmarks.onCreated.addListener(loadBookmarks);
chrome.bookmarks.onRemoved.addListener(loadBookmarks);
chrome.bookmarks.onChanged.addListener(loadBookmarks);
