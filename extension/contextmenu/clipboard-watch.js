// Content script: reports text the user copies so it shows up in the
// quick-paste clipboard history from any tab, not just the one it was
// copied in. Listens to the `copy` DOM event rather than polling the
// clipboard API, so nothing is read without the user's own copy action.
document.addEventListener("copy", () => {
  const text = window.getSelection()?.toString();
  if (text && text.trim()) {
    chrome.runtime.sendMessage({ type: "lightmorphic-clip-copied", text });
  }
});
