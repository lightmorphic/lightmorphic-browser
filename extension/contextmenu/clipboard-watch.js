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

// 2. Panel navigation: the sidebar can't drive a cross-origin iframe's
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
