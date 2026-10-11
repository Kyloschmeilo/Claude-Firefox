/*
 * Claude-Firefox: Gegenstück zu claude-bridge-main.js (isolierte Welt).
 * Leitet Nachrichten von claude.ai an den Hintergrund der Extension weiter.
 */
(function () {
  'use strict';
  const CHANNEL = '__claudeFirefoxBridge';
  const api = globalThis.browser || globalThis.chrome;

  const plain = (value) => {
    try {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  };

  const reply = (payload) => window.postMessage(plain({ [CHANNEL]: 'response', ...payload }), location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    const kind = event.data[CHANNEL];
    if (kind === 'request') {
      const id = String(event.data.id);
      const extensionId = String(event.data.extensionId);
      const message = plain(event.data.message);
      api.runtime
        .sendMessage({ __ffExternal: { extensionId, message } })
        .then((res) => {
          if (!res) reply({ id, noResponse: true });
          else if (res.error) reply({ id, error: res.error });
          else if (res.noResponse) reply({ id, noResponse: true });
          else reply({ id, response: res.response });
        })
        .catch((err) => reply({ id, error: String((err && err.message) || err) }));
    } else if (kind === 'redirect') {
      api.runtime.sendMessage({ __ffExternalRedirect: String(event.data.url) }).catch(() => {});
    }
  });
})();
