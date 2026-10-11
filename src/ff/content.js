/*
 * Claude-Firefox: Ergänzungen für die Content-Scripts der Extension.
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (!api || api.dom) return;
  // chrome.dom.openOrClosedShadowRoot – Firefox bietet dafür element.openOrClosedShadowRoot.
  try {
    api.dom = { openOrClosedShadowRoot: (el) => (el && (el.openOrClosedShadowRoot || el.shadowRoot)) || null };
  } catch {}
})();
