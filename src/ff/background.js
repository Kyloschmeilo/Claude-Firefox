/*
 * Claude-Firefox: Hintergrund-Anpassungen. Läuft vor dem Original-Hintergrundskript.
 *
 *  - Service-Worker-Erkennung (der Original-Code prüft "ServiceWorkerGlobalScope")
 *  - Toolbar-Klick / Tastenkürzel -> Firefox-Sidebar
 *  - Offscreen-Dokument -> verstecktes iframe
 *  - externally_connectable -> Brücke über ein Content-Script auf claude.ai
 *  - OAuth-Weiterleitung auf chrome-extension://… abfangen (Anmeldung)
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  if (!ff || !ff.isBackground || ff.backgroundLoaded) return;
  ff.backgroundLoaded = true;
  const api = ff.api;
  const config = ff.config;
  const sidebar = api.sidebarAction;

  // Der Original-Code unterscheidet "läuft im Service Worker" (= Hintergrund)
  // von "läuft in einer Seite". In Firefox ist der Hintergrund eine Event-Page.
  if (!('ServiceWorkerGlobalScope' in globalThis)) {
    globalThis.ServiceWorkerGlobalScope = function ServiceWorkerGlobalScope() {};
  }

  const LANG_DE = /^de\b/i.test(navigator.language || '');
  const t = (de, en) => (LANG_DE ? de : en);

  // --- Hilfsfunktionen --------------------------------------------------------

  const matchPattern = ff.matchPattern;

  const isConnectableUrl = (url) => (config.externallyConnectable || []).some((p) => matchPattern(p, url || ''));
  const knownIds = new Set(config.chromeExtensionIds || []);
  const chromeExtUrl = /^chrome-extension:\/\/([a-p]{32})(\/[^#]*)?/;

  function panelTabId(url) {
    try {
      return Number(new URL(url).searchParams.get('tabId')) || null;
    } catch {
      return null;
    }
  }

  // --- Event-Listener abfangen ----------------------------------------------
  // Wir brauchen die Listener des Original-Codes, um sie selbst aufrufen zu
  // können (Toolbar-Klick aus der Sidebar heraus, Nachrichten von claude.ai).

  function captureEvent(namespace, eventName) {
    const ns = api[namespace];
    const real = ns && ns[eventName];
    const captured = ff.makeEvent(`${namespace}.${eventName}`);
    const proxy = {
      addListener: (fn) => captured.addListener(fn),
      removeListener: (fn) => captured.removeListener(fn),
      hasListener: (fn) => captured.hasListener(fn),
      hasListeners: () => captured.hasListeners(),
    };
    try {
      Object.defineProperty(ns, eventName, { configurable: true, enumerable: true, value: proxy });
    } catch {
      try {
        ns[eventName] = proxy;
      } catch (err) {
        ff.warn(`Konnte ${namespace}.${eventName} nicht abfangen`, err);
      }
    }
    return { captured, real };
  }

  // --- Toolbar-Klick -> Sidebar ---------------------------------------------

  const { captured: actionClicked, real: realActionClicked } = captureEvent('action', 'onClicked');
  if (realActionClicked) {
    // Der echte Listener wird sofort registriert, damit Firefox den Klick als
    // Nutzeraktion behandelt – nur dann darf sidebarAction.open() laufen.
    realActionClicked.addListener((tab, info) => ff.onActionClicked(tab, info));
  }

  function invokeActionListeners(tab, info) {
    const listeners = actionClicked.listeners;
    if (!listeners.length) return false;
    for (const fn of listeners) {
      try {
        const r = fn(tab, info);
        if (r && typeof r.catch === 'function') r.catch((err) => ff.warn('action.onClicked:', err));
      } catch (err) {
        ff.warn('action.onClicked:', err);
      }
    }
    return true;
  }

  async function openForTab(tab) {
    if (!tab) return { ok: false, reason: 'no-tab' };
    if (invokeActionListeners(tab, { modifiers: [], button: 0 })) return { ok: true, via: 'action' };
    // Fallback: Panel direkt setzen (falls der Original-Code openPanelOnActionClick nutzt).
    if (config.sidePanelPath) {
      const sep = config.sidePanelPath.includes('?') ? '&' : '?';
      await sidebar.setPanel({
        windowId: tab.windowId,
        panel: api.runtime.getURL(`${config.sidePanelPath.replace(/^\//, '')}${sep}tabId=${tab.id}`),
      });
      return { ok: true, via: 'panel' };
    }
    return { ok: false, reason: 'no-handler' };
  }

  ff.server.handle('sidebar.openForTab', async (_ctx, windowId) => {
    const [tab] = await api.tabs.query({ active: true, windowId });
    return openForTab(tab);
  });

  // Die Startseite der Sidebar startet Claude nur automatisch, wenn die Sidebar
  // gerade geöffnet wurde – nicht, wenn sie erscheint, weil der Claude-Tab
  // geschlossen wurde (in Chrome würde das Panel dann einfach verschwinden).
  const panelResetAt = new Map();
  ff.server.handle('sidebar.shouldAutoStart', (_ctx, windowId) => {
    const at = panelResetAt.get(windowId);
    return !(at && Date.now() - at < 5000);
  });

  ff.server.handle('sidePanel.setBehavior', (_ctx, behavior) => {
    ff.panelBehavior = { ...(ff.panelBehavior || {}), ...behavior };
  });

  // Wenn sidebarAction.open() ohne Nutzeraktion aufgerufen wurde (z. B. über den
  // "Mit Claude erledigen"-Knopf auf claude.ai), weisen wir auf das Symbol hin.
  let lastOpenHint = 0;
  let lastSidebarToggle = 0;
  ff.server.handle('sidePanel.openFailed', async (_ctx, windowId) => {
    // Gerade per Tastenkürzel umgeschaltet? Dann kein Hinweis.
    if (Date.now() - lastSidebarToggle < 3000) return;
    try {
      if (await sidebar.isOpen(windowId != null ? { windowId } : {})) return;
    } catch {}
    if (Date.now() - lastOpenHint < 30000) return;
    lastOpenHint = Date.now();
    api.notifications
      .create('claude-firefox-open-hint', {
        type: 'basic',
        iconUrl: api.runtime.getURL(iconPath()),
        title: 'Claude',
        message: t(
          'Klicke auf das Claude-Symbol in der Symbolleiste (oder drücke das Tastenkürzel), um die Seitenleiste zu öffnen.',
          'Click the Claude toolbar button (or press the shortcut) to open the sidebar.',
        ),
      })
      .catch(() => {});
  });

  function iconPath() {
    const icons = api.runtime.getManifest().icons || {};
    const sizes = Object.keys(icons).sort((a, b) => Number(b) - Number(a));
    return sizes.length ? icons[sizes[0]].replace(/^\//, '') : 'ff/icon.svg';
  }

  // Panel zurücksetzen, wenn der zugehörige Tab geschlossen wird.
  api.tabs.onRemoved.addListener(async (tabId, info) => {
    try {
      const url = await sidebar.getPanel({ windowId: info.windowId });
      if (panelTabId(url) === tabId) {
        panelResetAt.set(info.windowId, Date.now());
        await sidebar.setPanel({ windowId: info.windowId, panel: null });
      }
    } catch {}
  });

  // Sidebar-Status für chrome.sidePanel.onOpened/onClosed.
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== '__claude_firefox_sidebar') return;
    let info = null;
    port.onMessage.addListener((msg) => {
      info = msg;
      const evt = { windowId: msg.windowId, path: msg.path, tabId: msg.tabId ?? undefined };
      ff.sidePanelEvents && ff.sidePanelEvents.onOpened.dispatch(evt);
      ff.server.broadcast('sidePanel.opened', evt);
    });
    port.onDisconnect.addListener(() => {
      if (!info) return;
      const evt = { windowId: info.windowId, path: info.path, tabId: info.tabId ?? undefined };
      ff.sidePanelEvents && ff.sidePanelEvents.onClosed.dispatch(evt);
      ff.server.broadcast('sidePanel.closed', evt);
    });
  });

  // --- Offscreen-Dokument -----------------------------------------------------

  let offscreenFrame = null;
  let offscreenUrl = null;
  ff.server.handle('offscreen.create', async (_ctx, params = {}) => {
    if (offscreenFrame) throw new Error('Only a single offscreen document may be created.');
    const url = api.runtime.getURL(String(params.url || '').replace(/^\//, ''));
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    frame.src = url;
    (document.body || document.documentElement).appendChild(frame);
    offscreenFrame = frame;
    offscreenUrl = url;
    await loaded;
  });
  ff.server.handle('offscreen.has', () => !!offscreenFrame);
  ff.server.handle('offscreen.url', () => offscreenUrl);
  ff.server.handle('offscreen.close', () => {
    if (!offscreenFrame) throw new Error('No current offscreen document.');
    offscreenFrame.remove();
    offscreenFrame = null;
    offscreenUrl = null;
  });

  // --- Nachrichten von claude.ai (Ersatz für externally_connectable) --------

  const { captured: externalMessage } = captureEvent('runtime', 'onMessageExternal');

  function dispatchExternal(message, sender) {
    return new Promise((resolve) => {
      let done = false;
      let waiting = 0;
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      const sendResponse = (response) => finish({ response });
      for (const fn of externalMessage.listeners) {
        let ret;
        try {
          ret = fn(message, sender, sendResponse);
        } catch (err) {
          ff.warn('onMessageExternal:', err);
          continue;
        }
        if (ret === true) waiting++;
        else if (ret && typeof ret.then === 'function') {
          waiting++;
          ret.then(
            (response) => finish({ response }),
            (err) => finish({ error: String((err && err.message) || err) }),
          );
        }
      }
      if (!done && !waiting) finish({ noResponse: true });
      else if (!done) setTimeout(() => finish({ noResponse: true }), 5 * 60 * 1000);
    });
  }

  function externalSender(sender) {
    let origin;
    try {
      origin = new URL(sender.url).origin;
    } catch {}
    return {
      url: sender.url,
      origin,
      tab: sender.tab,
      frameId: sender.frameId,
      documentLifecycle: 'active',
    };
  }

  api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.__ffExternal) {
      if (sender.id !== api.runtime.id || !sender.tab || !isConnectableUrl(sender.url)) {
        return Promise.resolve({ error: 'Untrusted sender' });
      }
      const { extensionId, message } = msg.__ffExternal;
      if (!knownIds.has(extensionId)) {
        return Promise.resolve({ error: 'Could not establish connection. Receiving end does not exist.' });
      }
      return dispatchExternal(message, externalSender(sender));
    }
    if (msg.__ffExternalRedirect) {
      if (sender.id !== api.runtime.id || !sender.tab || !isConnectableUrl(sender.url)) return undefined;
      handleRedirect(String(msg.__ffExternalRedirect), sender.tab, new URL(sender.url).origin);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  // --- Anmeldung: Weiterleitung auf chrome-extension://… abfangen ------------
  // Nach dem Login auf claude.ai wird auf chrome-extension://<id>/… umgeleitet.
  // Firefox kennt diese Adressen nicht. Wir fangen sie ab und geben sie an die
  // Extension weiter, genau wie Chrome es tun würde.

  const handledRedirects = new Map();

  async function handleRedirect(url, tab, origin) {
    const m = url.match(chromeExtUrl);
    if (!m || !knownIds.has(m[1])) return;
    const now = Date.now();
    for (const [u, ts] of handledRedirects) if (now - ts > 10 * 60 * 1000) handledRedirects.delete(u);
    if (handledRedirects.has(url)) return;
    handledRedirects.set(url, now);

    // Nur Weiterleitungen zu einer Anmeldung, die die Extension selbst gestartet
    // hat: Der state-Parameter muss zum gespeicherten oauthState passen. So kann
    // keine fremde Seite einen eigenen Login-Code unterschieben.
    let state = null;
    try {
      state = new URL(url).searchParams.get('state');
    } catch {}
    const { oauthState } = await api.storage.local.get('oauthState');
    if (!state || state !== oauthState) {
      ff.lastRedirect = { url, at: now, via: 'ignored', reason: 'state' };
      ff.warn('OAuth-Weiterleitung ignoriert: state passt nicht zur gestarteten Anmeldung.');
      return;
    }
    // So behandeln, als hätte claude.ai die Weiterleitung per Nachricht geschickt.
    const sender = { url: tab && tab.url, origin, tab, frameId: 0, documentLifecycle: 'active' };
    const result = await dispatchExternal({ type: 'oauth_redirect', redirect_uri: url }, sender);
    ff.lastRedirect = { url, at: now, via: 'message', result };
    ff.log('OAuth-Weiterleitung verarbeitet', result);
  }
  // Zur Fehlersuche beim Login (und für die Tests).
  ff.server.handle('shim.lastRedirect', () => ff.lastRedirect || null);
  ff.handleRedirect = handleRedirect;

  if (api.webRequest && (config.externallyConnectable || []).length) {
    try {
      api.webRequest.onBeforeRedirect.addListener(
        (d) => {
          if (!d.redirectUrl || !chromeExtUrl.test(d.redirectUrl) || d.tabId < 0) return;
          const origin = new URL(d.url).origin;
          api.tabs
            .get(d.tabId)
            .then((tab) => handleRedirect(d.redirectUrl, tab, origin))
            .catch(() => handleRedirect(d.redirectUrl, { id: d.tabId }, origin));
        },
        { urls: config.externallyConnectable, types: ['main_frame'] },
      );
    } catch (err) {
      ff.warn('webRequest.onBeforeRedirect nicht verfügbar:', err);
    }
  }

  api.webNavigation.onBeforeNavigate.addListener(async (d) => {
    if (d.frameId !== 0 || !chromeExtUrl.test(d.url)) return;
    const tab = await api.tabs.get(d.tabId).catch(() => null);
    // Nur Weiterleitungen von Seiten akzeptieren, die das auch in Chrome dürften.
    if (!tab || !isConnectableUrl(tab.url)) return;
    handleRedirect(d.url, tab, new URL(tab.url).origin);
  });

  // --- Tastenkürzel für die Sidebar -----------------------------------------
  const sidePanelCommands = new Set((config.sidePanelCommands || []).filter((c) => !c.startsWith('_execute')));
  if (sidePanelCommands.size && api.commands) {
    api.commands.onCommand.addListener((command) => {
      if (!sidePanelCommands.has(command)) return;
      lastSidebarToggle = Date.now();
      sidebar.toggle().catch((err) => ff.log('sidebar.toggle:', err.message));
    });
  }

  // Echter Toolbar-Listener: zuerst Sidebar öffnen (synchron, Nutzeraktion!),
  // dann die Listener des Original-Codes aufrufen.
  ff.onActionClicked = (tab, info) => {
    sidebar.open().catch((err) => ff.log('sidebar.open:', err.message));
    if (!invokeActionListeners(tab, info)) openForTab(tab).catch(() => {});
  };
})();
