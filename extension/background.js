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

// One click does the WHOLE update: download, then install + restart as
// soon as the download completes. The old flow needed a second click on
// the blue dot after the download finished -- which nobody realises, so
// it read as "it downloads, but that's about it".
//
// The download id is kept in chrome.storage, NOT a module variable: a
// 180MB AppImage takes minutes, the MV3 service worker gets killed after
// ~30s idle, and a module variable dies with it -- so the completion
// event compared against null and was silently ignored, leaving the
// widget stuck on "downloading" forever. chrome.downloads.onChanged
// re-wakes the worker; the id it needs must survive that death.
async function downloadUpdate() {
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  if (updateStatus?.state !== "available" || !updateStatus.downloadUrl) return;
  const downloadId = await chrome.downloads.download({ url: updateStatus.downloadUrl, saveAs: false });
  await chrome.storage.local.set({
    updateStatus: { ...updateStatus, state: "downloading", downloadId, autoInstall: true },
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const { updateStatus } = await chrome.storage.local.get("updateStatus");
  if (!updateStatus || updateStatus.downloadId !== delta.id) return;
  if (delta.state?.current === "complete") {
    // Record the absolute path of the downloaded AppImage so the native
    // updater knows what to install.
    const [item] = await chrome.downloads.search({ id: delta.id });
    await chrome.storage.local.set({
      updateStatus: { ...updateStatus, state: "ready", filePath: item?.filename },
    });
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#2295F1" });
    if (updateStatus.autoInstall) await installUpdate();
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

// ---- LMB Shield (ad / tracker blocking) ----
// The blocking itself is done natively by Chromium's declarativeNetRequest
// engine using static rulesets compiled from EasyList, EasyPrivacy and
// Fanboy's Annoyances (the same lists uBlock Origin uses) -- see
// tools/build-shield-rules.py and extension/shield/rules/.
//
// Protection LEVELS (global, persisted in shieldLevel):
//   off       -> nothing blocked
//   essential -> trackers (EasyPrivacy)
//   balanced  -> ads + trackers (EasyList + EasyPrivacy)  [default]
//   strict    -> + annoyances (cookie pop-ups, floating widgets)
// The level maps to which static rulesets are enabled; that choice is
// re-applied on every boot so it survives restarts and the manifest's
// defaults never fight the user.
//
// PER-SITE pause (shieldSiteExceptions, a list of hostnames): a
// max-priority allowAllRequests session rule per host -- everything a
// page on that host loads is allowed, exactly uBO's per-site power
// switch. Session rules vanish on restart, so boot re-adds them from
// storage; the LIST is what persists.
const SHIELD_ALL_RULESETS = ["easylist", "easyprivacy", "annoyances"];
const SHIELD_LEVEL_RULESETS = {
  off: [],
  essential: ["easyprivacy"],
  balanced: ["easylist", "easyprivacy"],
  strict: ["easylist", "easyprivacy", "annoyances"],
};
const SITE_EXCEPTION_RULE_BASE = 900000000;

async function getShieldLevel() {
  const { shieldLevel, shieldEnabled } = await chrome.storage.local.get(["shieldLevel", "shieldEnabled"]);
  if (shieldLevel && SHIELD_LEVEL_RULESETS[shieldLevel]) return shieldLevel;
  // Migrate the old boolean toggle: an explicit "off" is respected.
  return shieldEnabled === false ? "off" : "balanced";
}

function siteExceptionRuleId(host) {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) & 0x7fffffff;
  return SITE_EXCEPTION_RULE_BASE + (h % 90000000);
}

async function applySiteExceptions() {
  const { shieldSiteExceptions = [] } = await chrome.storage.local.get("shieldSiteExceptions");
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const oldIds = existing
      .map((r) => r.id)
      .filter((id) => id >= SITE_EXCEPTION_RULE_BASE && id < SITE_EXCEPTION_RULE_BASE + 90000000);
    const addRules = shieldSiteExceptions.map((host) => ({
      id: siteExceptionRuleId(host),
      priority: 900000,
      action: { type: "allowAllRequests" },
      condition: {
        requestDomains: [host],
        resourceTypes: ["main_frame", "sub_frame"],
      },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: oldIds, addRules });
  } catch {
    /* DNR unavailable */
  }
}

async function applyShieldState() {
  const level = await getShieldLevel();
  const want = SHIELD_LEVEL_RULESETS[level];
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: SHIELD_ALL_RULESETS.filter((id) => !want.includes(id)),
      enableRulesetIds: want,
    });
  } catch {
    /* ruleset ids not present (e.g. rules not built) -- nothing to toggle */
  }
  await applySiteExceptions();
}

