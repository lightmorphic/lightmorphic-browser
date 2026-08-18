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

// ---- Update system ----
// Update status can't live as an OS-level overlay (nothing can inject
// into Chromium's own browser chrome from outside), so the real detail
// lives in the sidebar's Settings panel (a proper coloured dot, matching
// house style) with a lightweight badge on the toolbar icon as a
// secondary signal. State is shared via chrome.storage so the sidebar
// can render it without duplicating the check logic.
//
// Honest limit: a downloaded AppImage can't safely replace the one
// currently running itself from extension code alone (no filesystem
// access beyond the Downloads folder, no permission to exec anything) --
// "click to update" downloads the new AppImage for real via
// chrome.downloads, then tells the user to swap it in and relaunch,
// rather than claiming a silent one-click self-replace that isn't
// actually achievable without a native-messaging helper (not built).
async function checkForUpdate() {
  await chrome.storage.local.set({ updateStatus: { state: "checking" } });
  try {
    const res = await fetch("https://api.github.com/repos/lightmorphic/lightmorphic-browser/releases/latest");
    if (!res.ok) throw new Error(String(res.status));
    const release = await res.json();
    // NOT the extension's own manifest version -- that tracks the
    // extension's code, not the bundled Chromium release, and would
    // never match a release tag like "v151.0.7922.137", showing "update
    // available" permanently even when fully current. version.json is
    // written by build.sh with the actual release this AppImage is.
    const versionInfo = await fetch(chrome.runtime.getURL("version.json")).then((r) => r.json());
    const current = versionInfo.releaseTag;
    const asset = release.assets?.find((a) => a.name?.endsWith(".AppImage"));

    if (release.tag_name && release.tag_name !== current) {
      await chrome.storage.local.set({
        updateStatus: { state: "available", latestTag: release.tag_name, downloadUrl: asset?.browser_download_url },
      });
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#FBC711" });
      chrome.action.setTitle({ title: `LMB -- update available (${release.tag_name})` });
    } else {
      await chrome.storage.local.set({ updateStatus: { state: "ok" } });
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "LMB" });
    }
  } catch {
    await chrome.storage.local.set({ updateStatus: { state: "error" } });
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#9E9D9E" });
    chrome.action.setTitle({ title: "LMB -- couldn't check for updates" });
  }
}

let activeDownloadId = null;

async function downloadUpdate() {
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  if (updateStatus?.state !== "available" || !updateStatus.downloadUrl) return;
  await chrome.storage.local.set({ updateStatus: { ...updateStatus, state: "downloading" } });
  activeDownloadId = await chrome.downloads.download({ url: updateStatus.downloadUrl, saveAs: false });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.id !== activeDownloadId) return;
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  if (delta.state?.current === "complete") {
    // Record the absolute path of the downloaded AppImage so the native
    // updater knows what to install.
    const [item] = await chrome.downloads.search({ id: activeDownloadId });
    await chrome.storage.local.set({
      updateStatus: { ...updateStatus, state: "ready", filePath: item?.filename, downloadId: activeDownloadId },
    });
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#2295F1" });
  } else if (delta.state?.current === "interrupted") {
    await chrome.storage.local.set({ updateStatus: { ...updateStatus, state: "error" } });
  }
});

// Blue "ready" state clicked -> hand the downloaded AppImage to the native
// updater, which swaps it in and relaunches. If the native host isn't
// present (e.g. running the unpacked extension outside the AppImage, or a
// packaging where registration didn't happen), fall back to revealing the
// file so the user can swap it manually -- so the click never silently
// does nothing.
async function installUpdate() {
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  if (updateStatus?.state !== "ready" || !updateStatus.filePath) return;

  let handled = false;
  try {
    const port = chrome.runtime.connectNative("co.lightmorphic.updater");
    port.onMessage.addListener(() => {
      handled = true; // updater acked; the browser is about to be restarted
    });
    port.onDisconnect.addListener(async () => {
      if (!handled) {
        // Host not found / failed to start -> manual fallback.
        if (updateStatus.downloadId != null) chrome.downloads.show(updateStatus.downloadId);
        await chrome.storage.local.set({ updateStatus: { ...updateStatus, state: "ready", manual: true } });
      }
    });
    port.postMessage({ action: "install", new: updateStatus.filePath });
  } catch {
    if (updateStatus.downloadId != null) chrome.downloads.show(updateStatus.downloadId);
    await chrome.storage.local.set({ updateStatus: { ...updateStatus, state: "ready", manual: true } });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lightmorphic-download-update") downloadUpdate();
  if (message?.type === "lightmorphic-check-update") checkForUpdate();
  if (message?.type === "lightmorphic-install-update") installUpdate();
  return false;
});

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

// The new-tab override (chrome_url_overrides) only applies to tabs opened
// AFTER the unpacked extension has registered -- so the very first tab at
// startup shows the stock Chromium NTP instead of the LMB search page.
// Once the worker is up we redirect any stock-NTP tab to our page. The
// loop is AWAITED by the event listener so the MV3 service worker stays
// alive across the retries (a bare setTimeout gets killed when the worker
// suspends after the event handler returns -- that's why the first
// attempt at this didn't work).
async function redirectStockNtp() {
  const our = chrome.runtime.getURL("newtab/newtab.html");
  for (let i = 0; i < 12; i++) {
    const tabs = await chrome.tabs.query({});
    let redirected = false;
    for (const t of tabs) {
      const u = t.url || t.pendingUrl || "";
      if (u === "chrome://newtab/" || u.startsWith("chrome://new-tab-page")) {
        try {
          await chrome.tabs.update(t.id, { url: our });
          redirected = true;
        } catch {
          /* tab gone */
        }
      }
    }
    if (redirected) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Belt-and-suspenders: also catch a stock NTP that commits late.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const u = info.url || "";
  if (u === "chrome://newtab/" || u.startsWith("chrome://new-tab-page")) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL("newtab/newtab.html") }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildQuickPasteMenu();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 30 });
  checkForUpdate();
  await redirectStockNtp();
});

// onInstalled only fires on first load / version bump, not every browser
// launch -- onStartup covers the normal "opened the browser today" case.
chrome.runtime.onStartup.addListener(async () => {
  checkForUpdate();
  await redirectStockNtp();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSyncPass();
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// A truly permanent, un-closable rail like Vivaldi's isn't reachable from
// an extension -- that's real native browser-chrome UI, not something the
// sidePanel API can inject. Tried auto-opening on new-window creation as
// the closest approximation; chrome.sidePanel.open() silently does
// nothing when called outside a direct user gesture (confirmed by
// testing, not assumed -- no error is logged, the panel just never
// appears), so a window-creation event doesn't qualify. Click-to-open
// remains the real mechanism; once opened it does stay open across tab
// switches in that window until deliberately closed.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
