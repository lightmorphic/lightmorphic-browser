// Content script (runs in every frame, including the sidebar's pinned-site
// iframe). Two jobs:
//
// 1. Quick-paste clipboard history: report copied text so it can be
//    recalled from any tab. Listens to the `copy` DOM event rather than
//    polling, so nothing is read without the user's own copy action.
document.addEventListener("copy", () => {
  const text = window.getSelection()?.toString();
  if (text && text.trim()) {
    chrome.runtime.sendMessage({ type: "lightmorphic-clip-copied", text });
  }
});

// 2. Text expander: snippets with an abbreviation set (e.g. "ab#")
//    expand the moment they're typed in any text box on any page --
//    TextExpander-style, no trigger key needed. The abbreviation must
//    start at a word boundary so ordinary words containing it don't
//    fire; picking distinctive abbreviations ("ab#", ";sig") is what
//    makes this safe in practice, same as every expander tool.
let lmbExpansions = [];
function lmbLoadExpansions() {
  try {
    chrome.storage.local.get("snippets").then(({ snippets = [] }) => {
      lmbExpansions = snippets
        .filter((s) => s.abbrev && s.text)
        .map((s) => ({ abbrev: s.abbrev, text: s.text }))
        .sort((a, b) => b.abbrev.length - a.abbrev.length); // longest first
    });
  } catch {
    /* extension context gone (page outliving a reload) -- expander off */
  }
}
lmbLoadExpansions();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.snippets) lmbLoadExpansions();
  });
} catch {
  /* ditto */
}

function lmbBoundaryOk(before) {
  // Only expand when the abbreviation starts a word: beginning of the
  // field or after whitespace/newline.
  return before === "" || /\s$/.test(before);
}

document.addEventListener("input", (e) => {
  if (!lmbExpansions.length) return;
  // Only real keystrokes: the synthetic input event dispatched after an
  // expansion must not re-enter here (an expansion whose text contains
  // an abbreviation would otherwise loop forever).
  if (!e.isTrusted) return;
  const el = e.target;
  if (!el) return;

  // Plain inputs / textareas -- replace via value + caret.
  if ("value" in el && typeof el.value === "string" && typeof el.selectionStart === "number") {
    const caret = el.selectionStart;
    const upToCaret = el.value.slice(0, caret);
    for (const { abbrev, text } of lmbExpansions) {
      if (!upToCaret.endsWith(abbrev)) continue;
      const before = upToCaret.slice(0, -abbrev.length);
      if (!lmbBoundaryOk(before)) continue;
      el.value = before + text + el.value.slice(caret);
      const pos = before.length + text.length;
      el.selectionStart = el.selectionEnd = pos;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      break;
    }
    return;
  }

  // contenteditable (rich editors) -- work on the caret's text node.
  if (el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const caret = sel.anchorOffset;
    const upToCaret = node.textContent.slice(0, caret);
    for (const { abbrev, text } of lmbExpansions) {
      if (!upToCaret.endsWith(abbrev)) continue;
      const before = upToCaret.slice(0, -abbrev.length);
      if (!lmbBoundaryOk(before)) continue;
      const range = document.createRange();
      range.setStart(node, caret - abbrev.length);
      range.setEnd(node, caret);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      break;
    }
  }
}, true);

// 3. Panel navigation: the sidebar can't drive a cross-origin iframe's
//    back/forward/reload from outside (the same-origin policy blocks
//    access to another frame's history). But a content script runs INSIDE
//    the page, same-origin to it, so it can. The sidebar postMessages a
//    nav command to the frame; this handles it. Only messages from our
//    own extension origin are honoured.
window.addEventListener("message", (e) => {
  if (e.origin !== `chrome-extension://${chrome.runtime.id}`) return;
  const cmd = e.data && e.data.__lmbNav;
  if (cmd === "back") history.back();
  else if (cmd === "forward") history.forward();
  else if (cmd === "reload") location.reload();
});
