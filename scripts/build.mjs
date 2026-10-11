#!/usr/bin/env node
// Baut aus der offiziellen Claude-Chrome-Extension ein Firefox-Add-on.
//
//   node scripts/build.mjs                 # lädt die aktuelle Version aus dem Chrome Web Store
//   node scripts/build.mjs --crx datei.crx # benutzt eine lokale CRX- oder ZIP-Datei
//   node scripts/build.mjs --dir ordner    # benutzt einen entpackten Extension-Ordner
//
// Ergebnis: dist/extension/ (entpackt) und dist/claude-firefox-<version>.xpi

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { readZip, writeZip, normalizeEntryName } from './lib/zip.mjs';
import { unpackCrx, manifestKeyToExtensionId } from './lib/crx.mjs';
import { downloadCrx } from './lib/fetch-crx.mjs';
import { injectShims } from './lib/html.mjs';
import { squarePng } from './lib/png.mjs';
import { transformManifest, PAGE_SHIMS, DEFAULT_CHROME_EXTENSION_ID } from './lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FF = path.join(ROOT, 'src', 'ff');

const HELP = `
Claude-Firefox – baut die Claude-Chrome-Extension zu einem Firefox-Add-on um.

Aufruf:
  node scripts/build.mjs [Optionen]

Quelle (eine davon, sonst wird die aktuelle Version heruntergeladen):
  --crx <datei>          Lokale .crx- oder .zip-Datei der Extension
  --dir <ordner>         Entpackter Extension-Ordner (z. B. aus dem Chrome-Profil)
  --id <extension-id>    Chrome-Extension-ID zum Herunterladen
                         (Standard: ${DEFAULT_CHROME_EXTENSION_ID})

Weitere Optionen:
  --out <ordner>         Ausgabeordner (Standard: dist)
  --gecko-id <id>        Firefox-Add-on-ID (Standard: claude-firefox-port@localhost)
  --version-suffix <n>   Hängt ".n" an die Versionsnummer an (für selbst signierte Builds)
  --keep-name            Namen der Extension nicht um "(Firefox-Port)" ergänzen
  --no-xpi               Nur den entpackten Ordner erzeugen
  -h, --help             Diese Hilfe
`;

function stripJsonComments(text) {
  // Chrome erlaubt Kommentare in manifest.json, JSON.parse nicht.
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function readDirRecursive(dir) {
  const files = new Map();
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.set(normalizeEntryName(childRel), fs.readFileSync(childAbs));
    }
  };
  walk(dir, '');
  return files;
}

