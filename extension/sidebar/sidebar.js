import { pull, push, isConfigured, setupSync } from "../sync/syncClient.js";

// ---- Icon rail ----
// Only tab buttons (data-panel) switch views. The "+" button and the
// pinned-site favicons are .rail-btn too but have their own handlers --
// binding them here used to deactivate every view when "+" was clicked.
for (const btn of document.querySelectorAll(".rail-btn[data-panel]")) {
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
    available: `Update available (${status?.latestTag ?? ""}) — click to update & restart`,
    downloading: "Downloading update — it will install and restart by itself…",
    ready: "Downloaded — click to install & restart",
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
    updateActionBtn.textContent = "Update & restart";
  } else if (state === "downloading") {
    appUpdateDot.classList.add("downloading");
    updateStatusText.textContent = "Downloading — installs & restarts by itself…";
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

// The sidebar follows the browser's own light/dark mode automatically via
// the CSS prefers-color-scheme media query (see sidebar.css) -- no
// hardcoded theme and no toggle. Browser in dark mode -> dark panel;
// browser in light mode -> light panel; auto -> whatever the OS is.

// ---- Search engine ----
document.getElementById("changeSearchEngineBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/searchEngines" });
});

// ---- LMB Shield (ad / tracker blocking) ----
// The blocking runs in the background worker (levels -> enabled rulesets,
// per-site pauses -> session allow rules). This panel reflects and edits
// the persisted choices; the worker re-applies them on every boot.
const shieldDot = document.getElementById("shieldDot");
const shieldStatusText = document.getElementById("shieldStatusText");
const shieldLevels = document.getElementById("shieldLevels");
const shieldSiteHost = document.getElementById("shieldSiteHost");
const shieldSitePause = document.getElementById("shieldSitePause");
const shieldExceptionList = document.getElementById("shieldExceptionList");

const SHIELD_LEVEL_LABELS = {
  off: "Off — nothing is blocked",
  essential: "Essential — blocking trackers",
  balanced: "Balanced — blocking ads & trackers",
  strict: "Strict — ads, trackers & annoyances",
};

function renderShieldLevel(level) {
  for (const input of shieldLevels.querySelectorAll("input[name=shieldLevel]")) {
    input.checked = input.value === level;
  }
  shieldDot.className = "status-dot " + (level === "off" ? "error" : "ok");
  shieldStatusText.textContent = SHIELD_LEVEL_LABELS[level] ?? level;
}

async function currentSiteHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url || "");
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

async function renderShieldSite() {
  const host = await currentSiteHost();
  const { shieldSiteExceptions = [] } = await chrome.storage.local.get("shieldSiteExceptions");
  if (host) {
    shieldSiteHost.textContent = host;
    shieldSitePause.disabled = false;
    shieldSitePause.checked = shieldSiteExceptions.includes(host);
  } else {
    shieldSiteHost.textContent = "(no website open)";
    shieldSitePause.disabled = true;
    shieldSitePause.checked = false;
  }
  shieldExceptionList.innerHTML = "";
  for (const h of shieldSiteExceptions) {
    const item = document.createElement("div");
    item.className = "panel-item";
    const label = document.createElement("span");
    label.textContent = `Paused: ${h}`;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Re-enable Shield on this site";
    remove.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "lightmorphic-shield-site", host: h, paused: false });
    });
    item.append(label, remove);
    shieldExceptionList.appendChild(item);
  }
}

async function loadShield() {
  const { shieldLevel, shieldEnabled } = await chrome.storage.local.get(["shieldLevel", "shieldEnabled"]);
  const level = shieldLevel && SHIELD_LEVEL_LABELS[shieldLevel]
    ? shieldLevel
    : shieldEnabled === false ? "off" : "balanced";
  renderShieldLevel(level);
  await renderShieldSite();
}
loadShield();

shieldLevels.addEventListener("change", (e) => {
  const level = e.target?.value;
  if (!level) return;
  renderShieldLevel(level);
  chrome.runtime.sendMessage({ type: "lightmorphic-shield-level", level });
});

shieldSitePause.addEventListener("change", async () => {
  const host = await currentSiteHost();
  if (!host) return;
  chrome.runtime.sendMessage({ type: "lightmorphic-shield-site", host, paused: shieldSitePause.checked });
});

// Keep "This site" current as the user moves between tabs/pages, and the
// exception list live when the worker updates it.
chrome.tabs.onActivated.addListener(() => renderShieldSite());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status === "complete") renderShieldSite(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.shieldSiteExceptions) renderShieldSite();
  if (area === "local" && changes.shieldLevel) renderShieldLevel(changes.shieldLevel.newValue);
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

// ---- Web panels (pinned sites) ----
// Pinned sites live as favicon buttons in the rail (Vivaldi-style). The
// "+" grabs the current tab's URL, opens a dialog to edit it before
// saving, and the saved site appears as a rail icon. Click an icon to
// open the site in the panel; right-click it to edit or remove. Framing
// headers are stripped per-host in loadInFrame so sites that block
// iframing (BBC etc.) still load.
const webPanelFrame = document.getElementById("webPanelFrame");
const panelsEmpty = document.getElementById("panelsEmpty");
const panelNav = document.getElementById("panelNav");
const panelNavHost = document.getElementById("panelNavHost");
const railSites = document.getElementById("railSites");
const railAddSite = document.getElementById("railAddSite");

let currentPanelUrl = null;

