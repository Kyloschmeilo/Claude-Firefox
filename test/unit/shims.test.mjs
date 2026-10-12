// Testet die gemeinsamen Shim-Funktionen (core.js, compat.js) außerhalb von
// Firefox mit einem nachgebauten `browser`-Objekt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ff');

function loadShims() {
  const calls = [];
  const runtime = {
    id: 'claude-firefox-port@localhost',
    getURL: (p) => `moz-extension://uuid/${p}`,
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
    onConnect: { addListener() {} },
  };
  Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => undefined });
  const browser = {
    runtime,
    tabs: {
      create: async (props) => {
        calls.push(['tabs.create', props]);
        return { id: 1, ...props };
      },
    },
    notifications: {
      create: (opts) => {
        calls.push(['notifications.create', opts]);
        if ('buttons' in opts) throw new Error('Type error for parameter options (Property "buttons" is unsupported by Firefox) for notifications.create.');
        if ('requireInteraction' in opts) {
          return Promise.reject(new Error('Type error for parameter options (Unexpected property "requireInteraction") for notifications.create.'));
        }
        return Promise.resolve('id');
      },
    },
    declarativeNetRequest: {
      sessionRules: [],
      async getSessionRules() {
        return this.sessionRules.map((r) => ({ ...r }));
      },
      async updateSessionRules({ removeRuleIds = [], addRules = [] } = {}) {
        this.sessionRules = this.sessionRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
    },
  };
  const context = vm.createContext({
    browser,
    console: { debug() {}, warn() {}, error() {}, log() {} },
    location: { pathname: '/sidepanel.html' },
    URL,
    setTimeout,
    navigator: { language: 'de-DE' },
  });
  context.globalThis = context;
  context.__ffConfig = { externallyConnectable: ['https://claude.ai/*'] };
  for (const file of ['core.js', 'compat.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
  }
  return { ff: context.__ff, browser, calls };
}

test('chromeApi: Callback bekommt lastError, Promise wird abgelehnt', async () => {
  const { ff, browser } = loadShims();
  const fn = ff.chromeApi(async (x) => {
    if (x === 'fehler') throw new Error('kaputt');
    return x * 2;
  });
  assert.equal(await fn(21), 42);
  await assert.rejects(fn('fehler'), /kaputt/);
  const seen = await new Promise((resolve) => fn('fehler', () => resolve(browser.runtime.lastError && browser.runtime.lastError.message)));
  assert.equal(seen, 'kaputt');
  assert.equal(browser.runtime.lastError, undefined, 'lastError wird nach dem Callback zurückgesetzt');
  const ok = await new Promise((resolve) => fn(2, (r) => resolve([r, browser.runtime.lastError])));
  assert.deepEqual(ok, [4, undefined]);
});

test('makeEvent: Listener verwalten und auslösen', () => {
  const { ff } = loadShims();
  const evt = ff.makeEvent('test');
  const got = [];
  const fn = (a) => got.push(a);
  evt.addListener(fn);
  evt.addListener(fn);
  assert.ok(evt.hasListener(fn) && evt.hasListeners());
  evt.dispatch(1);
  evt.removeListener(fn);
  evt.dispatch(2);
  assert.deepEqual(got, [1]);
});

test('matchPattern', () => {
  const { ff } = loadShims();
  assert.ok(ff.matchPattern('https://claude.ai/*', 'https://claude.ai/oauth/authorize?x=1'));
  assert.ok(!ff.matchPattern('https://claude.ai/*', 'https://evil.com/claude.ai/'));
  assert.ok(!ff.matchPattern('https://claude.ai/*', 'http://claude.ai/'));
  assert.ok(ff.matchPattern('https://*.claude.ai/*', 'https://a.b.claude.ai/x'));
  assert.ok(ff.matchPattern('https://*.claude.ai/*', 'https://claude.ai/x'));
  assert.ok(!ff.matchPattern('https://*.claude.ai/*', 'https://notclaude.ai/x'));
  assert.ok(ff.matchPattern('http://127.0.0.1/*', 'http://127.0.0.1:8080/x'));
  assert.ok(ff.matchPattern('<all_urls>', 'https://x.de/'));
  assert.ok(!ff.matchPattern('<all_urls>', 'about:config'));
});

test('unsupportedProps erkennt Firefox-Fehlermeldungen', () => {
  const { ff } = loadShims();
  const props = (msg) => [...ff.unsupportedProps(msg)];
  assert.deepEqual(props('Type error for parameter options (Property "buttons" is unsupported by Firefox) for notifications.create.'), ['buttons']);
  assert.deepEqual(props('Type error for parameter options (Unexpected property "requireInteraction") for notifications.create.'), ['requireInteraction']);
  assert.deepEqual(
    props('Type error for parameter details (Unexpected properties: abortOnLoadForNonInteractive, timeoutMsForNonInteractive) for identity.launchWebAuthFlow.'),
    ['abortOnLoadForNonInteractive', 'timeoutMsForNonInteractive'],
  );
  assert.deepEqual(props('irgendein anderer Fehler'), []);
});

test('Nicht unterstützte Optionen werden entfernt und der Aufruf wiederholt', async () => {
  const { browser, calls } = loadShims();
  const id = await browser.notifications.create({ type: 'basic', title: 't', message: 'm', buttons: [{ title: 'x' }], requireInteraction: true });
  assert.equal(id, 'id');
  const last = calls.filter((c) => c[0] === 'notifications.create').pop()[1];
  assert.equal('buttons' in last, false);
  assert.equal('requireInteraction' in last, false);
});

test('chrome://- und chrome-extension://-Adressen werden umgeschrieben', async () => {
  const { ff, browser, calls } = loadShims();
  assert.equal(ff.rewriteUrl('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/options.html#permissions'), 'moz-extension://uuid/options.html#permissions');
  assert.match(ff.rewriteUrl('chrome://settings/content/siteDetails?site=x'), /^moz-extension:\/\/uuid\/ff\/info\.html\?url=chrome%3A/);
  assert.equal(ff.rewriteUrl('about:blank'), 'about:blank');
  assert.equal(ff.rewriteUrl('https://claude.ai/'), 'https://claude.ai/');
  assert.equal(ff.rewriteUrl('chrome://newtab/'), undefined);
  assert.equal(ff.rewriteUrl('about:newtab'), undefined);
  assert.match(ff.rewriteUrl('about:config'), /ff\/info\.html/);
  await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  assert.match(calls.pop()[1].url, /ff\/info\.html/);
  await browser.tabs.create({ url: 'chrome://newtab' });
  assert.equal('url' in calls.pop()[1], false);
});

test('declarativeNetRequest-Konstanten werden ergänzt', () => {
  const { browser } = loadShims();
  const dnr = browser.declarativeNetRequest;
  assert.equal(dnr.RuleActionType.MODIFY_HEADERS, 'modifyHeaders');
  assert.equal(dnr.HeaderOperation.SET, 'set');
  assert.equal(dnr.ResourceType.XMLHTTPREQUEST, 'xmlhttprequest');
  assert.equal(dnr.ResourceType.MAIN_FRAME, 'main_frame');
});

test('Eigene Sitzungsregeln sind für das Original unsichtbar und nicht löschbar', async () => {
  const { ff, browser } = loadShims();
  const dnr = browser.declarativeNetRequest;
  const [own] = ff.sessionRules.ids;
  await ff.sessionRules.update({ addRules: [{ id: own }] });
  await dnr.updateSessionRules({ addRules: [{ id: 5 }] });
  assert.deepEqual((await dnr.getSessionRules()).map((r) => r.id), [5]);
  const viaCallback = await new Promise((resolve) => dnr.getSessionRules((rules) => resolve(rules.map((r) => r.id))));
  assert.deepEqual(viaCallback, [5]);
  // Original räumt alles auf, was es sieht – und auch mehr.
  await dnr.updateSessionRules({ removeRuleIds: [5, own] });
  assert.deepEqual((await ff.sessionRules.get()).map((r) => r.id), [own]);
});

test('Offscreen-API ist vorhanden', () => {
  const { browser } = loadShims();
  assert.equal(typeof browser.offscreen.createDocument, 'function');
  assert.equal(browser.offscreen.Reason.AUDIO_PLAYBACK, 'AUDIO_PLAYBACK');
});
