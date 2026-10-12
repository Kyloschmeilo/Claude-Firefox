import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { readZip, writeZip, crc32 } from '../../scripts/lib/zip.mjs';
import { unpackCrx, bytesToExtensionId, publicKeyToExtensionId, manifestKeyToExtensionId } from '../../scripts/lib/crx.mjs';
import { injectShims } from '../../scripts/lib/html.mjs';
import { squarePng } from '../../scripts/lib/png.mjs';
import { transformManifest, BACKGROUND_SHIMS, DEFAULT_CHROME_EXTENSION_ID } from '../../scripts/lib/manifest.mjs';

test('ZIP: Schreiben und Lesen ergibt dieselben Dateien', () => {
  const files = new Map([
    ['manifest.json', Buffer.from('{"a":1}')],
    ['assets/x.js', Buffer.from('console.log("ä");'.repeat(100))],
    ['leer.txt', Buffer.alloc(0)],
  ]);
  const back = readZip(writeZip(files));
  assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
});

test('ZIP: CRC32 stimmt mit zlib überein', () => {
  const data = Buffer.from('Claude-Firefox');
  if (typeof zlib.crc32 === 'function') assert.equal(crc32(data), zlib.crc32(data));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP: Ordner-Einträge mit Backslash (Windows) werden übersprungen', () => {
  const zip = writeZip(new Map([['assets\\', Buffer.alloc(0)], ['assets\\x.js', Buffer.from('x')]]));
  const back = readZip(zip);
  assert.deepEqual([...back.keys()], ['assets/x.js']);
});

test('ZIP: unsichere Pfade werden abgelehnt', () => {
  const zip = writeZip(new Map([['../boese.txt', Buffer.from('x')]]));
  assert.throws(() => readZip(zip), /Unsicherer Pfad/);
});

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}
const field = (num, data) => Buffer.concat([varint((num << 3) | 2), varint(data.length), data]);

test('CRX3: Extension-ID und ZIP werden erkannt', () => {
  const zip = writeZip(new Map([['manifest.json', Buffer.from('{}')]]));
  const crxId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const header = field(10000, field(1, crxId));
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  const { zip: out, extensionId, format } = unpackCrx(Buffer.concat([head, header, zip]));
  assert.equal(format, 'crx3');
  assert.equal(extensionId, 'aabbccddeeffgghhiijjkkllmmnnoopp');
  assert.ok(out.equals(zip));
});

test('CRX2: Extension-ID aus dem Schlüssel', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const zip = writeZip(new Map([['manifest.json', Buffer.from('{}')]]));
  const head = Buffer.alloc(16);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(der.length, 8);
  head.writeUInt32LE(4, 12);
  const { extensionId } = unpackCrx(Buffer.concat([head, der, Buffer.alloc(4), zip]));
  assert.equal(extensionId, publicKeyToExtensionId(der));
  assert.equal(extensionId, manifestKeyToExtensionId(der.toString('base64')));
  assert.match(extensionId, /^[a-p]{32}$/);
});

test('CRX: reine ZIP-Dateien und Fehler', () => {
  const zip = writeZip(new Map([['a', Buffer.from('b')]]));
  assert.equal(unpackCrx(zip).format, 'zip');
  assert.throws(() => unpackCrx(Buffer.from('<html>Fehler</html>')), /weder CRX noch ZIP/);
  assert.equal(bytesToExtensionId(Buffer.alloc(16)), 'a'.repeat(32));
});

test('HTML: Shims landen am Anfang von <head> und nur einmal', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/x.js"></script></head></html>';
  const out = injectShims(html, ['ff/a.js', 'ff/b.js']);
  assert.ok(out.indexOf('/ff/a.js') < out.indexOf('/x.js'));
  assert.ok(out.indexOf('/ff/a.js') < out.indexOf('/ff/b.js'));
  assert.equal(injectShims(out, ['ff/a.js']), out);
  assert.match(injectShims('<p>ohne head</p>', ['ff/a.js']), /^<script src="\/ff\/a.js"/);
});

function makePng(width, height, colorType = 6) {
  const bpp = { 2: 3, 6: 4 }[colorType];
  const rows = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * bpp);
    for (let x = 0; x < width * bpp; x++) line[x] = (x * 7 + y * 13) & 0xff;
    // Abwechselnd Filter 0 (keiner) und 1 (Sub), damit das Entfiltern geprüft wird.
    const filter = y % 2;
    const enc = Buffer.alloc(line.length);
    for (let x = 0; x < line.length; x++) enc[x] = filter === 1 ? (line[x] - (x >= bpp ? line[x - bpp] : 0)) & 0xff : line[x];
    rows.push(Buffer.concat([Buffer.from([filter]), enc]), );
  }
  const chunkOf = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf('IHDR', ihdr),
    chunkOf('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunkOf('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG: nicht quadratische Icons werden zugeschnitten', () => {
  const out = squarePng(makePng(6, 7));
  assert.ok(out);
  assert.equal(out.readUInt32BE(16), 6);
  assert.equal(out.readUInt32BE(20), 6);
  // Pixel prüfen: Zeile 0 des Ergebnisses = Zeile 0 des Originals (Versatz floor(1/2) = 0).
  const idat = out.indexOf('IDAT');
  const len = out.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(out.subarray(idat + 4, idat + 4 + len));
  assert.equal(raw[0], 0);
  for (let x = 0; x < 24; x++) assert.equal(raw[1 + x], (x * 7) & 0xff);
  assert.equal(squarePng(makePng(5, 5)), null);
  assert.equal(squarePng(Buffer.from('kein png')), null);
});

