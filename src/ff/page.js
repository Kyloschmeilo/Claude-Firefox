/*
 * Claude-Firefox: Anpassungen für Erweiterungsseiten (Seitenpanel, Optionen, …).
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  if (!ff || ff.isBackground || ff.pageLoaded) return;
  ff.pageLoaded = true;
  const api = ff.api;

  let inSidebar = false;
  try {
    inSidebar = api.extension.getViews({ type: 'sidebar' }).includes(window);
  } catch {}
  ff.inSidebar = inSidebar;
  if (!inSidebar) return;

  // window.close() schließt in Chrome das Seitenpanel; in Firefox die Sidebar.
  window.close = () => {
    api.sidebarAction.close().catch((err) => ff.log('sidebarAction.close:', err.message));
  };

  // Sidebar meldet sich beim Hintergrund an (für chrome.sidePanel.onOpened/onClosed).
  api.windows
    .getCurrent()
    .then((win) => {
      const port = api.runtime.connect({ name: '__claude_firefox_sidebar' });
      const base = api.runtime.getURL('');
      const tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
      port.postMessage({ windowId: win.id, path: location.href.slice(base.length), tabId });
    })
    .catch(() => {});
})();