// Back / forward / reload for the open pinned site. The sidebar can't
// touch a cross-origin iframe's history from outside (same-origin policy),
// so it postMessages the command to the frame, where our content script
// -- same-origin to the page -- runs it (see clipboard-watch.js). This
// gives real back/forward AND a reload that keeps the user's in-frame
// position (rather than jumping back to the pinned URL).
function navFrame(cmd) {
  try {
    webPanelFrame.contentWindow.postMessage({ __lmbNav: cmd }, "*");
  } catch {
    /* frame not ready */
  }
}
document.getElementById("panelBack").addEventListener("click", () => navFrame("back"));
document.getElementById("panelForward").addEventListener("click", () => navFrame("forward"));
document.getElementById("panelReload").addEventListener("click", () => navFrame("reload"));
const siteDialog = document.getElementById("siteDialog");
const siteForm = document.getElementById("siteForm");
const siteUrlInput = document.getElementById("siteUrl");
const siteCancel = document.getElementById("siteCancel");
const siteDialogTitle = document.getElementById("siteDialogTitle");
const siteMenu = document.getElementById("siteMenu");

let dialogEditingUrl = null; // null = adding; a string = editing that URL
let menuTargetUrl = null;

function normaliseUrl(raw) {
  const u = (raw || "").trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

async function getWebPanels() {
  const { webPanels = [] } = await chrome.storage.local.get("webPanels");
  return webPanels;
}
async function setWebPanels(list) {
  await chrome.storage.local.set({ webPanels: list });
  renderRailSites(list);
}

function openSiteDialog({ url = "", editing = null } = {}) {
  dialogEditingUrl = editing;
  siteDialogTitle.textContent = editing ? "Edit pinned site" : "Pin this page";
  siteUrlInput.value = url;
  siteDialog.showModal();
  siteUrlInput.focus();
  siteUrlInput.select();
}

siteCancel.addEventListener("click", () => siteDialog.close());

siteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = normaliseUrl(siteUrlInput.value);
  if (!url) return;
  const list = await getWebPanels();
  if (dialogEditingUrl) {
    await setWebPanels(list.map((u) => (u === dialogEditingUrl ? url : u)));
  } else if (!list.includes(url)) {
    await setWebPanels([...list, url]);
  }
  siteDialog.close();
  openPanelSite(url);
});

function openPanelSite(url) {
  // Deactivate the tab buttons and highlight the favicon of the site
  // being opened -- the favicons themselves are the "Panels" UI now.
  document.querySelectorAll(".rail-btn[data-panel]").forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-selected", "false");
  });
  document.querySelectorAll("#railSites .rail-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.url === url);
  });
  document.querySelectorAll(".panel-view").forEach((p) => {
    p.classList.toggle("active", p.id === "panel-panels");
  });
  currentPanelUrl = url;
  panelsEmpty.hidden = true;
  panelNav.hidden = false;
  try { panelNavHost.textContent = new URL(url).hostname; } catch { panelNavHost.textContent = ""; }
  loadInFrame(webPanelFrame, url);
}

function showSiteMenu(x, y, url) {
  menuTargetUrl = url;
  // Show first so we can measure it, then position. The rail is on the
  // right edge, so open the menu to the LEFT of the cursor (into the
  // panel) and clamp to the viewport so it's never off-screen.
  siteMenu.hidden = false;
  const pad = 8;
  const w = siteMenu.offsetWidth;
  const h = siteMenu.offsetHeight;
  let left = x - w;
  if (left < pad) left = pad;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  let top = y;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  if (top < pad) top = pad;
  siteMenu.style.left = `${left}px`;
  siteMenu.style.top = `${top}px`;
}
function hideSiteMenu() {
  siteMenu.hidden = true;
  menuTargetUrl = null;
}

siteMenu.addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  const url = menuTargetUrl;
  hideSiteMenu();
  if (!url || !act) return;
  if (act === "edit") {
    openSiteDialog({ url, editing: url });
  } else if (act === "delete") {
    const list = await getWebPanels();
    await setWebPanels(list.filter((u) => u !== url));
  }
});
document.addEventListener("click", hideSiteMenu);
window.addEventListener("blur", hideSiteMenu);

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
    btn.dataset.url = url;
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
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showSiteMenu(e.clientX, e.clientY, url);
    });
    railSites.appendChild(btn);
  }
}

async function loadWebPanels() {
  renderRailSites(await getWebPanels());
}

// Keep the rail live: if the background worker changes webPanels after
// this page loaded (e.g. the one-time leaked-pin cleanup at boot), the
// favicon list must reflect it without a manual reopen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.webPanels) {
    renderRailSites(changes.webPanels.newValue || []);
  }
});

// Minimise: collapse the whole panel. Chromium gives extensions no way
// to shrink the panel to rail-width, so minimise = close; the toolbar
// icon or Ctrl+Shift+L reopens it (and it auto-opens on every launch).
document.getElementById("railMinimize").addEventListener("click", () => {
  window.close();
});

railAddSite.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const prefill = tab?.url && /^https?:\/\//.test(tab.url) ? tab.url : "";
  openSiteDialog({ url: prefill });
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
const addSnippetAbbrev = document.getElementById("addSnippetAbbrev");
const addSnippetText = document.getElementById("addSnippetText");

async function loadSnippets() {
  const { snippets = [] } = await chrome.storage.local.get("snippets");
  snippetList.innerHTML = "";
  for (const snippet of snippets) {
    const item = document.createElement("div");
    item.className = "panel-item";

    const label = document.createElement("span");
    label.textContent =
      (snippet.abbrev ? `${snippet.abbrev} → ` : "") +
      (snippet.label || snippet.text.slice(0, 40));
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
  const next = [
    ...snippets,
    {
      id: crypto.randomUUID(),
      label: addSnippetLabel.value.trim(),
      abbrev: addSnippetAbbrev.value.trim(),
      text,
    },
  ];
  await chrome.storage.local.set({ snippets: next });
  addSnippetLabel.value = "";
  addSnippetAbbrev.value = "";
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
