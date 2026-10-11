// Läuft als Erweiterungsseite im gebauten Add-on (nur für Tests).
// Ruft die Browser-Steuerung der Original-Extension auf (dieselben Funktionen,
// die Claude benutzt) und meldet die Ergebnisse an den Test-Server.

const { port: PORT, modules: MODULES } = globalThis.__ffTest;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

async function report(extra = {}) {
  await fetch(`${BASE}/__results`, { method: 'POST', body: JSON.stringify({ results, ...extra }) });
}

async function findCdp() {
  for (const file of MODULES) {
    try {
      const mod = await import(`/${file}`);
      for (const value of Object.values(mod)) {
        if (value && typeof value === 'object' && typeof value.click === 'function' && typeof value.screenshot === 'function' && typeof value.type === 'function') {
          return value;
        }
      }
    } catch (err) {
      console.warn('Import fehlgeschlagen', file, err);
    }
  }
  return null;
}

async function waitTab(tabId) {
  for (let i = 0; i < 100; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await sleep(100);
  }
  throw new Error(`Tab ${tabId} lädt nicht`);
}

async function inPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return r.result;
}

async function center(tabId, selector) {
  return inPage(
    tabId,
    (s) => {
      const el = document.querySelector(s);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    },
    [selector],
  );
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, `Exception: ${err && err.message} @ ${err && err.stack}`);
  }
}

