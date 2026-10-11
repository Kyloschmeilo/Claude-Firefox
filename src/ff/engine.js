/*
 * Claude-Firefox: Nachbau der Chrome-DevTools-Protokoll-Befehle (CDP), die die
 * Claude-Extension über chrome.debugger benutzt. Läuft nur im Hintergrund.
 *
 * Umgesetzt:
 *   Page.captureScreenshot      -> tabs.captureTab
 *   Runtime.evaluate            -> scripting.executeScript (world: MAIN)
 *   Input.dispatchMouseEvent    -> synthetische Maus-Events (cdp-agent.js)
 *   Input.dispatchKeyEvent      -> synthetische Tastatur-Events (cdp-agent.js)
 *   Input.insertText            -> document.execCommand('insertText')
 *   Runtime.enable              -> Console-/Fehler-Mitschnitt (cdp-agent.js)
 *   Network.enable              -> webRequest
 *   Page.enable                 -> webNavigation (Page.frameNavigated)
 *
 * Grenzen (Firefox lässt das nicht zu): echte "vertrauenswürdige" Eingaben,
 * CSS-:hover, das Umgehen der Content-Security-Policy einer Seite und
 * Datei-Uploads von lokalen Pfaden.
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  if (!ff || !ff.isBackground || ff.engine) return;
  const api = ff.api;

  const AGENT_FILE = 'ff/cdp-agent.js';
  const CONSOLE_BOOT_FILE = 'ff/cdp-console-boot.js';
  const CONSOLE_SCRIPT_ID = 'claude-firefox-console';
  const AGENT_TIMEOUT_MS = 15000;

  // Seiten, auf denen Firefox keine Erweiterungen zulässt.
  const RESTRICTED_HOSTS = new Set([
    'accounts-static.cdn.mozilla.net',
    'accounts.firefox.com',
    'addons.cdn.mozilla.net',
    'addons.mozilla.org',
    'api.accounts.firefox.com',
    'content.cdn.mozilla.net',
    'discovery.addons.mozilla.org',
    'install.mozilla.org',
    'oauth.accounts.firefox.com',
    'profile.accounts.firefox.com',
    'support.mozilla.org',
    'sync.services.mozilla.com',
  ]);

  /** @type {Map<number, {page:boolean, runtime:boolean, network:boolean, queue:Promise}>} */
  const attached = new Map();

  // Firefox beendet die Event-Page nach 30 s ohne API-Aufrufe – samt diesem
  // Zustand. Chrome hält Debugger-Sitzungen unabhängig davon. Solange Claude an
  // einen Tab angehängt ist, halten wir den Hintergrund deshalb wach.
  let keepAliveTimer = null;
  function updateKeepAlive() {
    if (attached.size && !keepAliveTimer) {
      keepAliveTimer = setInterval(() => api.runtime.getPlatformInfo().catch(() => {}), 20000);
    } else if (!attached.size && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function emit(tabId, method, params) {
    const target = { tabId };
    ff.debuggerEvents?.onEvent.dispatch(target, method, params);
    ff.server.broadcast('debugger.event', target, method, params);
  }

  function emitDetach(tabId, reason) {
    const target = { tabId };
    ff.debuggerEvents?.onDetach.dispatch(target, reason);
    ff.server.broadcast('debugger.detach', target, reason);
  }

  function cdpError(message, code = -32000) {
    return new Error(JSON.stringify({ code, message }));
  }

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function checkAttachable(url) {
    if (!url) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (url === 'about:blank') return;
    if (['about:', 'moz-extension:', 'chrome:', 'resource:', 'view-source:', 'jar:'].includes(u.protocol)) {
      throw new Error(
        `Cannot attach debugger to ${u.protocol}// pages. Navigate to a regular web page (http:// or https://) first, then retry.`,
      );
    }
    if (RESTRICTED_HOSTS.has(u.hostname)) {
      throw new Error(`Cannot access ${u.hostname}: Firefox does not allow extensions on this site.`);
    }
  }

  // --- Agent im Tab ----------------------------------------------------------

  async function runInFrame(tabId, frameId, op, params) {
    const call = () =>
      api.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        injectImmediately: true,
        func: (op, params) =>
          globalThis.__ffCdpAgent ? globalThis.__ffCdpAgent.handle(op, params) : { __noAgent: true },
        args: [op, params],
      });
    let [res] = await call();
    if (res && res.result && res.result.__noAgent) {
      await api.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        injectImmediately: true,
        files: [AGENT_FILE],
      });
      [res] = await call();
    }
    if (!res) throw new Error('Script could not be injected into the page.');
    if (res.error) throw ff.toError(res.error);
    return res.result;
  }

  async function agentCall(tabId, op, params) {
    const nativeTabs = [];
    const onCreated = (t) => {
      if (t.openerTabId === tabId) nativeTabs.push(t);
    };
    api.tabs.onCreated.addListener(onCreated);
    try {
      return await agentCallInner(tabId, op, params, nativeTabs);
    } finally {
      api.tabs.onCreated.removeListener(onCreated);
    }
  }

  async function agentCallInner(tabId, op, params, nativeTabs) {
    const chain = [];
    let frameId = 0;
    let current = params;
    let result;
    for (let depth = 0; ; depth++) {
      result = await withTimeout(
        runInFrame(tabId, frameId, op, current),
        AGENT_TIMEOUT_MS,
        `CDP command timed out on tab ${tabId} (the page may be blocked by a dialog).`,
      );
      if (!(result && result.forward) || depth >= 8) break;
      chain.push({ frameId, params: current });
      frameId = result.forward.frameId;
      current = result.forward.params;
    }
    // Scroll-Weitergabe an die umgebenden Dokumente.
    while (result && result.unscrolled && chain.length) {
      const parent = chain.pop();
      result = await runInFrame(tabId, parent.frameId, 'scrollChain', parent.params);
    }
    if (result && result.error) throw new Error(result.error);
    if (result && Array.isArray(result.openTabs)) {
      // Firefox blockiert Pop-ups aus synthetischen Klicks; wir öffnen sie selbst.
      const tab = await api.tabs.get(tabId).catch(() => null);
      for (const t of result.openTabs) {
        if (t.fallback) {
          await new Promise((r) => setTimeout(r, 150));
          if (nativeTabs.length) continue;
        }
        await api.tabs
          .create({
            url: t.url,
            active: t.active !== false,
            openerTabId: tabId,
            windowId: tab ? tab.windowId : undefined,
            index: tab ? tab.index + 1 : undefined,
          })
          .catch((err) => ff.warn('Neuer Tab konnte nicht geöffnet werden:', err));
      }
    }
    return result && result.value !== undefined ? result.value : {};
  }

  // --- Screenshots ----------------------------------------------------------

  async function devicePixelRatio(tabId) {
    try {
      const [res] = await api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        func: () => window.devicePixelRatio,
      });
      return Number(res && res.result) || 1;
    } catch {
      return 1;
    }
  }

  async function captureScreenshot(tabId, params) {
    const format = params.format === 'png' ? 'png' : 'jpeg';
    const options = { format };
    if (format === 'jpeg') options.quality = Math.max(1, Math.min(100, Math.round(params.quality ?? 80)));
    if (params.clip) {
      const { x = 0, y = 0, width, height, scale = 1 } = params.clip;
      options.rect = { x, y, width, height };
      // CDP: Ausgabegröße = Breite * scale * devicePixelRatio. Firefox: Breite * scale.
      // Firefox rechnet den Seiten-Zoom selbst noch einmal ein (devicePixelRatio enthält ihn schon).
      const zoom = await api.tabs.getZoom(tabId).catch(() => 1);
      options.scale = (scale * (await devicePixelRatio(tabId))) / (zoom || 1);
    }
    const dataUrl = await api.tabs.captureTab(tabId, options);
    return { data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }

  // --- JavaScript ausführen -------------------------------------------------

  // Läuft in der Seite (MAIN world). Muss für sich allein lauffähig sein.
  function evaluateInPage(expression, awaitPromise) {
    const describeNode = (n) => {
      if (n.nodeType !== 1) return n.nodeName;
      let d = n.nodeName.toLowerCase();
      if (n.id) d += `#${n.id}`;
      if (typeof n.className === 'string' && n.className.trim()) d += `.${n.className.trim().split(/\s+/).join('.')}`;
      return d;
    };
    const pack = (v) => {
      const t = typeof v;
      if (v === undefined) return { ok: true, type: 'undefined' };
      if (v === null) return { ok: true, type: 'object', subtype: 'null', value: null };
      if (t === 'string' || t === 'boolean') return { ok: true, type: t, value: v };
      if (t === 'number') {
        if (Number.isFinite(v) && !Object.is(v, -0)) return { ok: true, type: t, value: v };
        return { ok: true, type: t, unserializableValue: String(v), description: String(v) };
      }
      if (t === 'bigint') return { ok: true, type: t, unserializableValue: `${v}n`, description: `${v}n` };
      if (t === 'symbol') return { ok: true, type: t, description: String(v) };
      if (t === 'function') {
        let src = '';
        try {
          src = Function.prototype.toString.call(v);
        } catch {}
        return { ok: true, type: t, description: src.length > 500 ? src.slice(0, 500) + '…' : src };
      }
      if (typeof Node !== 'undefined' && v instanceof Node) {
        return { ok: true, type: 'object', subtype: 'node', description: describeNode(v), value: {} };
      }
      if (v instanceof Error) {
        return { ok: true, type: 'object', subtype: 'error', description: v.stack ? `${v}\n${v.stack}` : String(v) };
      }
      let value;
      try {
        // Nur echte Zyklen (Vorfahren) markieren, mehrfach genutzte Objekte bleiben erhalten.
        const ancestors = [];
        value = JSON.parse(
          JSON.stringify(v, function (k, val) {
            if (typeof val === 'object' && val !== null) {
              while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
              if (ancestors.includes(val)) return '[Circular]';
              ancestors.push(val);
              if (typeof Node !== 'undefined' && val instanceof Node) return `[${describeNode(val)}]`;
            }
            if (typeof val === 'bigint') return `${val}n`;
            if (typeof val === 'function') return '[Function]';
            return val;
          }),
        );
      } catch {
        value = String(v);
      }
      return { ok: true, type: 'object', className: v && v.constructor ? v.constructor.name : 'Object', value };
    };
    const packError = (e) => ({
      ok: false,
      name: e && e.name,
      message: e && e.message !== undefined ? String(e.message) : String(e),
      stack: e && e.stack ? String(e.stack) : '',
    });
    try {
      const result = (0, eval)(expression);
      if (awaitPromise && result && typeof result.then === 'function') {
        // async-Funktion statt window.Promise: zone.js & Co. ersetzen window.Promise.
        return (async () => {
          try {
            return pack(await result);
          } catch (e) {
            return packError(e);
          }
        })();
      }
      return pack(result);
    } catch (e) {
      return packError(e);
    }
  }

  async function evaluate(tabId, params) {
    const { expression = '', awaitPromise = false, timeout } = params;
    const limit = typeof timeout === 'number' && timeout > 0 ? timeout : 30000;
    let res;
    try {
      const [r] = await withTimeout(
        api.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'MAIN',
          injectImmediately: true,
          func: evaluateInPage,
          args: [String(expression), !!awaitPromise],
        }),
        limit + 1000,
        'execution was terminated',
      );
      res = r && r.error ? { ok: false, message: String(r.error.message || r.error), stack: '' } : r && r.result;
    } catch (err) {
      const message = String(err.message || err);
      if (message === 'execution was terminated') {
        return {
          result: { type: 'object', subtype: 'error', description: 'Error: execution was terminated' },
          exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: execution was terminated' } },
        };
      }
      throw err;
    }
    if (!res) return { result: { type: 'undefined' } };
    if (res.ok) {
      const { ok, ...remote } = res;
      return { result: remote };
    }
    let description = res.stack ? `${res.name || 'Error'}: ${res.message}\n${res.stack}` : `${res.name || 'Error'}: ${res.message}`;
    if (/blocked by CSP/i.test(res.message)) {
      description =
        "EvalError: This page's Content-Security-Policy blocks JavaScript execution, and Firefox does not let " +
        'extensions bypass it. Use the other browser tools (read_page, find, form_input, computer) on this page instead.';
    }
    return {
      result: { type: 'object', subtype: 'error', className: res.name || 'Error', description },
      exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception: { type: 'object', subtype: 'error', description } },
    };
  }

  // --- Console-Mitschnitt ---------------------------------------------------

  // Registrierungen nacheinander und ohne die Befehlswarteschlange des Tabs zu blockieren.
  let registrationQueue = Promise.resolve();
  function queueConsoleRegistration() {
    registrationQueue = registrationQueue.then(updateConsoleRegistration, updateConsoleRegistration);
    return registrationQueue;
  }

  async function updateConsoleRegistration() {
    const wanted = [...attached.values()].some((st) => st.runtime);
    let registered = [];
    try {
      registered = await api.scripting.getRegisteredContentScripts({ ids: [CONSOLE_SCRIPT_ID] });
    } catch {}
    if (wanted && !registered.length) {
      // Fängt Meldungen schon beim Laden einer Seite ab (document_start).
      await api.scripting
        .registerContentScripts([
          {
            id: CONSOLE_SCRIPT_ID,
            js: [CONSOLE_BOOT_FILE, AGENT_FILE],
            matches: ['<all_urls>'],
            runAt: 'document_start',
            allFrames: true,
            persistAcrossSessions: false,
          },
        ])
        .catch((err) => ff.warn('Console-Skript konnte nicht registriert werden:', err));
    } else if (!wanted && registered.length) {
      await api.scripting.unregisterContentScripts({ ids: [CONSOLE_SCRIPT_ID] }).catch(() => {});
    }
  }

  async function setConsoleTracking(tabId, on) {
    queueConsoleRegistration().catch(() => {});
    // Bereits geladene Dokumente sofort versorgen.
    let frames = [{ frameId: 0 }];
    try {
      frames = (await api.webNavigation.getAllFrames({ tabId })) || frames;
    } catch {}
    await Promise.all(
      frames.map((f) =>
        withTimeout(runInFrame(tabId, f.frameId, 'console', { enabled: on }), 1000, 'frame busy').catch(() => {}),
      ),
    );
  }

  function cdpConsoleType(level) {
    return { warn: 'warning', log: 'log', info: 'info', error: 'error', debug: 'debug', trace: 'trace', dir: 'dir', table: 'table', assert: 'assert' }[level] || 'log';
  }

  // --- Netzwerk-Mitschnitt --------------------------------------------------

  const RESOURCE_TYPES = {
    main_frame: 'Document',
    sub_frame: 'Document',
    stylesheet: 'Stylesheet',
    script: 'Script',
    image: 'Image',
    imageset: 'Image',
    font: 'Font',
    xmlhttprequest: 'XHR',
    websocket: 'WebSocket',
    media: 'Media',
    ping: 'Ping',
    csp_report: 'CSPViolationReport',
    beacon: 'Ping',
  };
  let networkListening = false;
  const net = {
    before(d) {
      if (!attached.get(d.tabId)?.network) return;
      emit(d.tabId, 'Network.requestWillBeSent', {
        requestId: String(d.requestId),
        loaderId: '',
        documentURL:
          d.type === 'main_frame'
            ? d.url
            : d.frameAncestors && d.frameAncestors.length
              ? d.frameAncestors[d.frameAncestors.length - 1].url
              : d.documentUrl || d.url,
        request: { url: d.url, method: d.method, headers: {} },
        timestamp: d.timeStamp / 1000,
        wallTime: d.timeStamp / 1000,
        type: RESOURCE_TYPES[d.type] || 'Other',
        frameId: String(d.frameId),
      });
    },
    completed(d) {
      if (!attached.get(d.tabId)?.network) return;
      emit(d.tabId, 'Network.responseReceived', {
        requestId: String(d.requestId),
        loaderId: '',
        timestamp: d.timeStamp / 1000,
        type: RESOURCE_TYPES[d.type] || 'Other',
        response: { url: d.url, status: d.statusCode, statusText: d.statusLine || '', headers: {}, mimeType: '', fromDiskCache: !!d.fromCache },
      });
      emit(d.tabId, 'Network.loadingFinished', { requestId: String(d.requestId), timestamp: d.timeStamp / 1000, encodedDataLength: 0 });
    },
    failed(d) {
      if (!attached.get(d.tabId)?.network) return;
      emit(d.tabId, 'Network.loadingFailed', {
        requestId: String(d.requestId),
        timestamp: d.timeStamp / 1000,
        type: RESOURCE_TYPES[d.type] || 'Other',
        errorText: d.error || 'net::ERR_FAILED',
        canceled: /abort/i.test(d.error || ''),
      });
    },
  };

  function updateNetworkListeners() {
    const wanted = [...attached.values()].some((st) => st.network);
    if (wanted === networkListening || !api.webRequest) return;
    const filter = { urls: ['<all_urls>'] };
    if (wanted) {
      api.webRequest.onBeforeRequest.addListener(net.before, filter);
      api.webRequest.onCompleted.addListener(net.completed, filter);
      api.webRequest.onErrorOccurred.addListener(net.failed, filter);
    } else {
      api.webRequest.onBeforeRequest.removeListener(net.before);
      api.webRequest.onCompleted.removeListener(net.completed);
      api.webRequest.onErrorOccurred.removeListener(net.failed);
    }
    networkListening = wanted;
  }

  // --- Navigation / Tab-Ereignisse -------------------------------------------

  let tabListeners = false;
  function ensureTabListeners() {
    if (tabListeners) return;
    tabListeners = true;
    api.tabs.onRemoved.addListener((tabId) => {
      if (!attached.has(tabId)) return;
      attached.delete(tabId);
      updateKeepAlive();
      emitDetach(tabId, 'target_closed');
      updateNetworkListeners();
      queueConsoleRegistration().catch(() => {});
    });
    api.webNavigation.onCommitted.addListener((d) => {
      const st = attached.get(d.tabId);
      if (!st || !st.page) return;
      const frame = { id: String(d.frameId), loaderId: '', url: d.url, securityOrigin: safeOrigin(d.url), mimeType: 'text/html' };
      if (d.frameId !== 0) frame.parentId = String(d.parentFrameId);
      emit(d.tabId, 'Page.frameNavigated', { frame, type: 'Navigation' });
    });
  }

  function safeOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  // Nachrichten des Agenten (Console-Meldungen, Rückfragen).
  api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.__ffCdp !== 'string' || !sender.tab) return undefined;
    const tabId = sender.tab.id;
    const st = attached.get(tabId);
    // Chromes Tab-Sitzung sieht keine Meldungen aus fremden (Cross-Site-)iframes.
    if (sender.frameId !== 0 && safeOrigin(sender.url) !== safeOrigin(sender.tab.url)) {
      return msg.__ffCdp === 'consoleQuery' ? Promise.resolve({ enabled: false }) : undefined;
    }
    if (msg.__ffCdp === 'consoleQuery') return Promise.resolve({ enabled: !!(st && st.runtime) });
    if (msg.__ffCdp === 'console' && st && st.runtime && Array.isArray(msg.entries)) {
      for (const e of msg.entries) {
        if (e.kind === 'exception') {
          emit(tabId, 'Runtime.exceptionThrown', {
            timestamp: e.timestamp,
            exceptionDetails: {
              exceptionId: 1,
              text: e.text || 'Uncaught',
              url: e.url,
              lineNumber: e.lineNumber,
              columnNumber: e.columnNumber,
              timestamp: e.timestamp,
              exception: { type: 'object', subtype: 'error', description: e.description },
              stackTrace: e.stackTrace,
            },
          });
        } else {
          emit(tabId, 'Runtime.consoleAPICalled', {
            type: cdpConsoleType(e.level),
            args: e.args,
            executionContextId: 1,
            timestamp: e.timestamp,
            stackTrace: e.stackTrace,
          });
        }
      }
    }
    return undefined;
  });

  // --- Öffentliche Schnittstelle --------------------------------------------

  async function attach(target) {
    const tabId = target && target.tabId;
    if (typeof tabId !== 'number') throw new Error('Firefox port: only tab targets ({tabId}) are supported.');
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`No tab with given id ${tabId}.`);
    checkAttachable(tab.url);
    ensureTabListeners();
    if (!attached.has(tabId)) attached.set(tabId, { page: false, runtime: false, network: false, queue: Promise.resolve() });
    updateKeepAlive();
  }

  async function detach(target) {
    const tabId = target && target.tabId;
    const st = attached.get(tabId);
    if (!st) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    attached.delete(tabId);
    updateKeepAlive();
    updateNetworkListeners();
    if (st.runtime) setConsoleTracking(tabId, false).catch(() => {});
  }

  async function getTargets() {
    const tabs = await api.tabs.query({});
    return tabs.map((t) => ({
      type: 'page',
      id: String(t.id),
      tabId: t.id,
      title: t.title || '',
      url: t.url || '',
      faviconUrl: t.favIconUrl,
      attached: attached.has(t.id),
    }));
  }

  async function dispatch(tabId, st, method, params) {
    switch (method) {
      case 'Page.enable':
        st.page = true;
        return {};
      case 'Page.disable':
        st.page = false;
        return {};
      case 'Runtime.enable':
        st.runtime = true;
        await setConsoleTracking(tabId, true);
        return {};
      case 'Runtime.disable':
        st.runtime = false;
        await setConsoleTracking(tabId, false);
        return {};
      case 'Network.enable':
        st.network = true;
        updateNetworkListeners();
        return {};
      case 'Network.disable':
        st.network = false;
        updateNetworkListeners();
        return {};
      case 'DOM.enable':
      case 'DOM.disable':
      case 'Log.enable':
      case 'Log.disable':
      case 'Page.handleJavaScriptDialog':
      case 'Emulation.setFocusEmulationEnabled':
        return {};
      case 'Page.captureScreenshot':
        return captureScreenshot(tabId, params);
      case 'Runtime.evaluate':
        return evaluate(tabId, params);
      case 'Input.dispatchMouseEvent':
        return agentCall(tabId, 'mouse', params);
      case 'Input.dispatchKeyEvent':
        return agentCall(tabId, 'key', params);
      case 'Input.insertText':
        return agentCall(tabId, 'insertText', params);
      case 'Page.navigate':
        await api.tabs.update(tabId, { url: params.url });
        return { frameId: '0', loaderId: '' };
      case 'Page.reload':
        await api.tabs.reload(tabId, { bypassCache: !!params.ignoreCache });
        return {};
      case 'Page.getLayoutMetrics': {
        const m = await agentCall(tabId, 'metrics', {});
        const viewport = { pageX: m.scrollX, pageY: m.scrollY, clientWidth: m.width, clientHeight: m.height };
        return {
          layoutViewport: viewport,
          cssLayoutViewport: viewport,
          visualViewport: { offsetX: 0, offsetY: 0, ...viewport, scale: 1, zoom: 1 },
          cssVisualViewport: { offsetX: 0, offsetY: 0, ...viewport, scale: 1, zoom: 1 },
          contentSize: { x: 0, y: 0, width: m.scrollWidth, height: m.scrollHeight },
          cssContentSize: { x: 0, y: 0, width: m.scrollWidth, height: m.scrollHeight },
        };
      }
      case 'DOM.setFileInputFiles':
        throw cdpError(
          'Uploading files from local paths is not supported in the Firefox port (extensions cannot read local files).',
        );
      default:
        // Neue Extension-Versionen können weitere CDP-Befehle nutzen – hier sichtbar machen.
        ff.warn(`CDP-Befehl ${method} wird im Firefox-Port (noch) nicht unterstützt.`, params);
        throw cdpError(`'${method}' wasn't found`, -32601);
    }
  }

  function sendCommand(target, method, params = {}) {
    const tabId = target && target.tabId;
    const st = attached.get(tabId);
    if (!st) return Promise.reject(new Error(`Debugger is not attached to the tab with id: ${tabId}.`));
    // Befehle pro Tab der Reihe nach abarbeiten (Tastatureingaben!).
    const run = () => dispatch(tabId, st, method, params || {});
    const result = st.queue.then(run, run);
    st.queue = result.catch(() => {});
    return result;
  }

  // Eine von einer früheren Instanz übrig gebliebene Console-Registrierung entfernen.
  queueConsoleRegistration().catch(() => {});

  ff.engine = { attach, detach, sendCommand, getTargets, attached };
  ff.server.handle('debugger.attach', (_ctx, target) => attach(target));
  ff.server.handle('debugger.detach', (_ctx, target) => detach(target));
  ff.server.handle('debugger.sendCommand', (_ctx, target, method, params) => sendCommand(target, method, params));
  ff.server.handle('debugger.getTargets', () => getTargets());
})();