async function setShieldLevel(level) {
  if (!SHIELD_LEVEL_RULESETS[level]) return;
  await chrome.storage.local.set({ shieldLevel: level });
  await applyShieldState();
}

async function setSitePaused(host, paused) {
  if (!host) return;
  const { shieldSiteExceptions = [] } = await chrome.storage.local.get("shieldSiteExceptions");
  const next = paused
    ? [...new Set([...shieldSiteExceptions, host])]
    : shieldSiteExceptions.filter((h) => h !== host);
  await chrome.storage.local.set({ shieldSiteExceptions: next });
  await applySiteExceptions();
}

// ---- Cookies ----
// Enforced by Chromium's own content-settings engine (the same machinery
// behind chrome://settings/content/cookies), which persists rules in the
// profile natively. Three modes, global and per-site:
//   allow | session_only (accepted, wiped when the browser closes) | block
// Our storage (cookieGlobalSetting + cookieSiteRules) is the source of
// truth for the UI; applyCookieRules() clears our previously-set rules
// and re-applies the whole set, so removing a per-site override is just
// dropping it from the map. Re-run at boot for consistency (idempotent).
async function applyCookieRules() {
  if (!chrome.contentSettings?.cookies) return;
  const { cookieGlobalSetting = "allow", cookieSiteRules = {} } =
    await chrome.storage.local.get(["cookieGlobalSetting", "cookieSiteRules"]);
  const cookies = chrome.contentSettings.cookies;
  await new Promise((r) => cookies.clear({}, r));
  if (cookieGlobalSetting !== "allow") {
    await new Promise((r) =>
      cookies.set({ primaryPattern: "<all_urls>", setting: cookieGlobalSetting }, r)
    );
  }
  for (const [host, setting] of Object.entries(cookieSiteRules)) {
    for (const scheme of ["http", "https"]) {
      await new Promise((r) =>
        cookies.set({ primaryPattern: `${scheme}://[*.]${host}/*`, setting }, r)
      );
    }
  }
}

// "This session only" must mean it: cookies added during a session are
// gone by the next one. Chromium's session_only content setting deletes
// them on a CLEAN exit, but after a crash/kill it deliberately keeps
// session cookies for recovery (verified live: a killed session's cookie
// survived into the next launch). This boot-time sweep closes that gap:
// under a session-only policy, wipe cookies at the start of each session
// -- keeping cookies for sites the user explicitly set to "allow".
async function enforceSessionCookiePolicy() {
  if (!chrome.browsingData) return;
  const { cookieGlobalSetting = "allow", cookieSiteRules = {} } =
    await chrome.storage.local.get(["cookieGlobalSetting", "cookieSiteRules"]);
  const originsFor = (host) => [`https://${host}`, `http://${host}`];
  try {
    if (cookieGlobalSetting === "session_only") {
      const keep = Object.entries(cookieSiteRules)
        .filter(([, s]) => s === "allow")
        .flatMap(([h]) => originsFor(h));
      await chrome.browsingData.remove({ excludeOrigins: keep }, { cookies: true });
    } else {
      const wipe = Object.entries(cookieSiteRules)
        .filter(([, s]) => s === "session_only")
        .flatMap(([h]) => originsFor(h));
      if (wipe.length) {
        await chrome.browsingData.remove({ origins: wipe }, { cookies: true });
      }
    }
  } catch {
    /* browsingData unavailable -- Chromium's own clean-exit path still applies */
  }
}