async function run() {
  const cdp = await findCdp();
  check('Original-CDP-Modul gefunden', !!cdp);
  if (!cdp) return;

  const diag = async (label) => {
    const desc = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
    const seen = await new Promise((resolve) =>
      chrome.debugger.sendCommand({ tabId: -5 }, 'Page.enable', {}, () => resolve(chrome.runtime.lastError && chrome.runtime.lastError.message)),
    );
    check(`lastError-Diagnose ${label}`, !!seen, { seen, getter: desc && desc.get && desc.get.name, same: chrome === browser });
  };
  await diag('Start');
  const startInfo = { ...(await globalThis.__ff.bg.call('shim.info')), t: Date.now() };
  const tab = await chrome.tabs.create({ url: `${BASE}/form`, active: true });
  const tabId = tab.id;
  await waitTab(tabId);
  await sleep(300);

  await step('attachDebugger', async () => {
    await cdp.attachDebugger(tabId);
    check('attachDebugger', true);
  });

  await step('screenshot', async () => {
    const shot = await cdp.screenshot(tabId);
    check('screenshot', shot && shot.base64 && shot.base64.length > 1000 && shot.width > 0 && shot.height > 0, {
      width: shot.width,
      height: shot.height,
      viewportWidth: shot.viewportWidth,
      length: shot.base64.length,
    });
  });

  await step('type into input', async () => {
    const p = await center(tabId, '#name');
    await cdp.click(tabId, p.x, p.y);
    await cdp.type(tabId, 'Hallo Welt');
    const v = await inPage(tabId, () => ({
      value: document.getElementById('name').value,
      active: document.activeElement.id,
      keydowns: window.events.keydowns.slice(0, 2),
      inputs: window.events.inputs,
    }));
    check('type into input', v.value === 'Hallo Welt' && v.keydowns[0] === 'H:72', v);
  });

  await step('ctrl+a, backspace', async () => {
    await cdp.pressKeyChord(tabId, 'ctrl+a');
    await cdp.type(tabId, 'Neu');
    let v = await inPage(tabId, () => document.getElementById('name').value);
    check('ctrl+a ersetzt Text', v === 'Neu', v);
    await cdp.pressKeyChord(tabId, 'backspace');
    v = await inPage(tabId, () => document.getElementById('name').value);
    check('backspace', v === 'Ne', v);
    await cdp.pressKeyChord(tabId, 'left');
    await cdp.type(tabId, 'X');
    v = await inPage(tabId, () => document.getElementById('name').value);
    check('Pfeiltaste bewegt Cursor', v === 'NXe', v);
  });

  await step('enter submits', async () => {
    await cdp.pressKeyChord(tabId, 'Enter');
    const v = await inPage(tabId, () => ({ submits: window.events.submits, submitted: window.events.submitted }));
    check('Enter sendet Formular ab', v.submits === 1 && v.submitted === 'NXe', v);
  });

  await step('button click', async () => {
    const p = await center(tabId, '#btn');
    await cdp.click(tabId, p.x, p.y);
    let v = await inPage(tabId, () => ({ clicks: window.events.clicks, x: window.events.clickX }));
    check('Button-Klick', v.clicks === 1 && Math.abs(v.x - p.x) < 2, v);
    await cdp.click(tabId, p.x, p.y, 'left', 2);
    v = await inPage(tabId, () => ({ clicks: window.events.clicks, dbl: window.events.dbl }));
    check('Doppelklick', v.dbl === 1 && v.clicks === 3, v);
  });

  await step('checkbox', async () => {
    const p = await center(tabId, '#cb');
    await cdp.click(tabId, p.x, p.y);
    const v = await inPage(tabId, () => document.getElementById('cb').checked);
    check('Checkbox', v === true, v);
  });

  await step('textarea', async () => {
    const p = await center(tabId, '#ta');
    await cdp.click(tabId, p.x, p.y);
    await cdp.type(tabId, 'Zeile1\nZeile2');
    const v = await inPage(tabId, () => document.getElementById('ta').value);
    check('Textarea mit Zeilenumbruch', v === 'Zeile1\nZeile2', v);
  });

  await step('contenteditable', async () => {
    const p = await center(tabId, '#ce');
    await cdp.click(tabId, p.x, p.y);
    await cdp.type(tabId, 'Rich Text äöü 🙂');
    const v = await inPage(tabId, () => document.getElementById('ce').textContent);
    check('Contenteditable mit Umlauten', v === 'Rich Text äöü 🙂', v);
  });

  await step('select', async () => {
    await inPage(tabId, () => document.getElementById('sel').focus());
    await cdp.pressKeyChord(tabId, 'down');
    const v = await inPage(tabId, () => document.getElementById('sel').value);
    check('Select per Pfeiltaste', v === 'zwei', v);
  });

  await step('scroll', async () => {
    const w = await inPage(tabId, () => {
      window.scrollTo(0, 0);
      return window.innerWidth;
    });
    await cdp.scrollWheel(tabId, w - 40, 20, 0, 500);
    let v = await inPage(tabId, () => window.scrollY);
    check('Seite scrollen', v >= 400, v);
    const p = await center(tabId, '#scroller');
    const before = await inPage(tabId, () => window.scrollY);
    await cdp.scrollWheel(tabId, p.x, p.y, 0, 200);
    v = await inPage(tabId, () => ({ inner: document.getElementById('scroller').scrollTop, y: window.scrollY }));
    check('Scrollbereich scrollen', v.inner > 0 && v.y === before, v);
  });

  await step('iframe', async () => {
    const p = await inPage(tabId, () => {
      const f = document.getElementById('xf');
      f.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = f.getBoundingClientRect();
      return { x: b.left + 100, y: b.top + 20 };
    });
    await cdp.click(tabId, p.x, p.y);
    await sleep(100);
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => ({ href: location.href, clicks: window.frameClicks }),
    });
    const frame = frames.map((f) => f.result).find((r) => r && r.href.includes('/frame'));
    check('Klick in fremdes iframe', frame && frame.clicks === 1, frame);
  });

  await step('Scrollen über iframe', async () => {
    const p = await inPage(tabId, () => {
      const f = document.getElementById('xf');
      f.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.scrollBy(0, -100);
      const b = f.getBoundingClientRect();
      return { x: b.left + 250, y: b.top + 60, y0: window.scrollY };
    });
    await cdp.scrollWheel(tabId, p.x, p.y, 0, 300);
    const y = await inPage(tabId, () => window.scrollY);
    check('Scrollen über iframe scrollt die Seite', y >= p.y0 + 250, { before: p.y0, after: y });
  });

  await step('target=_blank', async () => {
    const p = await center(tabId, '#blank');
    await cdp.click(tabId, p.x, p.y);
    await sleep(800);
    const tabs = await chrome.tabs.query({});
    check('Link mit target=_blank öffnet Tab', tabs.some((t) => (t.url || '').includes('/target')), tabs.map((t) => t.url));
    await chrome.tabs.update(tabId, { active: true });
  });

  await step('console', async () => {
    await cdp.enableConsoleTracking(tabId);
    const p = await center(tabId, '#logbtn');
    await cdp.click(tabId, p.x, p.y);
    await sleep(600);
    let msgs = cdp.getConsoleMessages(tabId);
    check(
      'Console-Meldungen',
      msgs.some((m) => m.text.includes('log-click 123 {"a":1}')) &&
        msgs.some((m) => m.type === 'warning') &&
        msgs.some((m) => m.type === 'exception' && m.text.includes('boom-click')),
      msgs.map((m) => `${m.type}: ${m.text}`.slice(0, 120)),
    );
    cdp.clearConsoleMessages(tabId);
    await chrome.tabs.reload(tabId);
    await waitTab(tabId);
    await sleep(800);
    msgs = cdp.getConsoleMessages(tabId);
    check('Console-Meldungen beim Laden', msgs.some((m) => m.text.includes('page-loaded-log')), msgs.map((m) => m.text.slice(0, 80)));
  });

  await step('network', async () => {
    await cdp.enableNetworkTracking(tabId);
    const p = await center(tabId, '#fetchbtn');
    await cdp.click(tabId, p.x, p.y);
    await sleep(600);
    const reqs = cdp.getNetworkRequests(tabId);
    const api = reqs.find((r) => r.url.includes('/api/data'));
    check('Netzwerk-Anfragen', api && api.status === 200, reqs.slice(-5));
  });

  await step('Runtime.evaluate', async () => {
    let r = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
      expression: "(function(){ 'use strict'; return eval(\"document.title + '!'\"); })()",
      returnByValue: true,
      awaitPromise: true,
    });
    check('JavaScript ausführen', r.result && r.result.value === 'Testformular!', r);
    r = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'new Promise((res) => setTimeout(() => res({ a: [1, 2] }), 50))',
      returnByValue: true,
      awaitPromise: true,
    });
    check('JavaScript mit Promise', r.result && JSON.stringify(r.result.value) === '{"a":[1,2]}', r);
    r = await cdp.sendCommand(tabId, 'Runtime.evaluate', { expression: 'throw new Error("kaputt")', returnByValue: true });
    check('JavaScript-Fehler', r.exceptionDetails && r.exceptionDetails.exception.description.includes('kaputt'), r);
    r = await cdp.sendCommand(tabId, 'Runtime.evaluate', { expression: 'document.body', returnByValue: true });
    check('DOM-Knoten', r.result && r.result.subtype === 'node' && r.result.description === 'body', r);
  });

  await step('CSP-Seite', async () => {
    const t2 = await chrome.tabs.create({ url: `${BASE}/csp`, active: true });
    await waitTab(t2.id);
    await cdp.attachDebugger(t2.id);
    const r = await cdp.sendCommand(t2.id, 'Runtime.evaluate', { expression: '1+1', returnByValue: true });
    check('CSP blockiert JavaScript mit Hinweis', r.exceptionDetails && /Content-Security-Policy/.test(r.exceptionDetails.exception.description), r);
    const p = await center(t2.id, '#i');
    await cdp.click(t2.id, p.x, p.y);
    await cdp.type(t2.id, 'trotz CSP');
    const v = await chrome.scripting.executeScript({ target: { tabId: t2.id }, func: () => document.getElementById('i').value });
    check('Tippen auf CSP-Seite', v[0].result === 'trotz CSP', v[0].result);
    const shot = await cdp.screenshot(t2.id);
    check('Screenshot auf CSP-Seite', shot && shot.base64.length > 500);
    await chrome.tabs.update(tabId, { active: true });
  });

  await step('Hintergrund läuft durch', async () => {
    const info = await globalThis.__ff.bg.call('shim.info');
    check('Hintergrund läuft durch', info.startedAt === startInfo.startedAt, { startInfo, info, elapsed: Date.now() - startInfo.t });
  });

  await diag('vor detach');
  await step('getTargets/detach', async () => {
    const targets = await chrome.debugger.getTargets();
    check('getTargets', targets.some((t) => t.tabId === tabId && t.attached), targets.length);
    await cdp.detachDebugger(tabId);
    let error = null;
    try {
      await new Promise((resolve, reject) =>
        chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () =>
          chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(),
        ),
      );
    } catch (err) {
      error = err.message;
    }
    const after = (await chrome.debugger.getTargets()).filter((t) => t.tabId === tabId);
    check('lastError nach detach', error && /not attached/i.test(error), { error, after });
    const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', { expression: '40+2', returnByValue: true });
    check('automatisches Neu-Anhängen', res.result && res.result.value === 42, res);
  });

  await step('offscreen', async () => {
    // Die Original-Extension legt ihr Offscreen-Dokument meist schon selbst an.
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'test' });
    }
    check('Offscreen-Dokument', await chrome.offscreen.hasDocument());
    let error = null;
    try {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'test' });
    } catch (err) {
      error = err.message;
    }
    check('Nur ein Offscreen-Dokument (wie Chrome)', /single offscreen/.test(error || ''), error);
  });

  await step('sidePanel', async () => {
    await chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
    const panel = await browser.sidebarAction.getPanel({ windowId: tab.windowId });
    check('sidePanel.setOptions -> Sidebar-Panel', panel.endsWith(`sidepanel.html?tabId=${tabId}`), panel);
  });

  await step('Claude für Tab öffnen (wie Toolbar-Klick)', async () => {
    const t = await chrome.tabs.create({ url: `${BASE}/target`, active: true });
    await waitTab(t.id);
    const res = await globalThis.__ff.bg.call('sidebar.openForTab', t.windowId);
    let panel = '';
    let group = -1;
    for (let i = 0; i < 40 && !(panel.includes(`tabId=${t.id}`) && group !== -1); i++) {
      await sleep(100);
      panel = await browser.sidebarAction.getPanel({ windowId: t.windowId });
      group = (await chrome.tabs.get(t.id)).groupId;
    }
    check('Toolbar-Klick: Original-Code setzt Panel', res.ok && res.via === 'action' && panel.endsWith(`sidepanel.html?tabId=${t.id}`), { res, panel });
    check('Toolbar-Klick: Original-Code legt Tab-Gruppe an', group !== -1, group);
    await chrome.tabs.remove(t.id);
    for (let i = 0; i < 30 && panel.includes(`tabId=${t.id}`); i++) {
      await sleep(100);
      panel = await browser.sidebarAction.getPanel({ windowId: t.windowId });
    }
    const auto = await globalThis.__ff.bg.call('sidebar.shouldAutoStart', t.windowId);
    check('Tab geschlossen: Panel zurückgesetzt, kein Autostart', panel.endsWith('ff/sidebar.html') && auto === false, { panel, auto });
    await chrome.tabs.update(tabId, { active: true });
  });

  await step('notifications', async () => {
    await chrome.notifications.create({ type: 'basic', title: 't', message: 'm', iconUrl: 'icon-128.png', buttons: [{ title: 'x' }], requireInteraction: true });
    check('Benachrichtigung mit Chrome-Optionen', true);
  });

  await step('chrome:// umschreiben', async () => {
    const t = await chrome.tabs.create({ url: 'chrome://settings/content/siteDetails?site=x', active: false });
    await sleep(300);
    const info = await chrome.tabs.get(t.id);
    check('chrome://-Link -> Hinweisseite', (info.url || info.pendingUrl || '').includes('ff/info.html'), info.url);
  });

  await step('externally_connectable', async () => {
    const t = await chrome.tabs.create({ url: `${BASE}/external`, active: false });
    await waitTab(t.id);
    let title = '';
    for (let i = 0; i < 30 && !title.startsWith('external:'); i++) {
      await sleep(100);
      title = (await chrome.tabs.get(t.id)).title || '';
    }
    // Der Original-Code akzeptiert nur https://claude.ai – die Antwort beweist, dass die Brücke funktioniert.
    check('Nachricht von Webseite an Extension', /Untrusted origin|exists/.test(title), title);
  });

  for (const [path, code] of [
    ['/oauth-js', 'js-code'],
    ['/oauth-302', 'http-code'],
  ]) {
    await step(`OAuth-Weiterleitung ${path}`, async () => {
      await chrome.tabs.create({ url: `${BASE}${path}`, active: false });
      let last = null;
      for (let i = 0; i < 40 && !(last && last.url.includes(code)); i++) {
        await sleep(100);
        last = await globalThis.__ff.bg.call('shim.lastRedirect');
      }
      // Antwort des Original-Codes: Er akzeptiert nur https://claude.ai, hat die Nachricht aber erhalten.
      const answered = last && last.result && last.result.response && /Untrusted origin/.test(last.result.response.error || '');
      check(`OAuth-Weiterleitung abgefangen (${path})`, last && last.url.includes(code) && answered, last);
    });
  }

  await step('Seitenpanel lädt', async () => {
    const frame = document.createElement('iframe');
    frame.src = `/sidepanel.html?tabId=${tabId}`;
    frame.style.cssText = 'width:400px;height:600px';
    document.body.appendChild(frame);
    await new Promise((r) => frame.addEventListener('load', r, { once: true }));
    let text = '';
    for (let i = 0; i < 50 && text.length < 10; i++) {
      await sleep(100);
      text = frame.contentDocument.body.innerText.trim();
    }
    check('Seitenpanel rendert', text.length >= 10, text.slice(0, 200));
  });
}

run()
  .catch((err) => check('Runner', false, String(err && (err.stack || err))))
  .finally(() => report());
