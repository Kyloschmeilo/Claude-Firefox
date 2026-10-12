#!/usr/bin/env node
// End-to-End-Test in echtem Firefox.
//
//   node scripts/build.mjs
//   FIREFOX_BIN=/pfad/zu/firefox GECKODRIVER_BIN=/pfad/zu/geckodriver node test/e2e/run.mjs
//
// Installiert das gebaute Add-on (dist/extension) zusammen mit einer Testseite
// als temporäres Add-on und prüft Klicks, Tippen, Screenshots, Konsole usw.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../../scripts/lib/zip.mjs';
import { Firefox } from './webdriver.mjs';
import { testPages } from './pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const { values } = parseArgs({
  options: {
    ext: { type: 'string', default: path.join(ROOT, 'dist', 'extension') },
    firefox: { type: 'string', default: process.env.FIREFOX_BIN || 'firefox' },
    geckodriver: { type: 'string', default: process.env.GECKODRIVER_BIN || 'geckodriver' },
    headful: { type: 'boolean' },
    timeout: { type: 'string', default: '180' },
  },
});

function readDir(dir) {
  const files = new Map();
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else files.set(r, fs.readFileSync(a));
    }
  };
  walk(dir, '');
  return files;
}

async function main() {
  if (!fs.existsSync(path.join(values.ext, 'manifest.json'))) {
    throw new Error(`Kein gebautes Add-on in ${values.ext}. Zuerst "node scripts/build.mjs" ausführen.`);
  }

  // --- Test-Server -----------------------------------------------------------
  let resolveResults;
  const resultsPromise = new Promise((r) => (resolveResults = r));
  let pages = {};
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/__results' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
        resolveResults(JSON.parse(body));
      });
      return;
    }
    const page = pages[url];
    if (!page) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(page.status || 200, { 'Access-Control-Allow-Origin': '*', ...page.headers });
    res.end(typeof page.body === 'function' ? page.body(req) : page.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  pages = testPages(port);

  // --- Test-Variante des Add-ons ----------------------------------------------
  const files = readDir(values.ext);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  manifest.background.scripts.push('ff-test/bg.js');
  for (const cs of manifest.content_scripts || []) {
    if ((cs.js || []).some((j) => j.startsWith('ff/claude-bridge'))) cs.matches.push('http://127.0.0.1/*');
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const configSrc = files.get('ff/config.js').toString('utf8');
  const config = JSON.parse(configSrc.replace(/^globalThis\.__ffConfig = /, '').replace(/;\s*$/, ''));
  config.externallyConnectable.push('http://127.0.0.1/*');
  files.set('ff/config.js', Buffer.from(`globalThis.__ffConfig = ${JSON.stringify(config)};\n`));

  const modules = [...files.keys()].filter(
    (f) => f.startsWith('assets/') && f.endsWith('.js') && files.get(f).includes('Input.dispatchMouseEvent'),
  );
  for (const name of ['runner.html', 'runner.js', 'bg.js']) {
    files.set(`ff-test/${name}`, fs.readFileSync(path.join(HERE, 'runner', name)));
  }
  files.set('ff-test/config.js', Buffer.from(`globalThis.__ffTest = ${JSON.stringify({ port, modules })};\n`));
  const xpi = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ff-e2e-')), 'test.xpi');
  fs.writeFileSync(xpi, writeZip(files));

  // --- Firefox ---------------------------------------------------------------
  const ff = new Firefox({
    firefoxBin: values.firefox,
    geckodriverBin: values.geckodriver,
    headless: !values.headful,
    prefs: { 'devtools.console.stdout.chrome': true, 'browser.dom.window.dump.enabled': true },
  });
  await ff.start();
  let exitCode = 0;
  try {
    console.log(`Firefox ${ff.capabilities.browserVersion}, Testserver auf Port ${port}`);
    await ff.installAddon(xpi);
    await ff.navigate(`http://127.0.0.1:${port}/target`);
    const timeoutMs = Number(values.timeout) * 1000;
    const report = await Promise.race([
      resultsPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung: keine Testergebnisse')), timeoutMs)),
    ]);
    let failed = 0;
    for (const r of report.results) {
      if (!r.ok) failed++;
      const detail = r.ok ? '' : `\n      ${JSON.stringify(r.detail)?.slice(0, 600)}`;
      console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${detail}`);
    }
    console.log(`\n${report.results.length - failed}/${report.results.length} bestanden`);
    if (failed) exitCode = 1;
  } catch (err) {
    console.error(err.message);
    exitCode = 1;
  } finally {
    const log = ff.driverLog
      .split('\n')
      .filter((l) => (process.env.E2E_FULL_LOG ? true : /moz-extension|Claude-Firefox|JavaScript error|Error/i.test(l)) && !/RemoteSettings|nimbus|services-settings/.test(l));
    if (log.length) {
      console.log('\nFirefox-Konsole (Auszug):');
      for (const l of log.slice(process.env.E2E_FULL_LOG ? -400 : -60)) console.log(`  ${l.slice(0, 400)}`);
    }
    await ff.quit();
    server.close();
  }
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
