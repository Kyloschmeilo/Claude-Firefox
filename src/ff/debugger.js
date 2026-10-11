/*
 * Claude-Firefox: chrome.debugger für Firefox.
 * Firefox hat keine Debugger-API. Diese Datei stellt dieselbe Schnittstelle in
 * jedem Kontext bereit. Die eigentliche Arbeit macht engine.js im Hintergrund.
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  if (!ff || ff.debuggerLoaded) return;
  ff.debuggerLoaded = true;
  const api = ff.api;

  // Sollte Firefox irgendwann eine echte Debugger-API bekommen, nehmen wir die.
  if (api.debugger && typeof api.debugger.sendCommand === 'function' && !api.debugger.__ffShim) return;

  const onEvent = ff.makeEvent('debugger.onEvent');
  const onDetach = ff.makeEvent('debugger.onDetach');

  if (ff.isBackground) {
    ff.debuggerEvents = { onEvent, onDetach };
  } else {
    // Ereignisse erst abonnieren, wenn jemand zuhört.
    let subscribed = false;
    const subscribe = () => {
      if (subscribed) return;
      subscribed = true;
      ff.bg.on('debugger.event', (target, method, params) => onEvent.dispatch(target, method, params));
      ff.bg.on('debugger.detach', (target, reason) => onDetach.dispatch(target, reason));
    };
    for (const evt of [onEvent, onDetach]) {
      const add = evt.addListener;
      evt.addListener = (fn) => {
        add.call(evt, fn);
        subscribe();
      };
    }
  }

  api.debugger = {
    __ffShim: true,
    attach: ff.chromeApi((target, requiredVersion) => ff.bg.call('debugger.attach', target, requiredVersion)),
    detach: ff.chromeApi((target) => ff.bg.call('debugger.detach', target)),
    sendCommand: ff.chromeApi((target, method, commandParams) =>
      ff.bg.call('debugger.sendCommand', target, method, commandParams || {}),
    ),
    getTargets: ff.chromeApi(() => ff.bg.call('debugger.getTargets')),
    onEvent,
    onDetach,
    DetachReason: Object.freeze({ CANCELED_BY_USER: 'canceled_by_user', TARGET_CLOSED: 'target_closed' }),
    TargetInfoType: Object.freeze({ PAGE: 'page', BACKGROUND_PAGE: 'background_page', WORKER: 'worker', OTHER: 'other' }),
  };
})();