async function setCookieGlobal(setting) {
  if (!["allow", "session_only", "block"].includes(setting)) return;
  await chrome.storage.local.set({ cookieGlobalSetting: setting });
  await applyCookieRules();
}

async function setCookieSite(host, setting) {
  if (!host) return;
  const { cookieSiteRules = {} } = await chrome.storage.local.get("cookieSiteRules");
  if (setting === "default") delete cookieSiteRules[host];
  else if (["allow", "session_only", "block"].includes(setting)) cookieSiteRules[host] = setting;
  else return;
  await chrome.storage.local.set({ cookieSiteRules });
  await applyCookieRules();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "lightmorphic-shield-level") {
    setShieldLevel(message.level).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (message?.type === "lightmorphic-shield-site") {
    setSitePaused(message.host, !!message.paused).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "lightmorphic-cookies-global") {
    setCookieGlobal(message.setting).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "lightmorphic-cookies-site") {
    setCookieSite(message.host, message.setting).then(() => sendResponse({ ok: true }));
    return true;
  }
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
//
// And then GUARANTEE the search page: startup doesn't always produce a
// stock NTP to redirect -- a session-restore launch (which every
// self-update restart is) reopens the previous tabs and nothing else, so
// there was no LMB search page at the start at all. After the redirect
// pass, if no tab is our search page, open one in the foreground.
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

async function ensureSearchPageTab() {
  const our = chrome.runtime.getURL("newtab/newtab.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url || t.pendingUrl || "").startsWith(our));
  if (existing) {
    // Reload, don't trust: session restore can resurrect this tab as a
    // stale ERROR page (seen live: a transiently-blocked search page came
    // back as "blocked by LMB" on every launch, and a bare URL check
    // counted that corpse as "search page present"). The page is a
    // stateless search box -- reloading is free and always heals it.
    await chrome.tabs.reload(existing.id).catch(() => {});
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: our, active: true }).catch(() => {});
  }
}

// Our own UI must never be blockable by Shield's filter lists. The lists
// are refetched upstream every build; a pattern could in principle match
// our extension URLs, and a blocked main frame renders Chromium's
// "blocked by LMB" error page instead of the browser's own search page.
// A maximum-priority session ALLOW rule for our origin makes that
// structurally impossible (session rules re-add on every boot, so this
// also can't go stale). Belt and braces with the converter change that
// keeps list rules off main_frame navigations entirely.
const OWN_UI_ALLOW_RULE_ID = 999999901;

async function protectOwnUi() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [OWN_UI_ALLOW_RULE_ID],
      addRules: [
        {
          id: OWN_UI_ALLOW_RULE_ID,
          priority: 1000000,
          action: { type: "allow" },
          condition: {
            urlFilter: `|chrome-extension://${chrome.runtime.id}/`,
            resourceTypes: [
              "main_frame", "sub_frame", "stylesheet", "script", "image",
              "font", "object", "xmlhttprequest", "ping", "media",
              "websocket", "other",
            ],
          },
        },
      ],
    });
  } catch {
    /* DNR unavailable -- nothing to protect against either */
  }
}

// Privacy defaults for EXISTING profiles: the Preferences seeding in
// AppRun only runs on a genuinely fresh profile, so long-lived installs
// never got "password manager off / autofill off". chrome.privacy can
// set the same things at runtime. Applied ONCE (flag-guarded) so a user
// who deliberately re-enables something isn't fought on every launch.
async function applyPrivacyDefaults() {
  const { privacyDefaultsApplied } = await chrome.storage.local.get("privacyDefaultsApplied");
  if (privacyDefaultsApplied || !chrome.privacy?.services) return;
  const set = (pref, value) =>
    new Promise((resolve) => {
      try {
        pref.set({ value }, resolve);
      } catch {
        resolve();
      }
    });
  await set(chrome.privacy.services.passwordSavingEnabled, false);
  await set(chrome.privacy.services.autofillAddressEnabled, false);
  await set(chrome.privacy.services.autofillCreditCardEnabled, false);
  await chrome.storage.local.set({ privacyDefaultsApplied: true });
}