function compareVersions(a, b) {
  const pa = a.split(/[._]/).map(Number);
  const pb = b.split(/[._]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Findet im Chrome-Profilordner (…/Extensions/<id>/<version>_0) die neueste Version. */
function resolveExtensionDir(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const candidates = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort(compareVersions);
  if (!candidates.length) throw new Error(`Keine manifest.json in ${dir} gefunden.`);
  return path.join(dir, candidates[candidates.length - 1]);
}

async function loadSource(opts) {
  if (opts.dir) {
    const dir = resolveExtensionDir(path.resolve(opts.dir));
    console.log(`• Lese entpackte Extension aus ${dir}`);
    return { files: readDirRecursive(dir), extensionId: null };
  }
  let crxBuf;
  let fromDownload = false;
  if (opts.crx) {
    console.log(`• Lese ${opts.crx}`);
    crxBuf = fs.readFileSync(path.resolve(opts.crx));
  } else {
    const id = opts.id || DEFAULT_CHROME_EXTENSION_ID;
    console.log(`• Lade aktuelle Version von ${id} aus dem Chrome Web Store …`);
    crxBuf = await downloadCrx(id);
    fromDownload = true;
    const cacheDir = path.join(ROOT, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${id}.crx`), crxBuf);
  }
  const { zip, extensionId, format } = unpackCrx(crxBuf);
  console.log(`  Format: ${format}${extensionId ? `, Extension-ID: ${extensionId}` : ''}`);
  return { files: readZip(zip), extensionId: extensionId || (fromDownload ? opts.id : null) };
}

function addShimFiles(files, config) {
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else files.set(childRel, fs.readFileSync(childAbs));
    }
  };
  walk(SRC_FF, 'ff');

  // Die MAIN-World-Brücke auf claude.ai hat keinen Zugriff auf Extension-APIs,
  // deshalb schreiben wir die bekannten Chrome-IDs direkt hinein.
  const bridge = files.get('ff/claude-bridge-main.js').toString('utf8');
  files.set(
    'ff/claude-bridge-main.js',
    Buffer.from(bridge.replace('"__FF_CHROME_EXTENSION_IDS__"', JSON.stringify(config.chromeExtensionIds))),
  );
  files.set('ff/config.js', Buffer.from(`globalThis.__ffConfig = ${JSON.stringify(config, null, 2)};\n`));
}

function writeDir(outDir, files) {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [name, data] of files) {
    const target = path.join(outDir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

export async function build(opts = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { files, extensionId: crxId } = await loadSource(opts);

  for (const name of [...files.keys()]) {
    if (name.startsWith('_metadata/') || name.startsWith('META-INF/') || /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(name)) {
      files.delete(name);
    }
  }
  if ([...files.keys()].some((n) => n.startsWith('ff/'))) {
    throw new Error('Die Extension enthält bereits einen Ordner "ff/" – das kollidiert mit den Firefox-Shims.');
  }
  const rawManifest = files.get('manifest.json');
  if (!rawManifest) throw new Error('manifest.json fehlt im Paket.');
  const chromeManifest = JSON.parse(stripJsonComments(rawManifest.toString('utf8').replace(/^﻿/, '')));

  const chromeExtensionId =
    crxId || manifestKeyToExtensionId(chromeManifest.key) || opts.id || DEFAULT_CHROME_EXTENSION_ID;

  const { manifest, config, report } = transformManifest(chromeManifest, {
    geckoId: opts.geckoId,
    chromeExtensionId,
    versionSuffix: opts.versionSuffix,
    keepName: opts.keepName,
    portVersion: pkg.version,
  });
  console.log(`• ${chromeManifest.name} ${chromeManifest.version} (Chrome-ID ${chromeExtensionId})`);

  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  config.pages = [...files.keys()].filter((n) => n.endsWith('.html')).sort();

  // Mozilla verlangt quadratische Icons (das Original-Icon ist es nicht immer).
  const iconPaths = new Set();
  const collectIcons = (icon) => {
    if (typeof icon === 'string') iconPaths.add(icon.replace(/^\//, ''));
    else if (icon && typeof icon === 'object') Object.values(icon).forEach(collectIcons);
  };
  collectIcons(manifest.icons);
  collectIcons(manifest.action && manifest.action.default_icon);
  collectIcons(manifest.sidebar_action && manifest.sidebar_action.default_icon);
  for (const iconPath of iconPaths) {
    const data = files.get(iconPath);
    const fixed = data && iconPath.endsWith('.png') ? squarePng(data) : null;
    if (fixed) {
      files.set(iconPath, fixed);
      console.log(`  Icon ${iconPath} quadratisch zugeschnitten.`);
    }
  }

  let pages = 0;
  for (const [name, data] of files) {
    if (name.endsWith('.html')) {
      files.set(name, Buffer.from(injectShims(data.toString('utf8'), PAGE_SHIMS)));
      pages++;
    }
  }
  addShimFiles(files, config);

  const outDir = path.resolve(opts.out || path.join(ROOT, 'dist'));
  const extDir = path.join(outDir, 'extension');
  writeDir(extDir, files);
  console.log(`• Entpacktes Add-on: ${extDir}`);

  let xpiPath = null;
  if (!opts.noXpi) {
    xpiPath = path.join(outDir, `claude-firefox-${manifest.version}.xpi`);
    fs.writeFileSync(xpiPath, writeZip(files));
    console.log(`• XPI-Datei:        ${xpiPath}`);
  }

  console.log(`  ${pages} HTML-Seiten angepasst, ${files.size} Dateien insgesamt.`);
  if (report.removedPermissions.length) {
    console.log(`  Entfernte Chrome-Berechtigungen: ${report.removedPermissions.join(', ')}`);
  }
  if (report.removedKeys.length) console.log(`  Entfernte Manifest-Felder: ${report.removedKeys.join(', ')}`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  for (const n of report.notes) console.log(`  ℹ ${n}`);

  return { outDir, extDir, xpiPath, manifest, config, report };
}

async function main() {
  const { values } = parseArgs({
    options: {
      crx: { type: 'string' },
      dir: { type: 'string' },
      id: { type: 'string' },
      out: { type: 'string' },
      'gecko-id': { type: 'string' },
      'version-suffix': { type: 'string' },
      'keep-name': { type: 'boolean' },
      'no-xpi': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values['version-suffix'] && !/^\d+$/.test(values['version-suffix'])) {
    throw new Error('--version-suffix muss eine Zahl sein.');
  }
  await build({
    crx: values.crx,
    dir: values.dir,
    id: values.id,
    out: values.out,
    geckoId: values['gecko-id'],
    versionSuffix: values['version-suffix'],
    keepName: values['keep-name'],
    noXpi: values['no-xpi'],
  });
  console.log('\nFertig. Installation in Firefox: siehe README.md, Abschnitt "Installation".');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nFehler: ${err.message}`);
    process.exitCode = 1;
  });
}
