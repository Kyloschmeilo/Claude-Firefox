/*
 * Claude-Firefox: Ersatz für Chrome-APIs, die Firefox nicht oder anders kennt.
 * Läuft im Hintergrund und in allen Erweiterungsseiten (nach core.js).
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  if (!ff || ff.compatLoaded) return;
  ff.compatLoaded = true;
  const api = ff.api;

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // --- Nicht unterstützte Optionen automatisch entfernen --------------------
  // Firefox wirft bei unbekannten Optionen sofort einen Fehler (z. B. "buttons"
  // bei Benachrichtigungen). Chrome ignoriert sie. Wir entfernen die genannten
  // Optionen und versuchen es erneut.
  function unsupportedProps(message) {
    const props = new Set();
    for (const m of message.matchAll(/Property "([^"]+)" is unsupported by Firefox/g)) props.add(m[1]);
    const m = message.match(/Unexpected propert(?:y|ies)\s*:?\s*(.+?)\)\s*for\b/);
    if (m) {
      for (const p of m[1].split(',')) {
        const name = p.trim().replace(/^"|"$/g, '');
        if (name) props.add(name);
      }
    }
    return [...props];
  }
  ff.unsupportedProps = unsupportedProps;

  function omit(obj, props) {
    const out = { ...obj };
    for (const p of props) delete out[p];
    return out;
  }

  function wrapApi(namespace, name, { transform } = {}) {
    const ns = api[namespace];
    if (!ns || typeof ns[name] !== 'function' || ns[name].__ffWrapped) return;
    const original = ns[name];
    const attempt = (args, tries) => {
      let result;
      try {
        result = original.apply(ns, args);
      } catch (err) {
        result = Promise.reject(err);
      }
      return Promise.resolve(result).catch((err) => {
        const props = unsupportedProps(String((err && err.message) || err));
        const stripped = args.map((a) => (isPlainObject(a) ? omit(a, props) : a));
        const changed = stripped.some((a, i) => isPlainObject(a) && Object.keys(a).length !== Object.keys(args[i]).length);
        if (!props.length || !changed || tries <= 0) throw err;
        ff.log(`${namespace}.${name}: entferne nicht unterstützte Optionen`, props);
        return attempt(stripped, tries - 1);
      });
    };
    const wrapped = function (...args) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const finalArgs = transform ? transform(args) : args;
      const promise = attempt(finalArgs, 3);
      if (!cb) return promise;
      promise.then(
        (r) => ff.withLastError(null, () => cb(r)),
        (e) => ff.withLastError(ff.toError(e), () => cb()),
      );
      return undefined;
    };
    wrapped.__ffWrapped = true;
    try {
      ns[name] = wrapped;
    } catch (err) {
      ff.warn(`Konnte ${namespace}.${name} nicht ersetzen`, err);
    }
  }

  // --- chrome://-Adressen und chrome-extension://-Links umschreiben ----------
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    const ext = url.match(/^chrome-extension:\/\/[^/]+\/?(.*)$/i);
    if (ext) return api.runtime.getURL(ext[1]);
    if (/^(chrome|edge|brave|opera|vivaldi):\/\/newtab\/?$/i.test(url) || /^about:(newtab|home)$/i.test(url)) return undefined;
    if (/^(chrome|edge|brave|opera|vivaldi):\/\//i.test(url) || /^about:(?!blank\b)/i.test(url)) {
      return api.runtime.getURL(`ff/info.html?url=${encodeURIComponent(url)}`);
    }
    return url;
  }
  ff.rewriteUrl = rewriteUrl;

  // Schreibt die url-Eigenschaft im ersten Options-Objekt der Argumente um.
  const withUrl = (args) => {
    const a = [...args];
    const index = a.findIndex(isPlainObject);
    const props = a[index];
    if (props && 'url' in props) {
      const url = Array.isArray(props.url) ? props.url.map(rewriteUrl).filter(Boolean) : rewriteUrl(props.url);
      a[index] = { ...props, url };
      if (a[index].url === undefined) delete a[index].url;
    }
    return a;
  };

  wrapApi('tabs', 'create', { transform: withUrl });
  wrapApi('tabs', 'update', { transform: withUrl });
  wrapApi('windows', 'create', { transform: withUrl });
  for (const [ns, fn] of [
    ['notifications', 'create'],
    ['notifications', 'update'],
    ['identity', 'launchWebAuthFlow'],
    ['tabs', 'query'],
    ['tabs', 'group'],
    ['windows', 'update'],
    ['downloads', 'download'],
    ['tabGroups', 'update'],
    ['tabGroups', 'query'],
    ['scripting', 'executeScript'],
    ['scripting', 'insertCSS'],
    ['alarms', 'create'],
    ['declarativeNetRequest', 'updateSessionRules'],
    ['declarativeNetRequest', 'updateDynamicRules'],
  ]) {
    wrapApi(ns, fn);
  }

  // --- declarativeNetRequest: Konstanten, die Firefox nicht mitliefert ---------
  const dnr = api.declarativeNetRequest;
  if (dnr) {
    const enums = {
      RuleActionType: ['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests'],
      HeaderOperation: ['append', 'set', 'remove'],
      ResourceType: [
        'main_frame',
        'sub_frame',
        'stylesheet',
        'script',
        'image',
        'font',
        'object',
        'xmlhttprequest',
        'ping',
        'csp_report',
        'media',
        'websocket',
        'webtransport',
        'webbundle',
        'other',
      ],
      DomainType: ['firstParty', 'thirdParty'],
      RequestMethod: ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'],
      UnsupportedRegexReason: ['syntaxError', 'memoryLimitExceeded'],
    };
    const constName = (v) => v.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    for (const [name, values] of Object.entries(enums)) {
      if (dnr[name]) continue;
      try {
        dnr[name] = Object.freeze(Object.fromEntries(values.map((v) => [constName(v), v])));
      } catch {}
    }
  }

  // --- action.getUserSettings (ältere Firefox-Versionen) ---------------------
  if (api.action && typeof api.action.getUserSettings !== 'function') {
    api.action.getUserSettings = ff.chromeApi(async () => ({ isOnToolbar: true }));
  }

  // --- identity (falls die Berechtigung fehlt) -------------------------------
  if (!api.identity) {
    api.identity = {
      getRedirectURL: (path = '') => `https://${api.runtime.id}.extensions.allizom.org/${path}`,
      launchWebAuthFlow: ff.chromeApi(async () => {
        throw new Error('identity.launchWebAuthFlow ist in diesem Firefox-Port nicht verfügbar.');
      }),
    };
  }

  // --- chrome.sidePanel -> Firefox-Sidebar ----------------------------------
  // Firefox hat eine Sidebar pro Fenster. Wir zeigen darin das Claude-Panel des
  // Tabs, für den es zuletzt geöffnet wurde. So bleibt eine laufende Aufgabe
  // erhalten, wenn man den Tab wechselt.
  const sidebar = api.sidebarAction;
  if (!api.sidePanel && sidebar) {
    const toPanelUrl = (path) => api.runtime.getURL(String(path).replace(/^\//, ''));
    const windowOf = async (tabId) => (await api.tabs.get(tabId)).windowId;
    const panelTabId = (url) => {
      try {
        return Number(new URL(url).searchParams.get('tabId')) || null;
      } catch {
        return null;
      }
    };
    let behavior = { openPanelOnActionClick: false };

    const onOpened = ff.makeEvent('sidePanel.onOpened');
    const onClosed = ff.makeEvent('sidePanel.onClosed');
    let subscribed = false;
    const subscribe = (evt) => {
      const orig = evt.addListener;
      evt.addListener = (fn) => {
        orig.call(evt, fn);
        if (!subscribed) {
          subscribed = true;
          if (ff.isBackground) {
            ff.sidePanelEvents = { onOpened, onClosed };
          } else {
            ff.bg.on('sidePanel.opened', (info) => onOpened.dispatch(info));
            ff.bg.on('sidePanel.closed', (info) => onClosed.dispatch(info));
          }
        }
      };
    };
    subscribe(onOpened);
    subscribe(onClosed);
    if (ff.isBackground) ff.sidePanelEvents = { onOpened, onClosed };

    api.sidePanel = {
      setOptions: ff.chromeApi(async (options = {}) => {
        const { tabId, path, enabled } = options;
        // Globale Einstellungen (ohne Tab) übernehmen wir nicht: Standard bleibt
        // die Startseite ff/sidebar.html, die Claude für den aktiven Tab startet.
        if (tabId == null) return;
        const windowId = await windowOf(tabId);
        if (path != null && enabled !== false) {
          const panel = toPanelUrl(path);
          const current = await sidebar.getPanel({ windowId });
          if (current !== panel) await sidebar.setPanel({ windowId, panel });
        } else if (enabled === false) {
          const current = await sidebar.getPanel({ windowId });
          if (panelTabId(current) === tabId) await sidebar.setPanel({ windowId, panel: null });
        }
      }),
      getOptions: ff.chromeApi(async (options = {}) => {
        const windowId = options.tabId != null ? await windowOf(options.tabId) : undefined;
        const url = await sidebar.getPanel(windowId != null ? { windowId } : {});
        const base = api.runtime.getURL('');
        return { enabled: true, path: url && url.startsWith(base) ? url.slice(base.length) : url };
      }),
      // Muss synchron im Klick-Handler aufgerufen werden (Firefox verlangt eine Nutzeraktion).
      open: ff.chromeApi((options = {}) => {
        const opening = sidebar.open();
        return opening.catch((err) => {
          // Passiert, wenn das Öffnen aus einer Nachricht statt aus einem Klick kommt.
          ff.log('sidebarAction.open:', err.message, options);
          if (/user input/i.test(err.message)) ff.bg.call('sidePanel.openFailed', options.windowId).catch(() => {});
        });
      }),
      close: ff.chromeApi(() => sidebar.close().catch((err) => ff.log('sidebarAction.close:', err.message))),
      setPanelBehavior: ff.chromeApi(async (b = {}) => {
        behavior = { ...behavior, ...b };
        if (ff.isBackground) ff.panelBehavior = behavior;
        else await ff.bg.call('sidePanel.setBehavior', behavior).catch(() => {});
      }),
      getPanelBehavior: ff.chromeApi(async () => behavior),
      onOpened,
      onClosed,
    };
    if (ff.isBackground) ff.panelBehavior = behavior;
  }

  // --- chrome.offscreen -> verstecktes iframe im Hintergrund ----------------
  if (!api.offscreen) {
    api.offscreen = {
      Reason: Object.freeze(
        Object.fromEntries(
          [
            'TESTING',
            'AUDIO_PLAYBACK',
            'IFRAME_SCRIPTING',
            'DOM_SCRAPING',
            'BLOBS',
            'DOM_PARSER',
            'USER_MEDIA',
            'DISPLAY_MEDIA',
            'WEB_RTC',
            'CLIPBOARD',
            'LOCAL_STORAGE',
            'WORKERS',
            'BATTERY_STATUS',
            'MATCH_MEDIA',
            'GEOLOCATION',
          ].map((r) => [r, r]),
        ),
      ),
      createDocument: ff.chromeApi((params) => ff.bg.call('offscreen.create', params)),
      hasDocument: ff.chromeApi(() => ff.bg.call('offscreen.has')),
      closeDocument: ff.chromeApi(() => ff.bg.call('offscreen.close')),
    };
  }

  // --- Kleinigkeiten --------------------------------------------------------
  // navigator.userAgentData gibt es in Firefox nicht; der Code hat Fallbacks.
  // runtime.getContexts (Chrome 116+) wird nur für Offscreen-Prüfungen genutzt.
  if (api.runtime && typeof api.runtime.getContexts !== 'function') {
    api.runtime.getContexts = ff.chromeApi(async (filter = {}) => {
      const types = filter.contextTypes || [];
      const contexts = [];
      if ((!types.length || types.includes('OFFSCREEN_DOCUMENT')) && (await ff.bg.call('offscreen.has'))) {
        contexts.push({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: await ff.bg.call('offscreen.url') });
      }
      return contexts;
    });
  }
})();