// One-time pin migration (v2): remove the Wikipedia "Cat" article a
// v0.13 development test leaked into a real profile's webPanels, and
// seed the LMB home page as the default pinned site (also covers fresh
// profiles, whose webPanels start empty). Runs once per profile; the
// user can of course remove/re-add anything afterwards.
const DEFAULT_PIN = "https://browser.lightmorphic.co.uk";

async function migratePins() {
  const { pinMigration2 } = await chrome.storage.local.get("pinMigration2");
  if (pinMigration2) return;
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  const cleaned = webPanels.filter((u) => u !== "https://en.wikipedia.org/wiki/Cat");
  if (!cleaned.includes(DEFAULT_PIN)) cleaned.unshift(DEFAULT_PIN);
  await chrome.storage.local.set({ webPanels: cleaned, pinMigration2: true });
}

// Belt-and-suspenders: also catch a stock NTP that commits late.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const u = info.url || "";
  if (u === "chrome://newtab/" || u.startsWith("chrome://new-tab-page")) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL("newtab/newtab.html") }).catch(() => {});
  }
});

// ---- Boot ----
// These must run once per BROWSER LAUNCH. Getting a guaranteed carrier
// for that took three attempts, each disproved on a REAL install:
//   1. onStartup -- provably doesn't fire for --load-extension exts.
//   2. SW top-level evaluation -- on an EXISTING profile Chromium doesn't
//      even start the service worker at launch (it waits for an event);
//      fresh QA profiles hid this because onInstalled fires there, and
//      CDP inspection itself wakes workers, masking it during testing.
//   3. Current design: the sidebar and new-tab pages -- which DO reliably
//      exist at every launch (auto-open + guaranteed search tab) -- send
//      a "lightmorphic-boot" ping; message delivery starts the worker.
// The storage.session guard collapses however many triggers fire into
// exactly once per launch (session storage dies with the browser).
// Alarm creation lives here too: alarms don't reliably survive for
// unpacked extensions, so re-create them every launch (idempotent).
// Every step runs in its own guard: one failing API must never kill the
// steps after it (a real profile lost three releases' worth of fixes
// because one unguarded await rejected and silently aborted the rest).
// The per-step outcomes are written to storage as lastBootReport, so a
// misbehaving install can be diagnosed from its profile instead of
// guessed at.
async function bootTasks() {
  const { bootDone } = await chrome.storage.session.get("bootDone");
  if (bootDone) return;
  await chrome.storage.session.set({ bootDone: true });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 30 });
  const report = { at: new Date().toISOString(), steps: {} };
  const step = async (name, fn) => {
    try {
      await fn();
      report.steps[name] = "ok";
    } catch (e) {
      report.steps[name] = `ERROR: ${e?.message || e}`;
    }
  };
  await step("checkForUpdate", () => checkForUpdate());
  await step("applyShieldState", applyShieldState);
  await step("protectOwnUi", protectOwnUi);
  await step("enforceSessionCookiePolicy", enforceSessionCookiePolicy);
  await step("applyCookieRules", applyCookieRules);
  await step("applyPrivacyDefaults", applyPrivacyDefaults);
  await step("migratePins", migratePins);
  await step("redirectStockNtp", redirectStockNtp);
  await step("ensureSearchPageTab", ensureSearchPageTab);
  await chrome.storage.local.set({ lastBootReport: report });
}
bootTasks();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lightmorphic-boot") bootTasks();
  // The sidebar saves settings to storage itself and just asks us to
  // enforce whatever storage now says (shield level, site pauses, cookie
  // rules). Persistence never depends on this worker being healthy.
  if (message?.type === "lightmorphic-apply-settings") {
    applyShieldState().catch(() => {});
    applyCookieRules().catch(() => {});
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildQuickPasteMenu();
  await bootTasks();
});

chrome.runtime.onStartup.addListener(bootTasks);

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