const CHROME_MANIFEST = {
  manifest_version: 3,
  name: 'Claude',
  version: '1.2.3',
  key: 'abc',
  update_url: 'https://clients2.google.com/service/update2/crx',
  minimum_chrome_version: '120',
  icons: { 128: 'icon-128.png' },
  background: { service_worker: 'service-worker-loader.js', type: 'module' },
  side_panel: { default_path: 'sidepanel.html' },
  action: { default_title: 'Open Claude' },
  options_page: 'options.html',
  permissions: ['sidePanel', 'debugger', 'offscreen', 'system.display', 'tabs', 'storage', 'tabGroups', 'nativeMessaging'],
  optional_permissions: ['nativeMessaging', 'tabCapture'],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    { matches: ['<all_urls>'], js: ['a.js'], run_at: 'document_start' },
    { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' },
  ],
  commands: { 'toggle-side-panel': { suggested_key: { default: 'Ctrl+E' }, description: 'Toggle side panel', global: true } },
  externally_connectable: { matches: ['https://claude.ai/*'] },
  web_accessible_resources: [
    { resources: ['assets/*'], matches: ['https://claude.ai/*'], use_dynamic_url: true },
    { resources: ['x'], extension_ids: ['abc'] },
  ],
  content_security_policy: { extension_pages: "script-src 'self'", sandbox: 'sandbox allow-scripts' },
  sandbox: { pages: ['sandbox.html'] },
  incognito: 'split',
};

test('Manifest: Grundumbau Chrome -> Firefox', () => {
  const { manifest: m, config, report } = transformManifest(CHROME_MANIFEST, { chromeExtensionId: 'x'.repeat(32) });
  assert.equal(m.name, 'Claude (inoffizieller Port)');
  assert.doesNotMatch(m.name, /firefox/i);
  assert.deepEqual(m.background, { scripts: [...BACKGROUND_SHIMS, 'service-worker-loader.js'], type: 'module' });
  assert.equal(m.sidebar_action.default_panel, 'ff/sidebar.html');
  assert.equal(m.side_panel, undefined);
  assert.equal(m.key, undefined);
  assert.equal(m.update_url, undefined);
  assert.equal(m.externally_connectable, undefined);
  assert.deepEqual(m.options_ui, { page: 'options.html', open_in_tab: true });
  assert.equal(m.browser_specific_settings.gecko.id, 'claude-firefox-port@localhost');
  for (const p of ['sidePanel', 'debugger', 'offscreen', 'system.display']) assert.ok(!m.permissions.includes(p), p);
  for (const p of ['tabs', 'storage', 'tabGroups', 'nativeMessaging', 'scripting', 'webNavigation', 'webRequest', 'declarativeNetRequestWithHostAccess']) {
    assert.ok(m.permissions.includes(p), p);
  }
  assert.equal(m.optional_permissions, undefined);
  assert.ok(report.removedPermissions.some((r) => r.includes('debugger')));
  assert.deepEqual(m.content_scripts[0].js, ['ff/content.js', 'a.js']);
  assert.deepEqual(m.content_scripts[1].js, ['main.js']);
  const bridge = m.content_scripts.filter((c) => c.js.some((j) => j.startsWith('ff/claude-bridge')));
  assert.equal(bridge.length, 2);
  assert.equal(bridge[0].world, 'MAIN');
  assert.deepEqual(bridge[0].matches, ['https://claude.ai/*']);
  assert.ok(bridge.every((c) => c.all_frames === true), 'Brücke auch in eingebetteten Rahmen');
  assert.equal(m.web_accessible_resources.length, 1);
  assert.equal(m.web_accessible_resources[0].use_dynamic_url, undefined);
  assert.equal(m.commands['toggle-side-panel'].global, undefined);
  assert.deepEqual(m.content_security_policy, { extension_pages: "script-src 'self'", sandbox: 'sandbox allow-scripts' });
  assert.deepEqual(m.sandbox, { pages: ['sandbox.html'] });
  assert.deepEqual(config.sandboxPages, ['sandbox.html']);
  const bad = transformManifest({ ...CHROME_MANIFEST, content_security_policy: { sandbox: 'sandbox allow-scripts allow-same-origin' } });
  assert.equal(bad.manifest.content_security_policy, undefined);
  assert.equal(m.incognito, 'spanning');
  assert.deepEqual(config.chromeExtensionIds, ['x'.repeat(32)]);
  assert.deepEqual(config.externallyConnectable, ['https://claude.ai/*']);
  assert.equal(config.sidePanelPath, 'sidepanel.html');
  assert.deepEqual(config.sidePanelCommands, ['toggle-side-panel']);
});

test('Manifest: Optionen', () => {
  const { manifest: m, config } = transformManifest(CHROME_MANIFEST, {
    keepName: true,
    versionSuffix: '7',
    geckoId: 'ich@beispiel',
  });
  assert.equal(m.name, 'Claude');
  assert.equal(m.version, '1.2.3.7');
  assert.equal(transformManifest(CHROME_MANIFEST, { name: '  Mein Claude ' }).manifest.name, 'Mein Claude');
  assert.ok(transformManifest(CHROME_MANIFEST, { name: 'Claude für Firefox' }).report.warnings.some((w) => /Firefox/.test(w)));
  assert.equal(m.browser_specific_settings.gecko.id, 'ich@beispiel');
  assert.deepEqual(config.chromeExtensionIds, [DEFAULT_CHROME_EXTENSION_ID]);
  assert.throws(() => transformManifest({ ...CHROME_MANIFEST, manifest_version: 2 }), /Manifest V3/);
});
