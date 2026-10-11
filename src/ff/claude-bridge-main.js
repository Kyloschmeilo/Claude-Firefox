/*
 * Claude-Firefox: läuft auf claude.ai in der Seite selbst (MAIN world).
 *
 * In Chrome kann claude.ai der Extension direkt Nachrichten schicken
 * (chrome.runtime.sendMessage(extensionId, …) über "externally_connectable").
 * Das nutzt claude.ai z. B. nach dem Login. Firefox kennt das nicht. Hier
 * stellen wir dieselbe Funktion bereit und leiten über claude-bridge.js an die
 * Extension weiter.
 */
(function () {
  'use strict';
  const CHANNEL = '__claudeFirefoxBridge';
  const KNOWN_IDS = "__FF_CHROME_EXTENSION_IDS__";
  const w = window;

  const chromeObj = w.chrome && typeof w.chrome === 'object' ? w.chrome : {};
  if (!w.chrome) {
    try {
      Object.defineProperty(w, 'chrome', { value: chromeObj, configurable: true, writable: true });
    } catch {
      return;
    }
  }
  const runtime = chromeObj.runtime && typeof chromeObj.runtime === 'object' ? chromeObj.runtime : {};
  if (!chromeObj.runtime) chromeObj.runtime = runtime;
  if (typeof runtime.sendMessage === 'function') return;

  let lastError;
  Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => lastError });

  let seq = 0;
  const pending = new Map();
  w.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== w || !data || data[CHANNEL] !== 'response') return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data);
  });

  function request(extensionId, message) {
    const id = `${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ [CHANNEL]: 'request', id, extensionId, message }, w.location.origin);
    });
  }

  // chrome.runtime.sendMessage(extensionId, message, [options], [callback])
  runtime.sendMessage = function sendMessage(extensionId, message, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    const promise =
      typeof extensionId !== 'string' || !KNOWN_IDS.includes(extensionId)
        ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
        : request(extensionId, message).then((data) => {
            if (data.noResponse) {
              const err = new Error('The message port closed before a response was received.');
              err.noResponse = true;
              throw err;
            }
            return data.response;
          });
    if (typeof callback !== 'function') return promise;
    promise.then(
      (response) => {
        lastError = undefined;
        callback(response);
      },
      (err) => {
        lastError = { message: err.message };
        try {
          callback();
        } finally {
          lastError = undefined;
        }
      },
    );
    return undefined;
  };

  // Falls claude.ai stattdessen direkt auf chrome-extension://… weiterleitet.
  const isExtUrl = (url) => typeof url === 'string' && /^chrome-extension:\/\/[a-p]{32}\//i.test(url);
  const reportRedirect = (url) => w.postMessage({ [CHANNEL]: 'redirect', url }, w.location.origin);

  if (w.navigation && typeof w.navigation.addEventListener === 'function') {
    w.navigation.addEventListener('navigate', (event) => {
      const url = event.destination && event.destination.url;
      if (!isExtUrl(url)) return;
      if (event.cancelable) event.preventDefault();
      reportRedirect(url);
    });
  }
  const originalOpen = w.open;
  w.open = function open(url, ...rest) {
    if (isExtUrl(url)) {
      reportRedirect(url);
      return null;
    }
    return originalOpen.call(this, url, ...rest);
  };
  w.document.addEventListener(
    'click',
    (event) => {
      const link = event.target && event.target.closest && event.target.closest('a[href]');
      if (link && isExtUrl(link.href)) {
        event.preventDefault();
        reportRedirect(link.href);
      }
    },
    true,
  );
})();
