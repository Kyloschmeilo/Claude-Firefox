/*
 * Claude-Firefox: gemeinsame Basis für alle Shims.
 * Läuft im Hintergrund und in allen Erweiterungsseiten, immer VOR dem Original-Code.
 *
 * Hinweis: In Firefox (MV3) sind `chrome` und `browser` dasselbe Objekt. APIs
 * liefern Promises und akzeptieren zusätzlich Callbacks.
 */
(function () {
  'use strict';
  if (globalThis.__ff) return;

  const config = globalThis.__ffConfig || {};
  const api = globalThis.browser || globalThis.chrome;
  const isBackground = location.pathname === '/_generated_background_page.html';

  const ff = (globalThis.__ff = {
    config,
    api,
    isBackground,
    log: (...args) => console.debug('[Claude-Firefox]', ...args),
    warn: (...args) => console.warn('[Claude-Firefox]', ...args),
  });

  // --- chrome.runtime.lastError setzen können --------------------------------
  // Der Original-Code prüft in Callbacks `chrome.runtime.lastError`. Für unsere
  // eigenen APIs (sidePanel, debugger, offscreen) bilden wir das nach. Firefox
  // definiert die Eigenschaft selbst immer wieder neu, deshalb setzen wir sie
  // nur für die Dauer des Callbacks und stellen danach den alten Zustand her.
  ff.toError = (err) => (err instanceof Error ? err : new Error(err && err.message ? err.message : String(err)));

  /** Führt `fn` aus, während chrome.runtime.lastError = err gilt. */
  ff.withLastError = (err, fn) => {
    if (!err) return fn();
    const runtime = api.runtime;
    const value = { message: String(err.message ?? err) };
    let previous;
    let patched = false;
    try {
      previous = Object.getOwnPropertyDescriptor(runtime, 'lastError');
      Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => value });
      patched = true;
    } catch (e) {
      ff.warn('chrome.runtime.lastError lässt sich nicht setzen:', e);
    }
    try {
      return fn();
    } finally {
      if (patched) {
        try {
          if (previous) Object.defineProperty(runtime, 'lastError', previous);
          else delete runtime.lastError;
        } catch {}
      }
    }
  };

  /**
   * Macht aus einer Promise-Funktion eine Chrome-artige API-Funktion:
   * optionaler Callback als letztes Argument, sonst wird ein Promise geliefert.
   */
  ff.chromeApi = (impl) =>
    function (...args) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let promise;
      try {
        promise = Promise.resolve(impl.apply(this, args));
      } catch (err) {
        promise = Promise.reject(err);
      }
      if (!cb) return promise;
      promise.then(
        (result) => ff.withLastError(null, () => cb(result)),
        (err) => ff.withLastError(ff.toError(err), () => cb()),
      );
      return undefined;
    };

  /** Prüft eine URL gegen ein Match-Pattern wie "https://*.claude.ai/*". */
  ff.matchPattern = (pattern, url) => {
    if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):/.test(url);
    const m = pattern.match(/^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/);
    if (!m) return false;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const [, scheme, host, path] = m;
    const proto = u.protocol.slice(0, -1);
    if (scheme === '*' ? !['http', 'https'].includes(proto) : scheme !== proto) return false;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
      } else if (u.hostname !== host.replace(/:\d+$/, '')) return false;
    }
    const re = new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(u.pathname + u.search);
  };

  /** Nachbau von chrome.events.Event. */
  ff.makeEvent = (name = 'event') => {
    const listeners = [];
    return {
      addListener(fn) {
        if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn);
      },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      hasListener: (fn) => listeners.includes(fn),
      hasListeners: () => listeners.length > 0,
      dispatch(...args) {
        for (const fn of [...listeners]) {
          try {
            fn(...args);
          } catch (err) {
            console.error(`[Claude-Firefox] Fehler in ${name}-Listener:`, err);
          }
        }
      },
      get listeners() {
        return [...listeners];
      },
    };
  };

  // --- Verbindung Erweiterungsseite -> Hintergrund -------------------------
  // Manche Chrome-APIs (debugger, offscreen) gibt es nur einmal pro Extension.
  // Wir implementieren sie im Hintergrund; Seiten sprechen über einen Port damit.
  const PORT_NAME = '__claude_firefox_shim';
  ff.PORT_NAME = PORT_NAME;

  if (!isBackground) {
    let port = null;
    let seq = 0;
    const pending = new Map();
    const handlers = new Map();

    const connect = () => {
      port = api.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener((msg) => {
        if (msg && msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error));
          else p.resolve(msg.result);
        } else if (msg && msg.event) {
          for (const fn of handlers.get(msg.event) || []) {
            try {
              fn(...(msg.args || []));
            } catch (err) {
              console.error('[Claude-Firefox]', err);
            }
          }
        }
      });
      port.onDisconnect.addListener((p) => {
        port = null;
        const reason = p && p.error ? ` (${p.error.message})` : '';
        for (const p of pending.values()) p.reject(new Error(`Verbindung zum Hintergrundskript unterbrochen${reason}.`));
        pending.clear();
        // Wieder verbinden, wenn jemand auf Ereignisse wartet.
        if (handlers.size) setTimeout(() => !port && connect(), 500);
      });
    };

    ff.bg = {
      call(method, ...params) {
        if (!port) connect();
        const id = ++seq;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          port.postMessage({ id, method, params });
        });
      },
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        if (!port) connect();
      },
    };
  } else {
    // Im Hintergrund: Methoden registrieren und an alle Seiten Ereignisse senden.
    const methods = new Map();
    const ports = new Set();
    ff.server = {
      handle(name, fn) {
        methods.set(name, fn);
      },
      broadcast(event, ...args) {
        for (const p of ports) {
          try {
            p.postMessage({ event, args });
          } catch {}
        }
      },
      ports,
    };
    const startedAt = Date.now();
    methods.set('shim.info', () => ({ startedAt, ports: ports.size }));
    ff.bg = {
      call(method, ...params) {
        const fn = methods.get(method);
        if (!fn) return Promise.reject(new Error(`Unbekannte Shim-Methode ${method}`));
        return Promise.resolve().then(() => fn({ isBackground: true }, ...params));
      },
      on() {},
    };
    api.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
      port.onMessage.addListener(async (msg) => {
        if (!msg || !msg.id) return;
        const fn = methods.get(msg.method);
        try {
          if (!fn) throw new Error(`Unbekannte Shim-Methode ${msg.method}`);
          const result = await fn({ port, sender: port.sender }, ...(msg.params || []));
          port.postMessage({ id: msg.id, result });
        } catch (err) {
          try {
            port.postMessage({ id: msg.id, error: { message: String(err && err.message ? err.message : err) } });
          } catch {}
        }
      });
    });
  }
})();
