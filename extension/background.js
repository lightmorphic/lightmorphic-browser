import { isConfigured, pull, push } from "./sync/syncClient.js";

const CLIPBOARD_HISTORY_LIMIT = 20;
const QUICK_PASTE_MENU_ROOT = "lightmorphic-quick-paste";
const SYNC_ALARM = "lightmorphic-sync-poll";
const UPDATE_ALARM = "lightmorphic-update-check";

// ---- Quick paste: context menu ----

async function rebuildQuickPasteMenu() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: QUICK_PASTE_MENU_ROOT,
    title: "Quick paste",
    contexts: ["editable"],
  });

  const { snippets = [] } = await chrome.storage.local.get("snippets");
  if (snippets.length === 0) {
    chrome.contextMenus.create({
      id: "lightmorphic-no-snippets",
      parentId: QUICK_PASTE_MENU_ROOT,
      title: "(no saved snippets yet)",
      enabled: false,
      contexts: ["editable"],
    });
  }
  for (const snippet of snippets) {
    chrome.contextMenus.create({
      id: `lightmorphic-snippet:${snippet.id}`,
      parentId: QUICK_PASTE_MENU_ROOT,
      title: snippet.label || snippet.text.slice(0, 40),
      contexts: ["editable"],
    });
  }

  chrome.contextMenus.create({
    id: "lightmorphic-clipboard-separator",
    parentId: QUICK_PASTE_MENU_ROOT,
    type: "separator",
    contexts: ["editable"],
  });

  const { clipboardHistory = [] } = await chrome.storage.local.get("clipboardHistory");
  if (clipboardHistory.length === 0) {
    chrome.contextMenus.create({
      id: "lightmorphic-no-clipboard",
      parentId: QUICK_PASTE_MENU_ROOT,
      title: "(clipboard history empty)",
      enabled: false,
      contexts: ["editable"],
    });
  }
  clipboardHistory.slice(0, 8).forEach((entry, i) => {
    chrome.contextMenus.create({
      id: `lightmorphic-clip:${i}`,
      parentId: QUICK_PASTE_MENU_ROOT,
      title: entry.slice(0, 40),
      contexts: ["editable"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  let textToInsert = null;

  if (info.menuItemId.startsWith("lightmorphic-snippet:")) {
    const id = info.menuItemId.split(":")[1];
    const { snippets = [] } = await chrome.storage.local.get("snippets");
    textToInsert = snippets.find((s) => s.id === id)?.text ?? null;
  } else if (info.menuItemId.startsWith("lightmorphic-clip:")) {
    const index = Number(info.menuItemId.split(":")[1]);
    const { clipboardHistory = [] } = await chrome.storage.local.get("clipboardHistory");
    textToInsert = clipboardHistory[index] ?? null;
  }

  if (textToInsert === null) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [textToInsert],
    func: (text) => {
      const el = document.activeElement;
      if (!el) return;
      if ("value" in el && typeof el.value === "string") {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el.isContentEditable) {
        document.execCommand("insertText", false, text);
      }
    },
  });
});

// ---- Clipboard history ----
// The page-side clipboard-watcher (extension/contextmenu/clipboard-watch.js,
// injected as a content script) reports newly-copied text here so it can be
// recalled from any tab, not just the one it was copied in.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "lightmorphic-clip-copied") {
    (async () => {
      const { clipboardHistory = [] } = await chrome.storage.local.get("clipboardHistory");
      const next = [message.text, ...clipboardHistory.filter((t) => t !== message.text)].slice(
        0,
        CLIPBOARD_HISTORY_LIMIT
      );
      await chrome.storage.local.set({ clipboardHistory: next });
      await rebuildQuickPasteMenu();
    })();
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.snippets) rebuildQuickPasteMenu();
});

// ---- Update badge ----
// Update status can't live as an OS-level overlay (nothing can inject
// into Chromium's own browser chrome from outside), so it lives on the
// extension's own toolbar icon instead.
async function checkForUpdate() {
  try {
    const res = await fetch("https://api.github.com/repos/lightmorphic/lightmorphic-browser/releases/latest");
    if (!res.ok) throw new Error(String(res.status));
    const { tag_name } = await res.json();
    const manifest = chrome.runtime.getManifest();
    const current = `v${manifest.browser_version || manifest.version}`;
    if (tag_name && tag_name !== current) {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#FBC711" });
      chrome.action.setTitle({ title: `Lightmorphic Browser -- update available (${tag_name})` });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Lightmorphic Browser" });
    }
  } catch {
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#9E9D9E" });
    chrome.action.setTitle({ title: "Lightmorphic Browser -- couldn't check for updates" });
  }
}

// ---- Sync poll ----
async function syncCollection(name, localValue) {
  const { value: remoteValue, version } = await pull(name);
  const merged = remoteValue ?? localValue;
  const result = await push(name, merged, version);
  return result.conflict ? merged : merged;
}

async function runSyncPass() {
  if (!(await isConfigured())) return;
  const { snippets = [], bookmarksCache = [] } = await chrome.storage.local.get(["snippets", "bookmarksCache"]);
  const syncedSnippets = await syncCollection("snippets", snippets);
  await chrome.storage.local.set({ snippets: syncedSnippets });
  await rebuildQuickPasteMenu();
}

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildQuickPasteMenu();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 30 });
  checkForUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSyncPass();
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
