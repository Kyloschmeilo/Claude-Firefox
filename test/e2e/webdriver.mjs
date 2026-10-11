// Winziger WebDriver-Client für geckodriver (ohne Abhängigkeiten).
// Wird nur für die End-to-End-Tests in echtem Firefox gebraucht.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export class Firefox {
  constructor({ firefoxBin, geckodriverBin, prefs = {}, headless = true, args = [] }) {
    this.firefoxBin = firefoxBin;
    this.geckodriverBin = geckodriverBin;
    this.prefs = prefs;
    this.headless = headless;
    this.args = args;
  }

  async start() {
    this.port = await freePort();
    this.driver = spawn(this.geckodriverBin, ['--port', String(this.port), '--log', 'error'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.driverLog = '';
    this.driver.stdout.on('data', (d) => (this.driverLog += d));
    this.driver.stderr.on('data', (d) => (this.driverLog += d));
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/status`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const res = await this.raw('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: this.firefoxBin,
            args: [...(this.headless ? ['-headless'] : []), ...this.args],
            prefs: this.prefs,
          },
          unhandledPromptBehavior: 'ignore',
        },
      },
    });
    this.sessionId = res.sessionId;
    this.capabilities = res.capabilities;
    return this;
  }

  async raw(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${this.port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (json.value && json.value.error) {
      const err = new Error(`${json.value.error}: ${json.value.message}`);
      err.webdriver = json.value;
      throw err;
    }
    return json.value;
  }

  cmd(method, path, body) {
    return this.raw(method, `/session/${this.sessionId}${path}`, body);
  }

  installAddon(xpiPath, temporary = true) {
    const addon = fs.readFileSync(xpiPath).toString('base64');
    return this.cmd('POST', '/moz/addon/install', { addon, temporary });
  }

  navigate(url) {
    return this.cmd('POST', '/url', { url });
  }

  url() {
    return this.cmd('GET', '/url');
  }

  /** Führt Code als async-Funktion aus; das letzte Argument ist der Callback. */
  execAsync(fnSource, ...args) {
    return this.cmd('POST', '/execute/async', {
      script: `const __done = arguments[arguments.length - 1];
        (async (...args) => (${fnSource})(...args))(...Array.prototype.slice.call(arguments, 0, -1))
          .then((v) => __done({ ok: true, v }), (e) => __done({ ok: false, e: String(e && (e.stack || e.message) || e) }));`,
      args,
    }).then((r) => {
      if (!r.ok) throw new Error(`Script-Fehler: ${r.e}`);
      return r.v;
    });
  }

  setContext(context) {
    return this.cmd('POST', '/moz/context', { context });
  }

  newWindow(type = 'tab') {
    return this.cmd('POST', '/window/new', { type });
  }

  windowHandles() {
    return this.cmd('GET', '/window/handles');
  }

  switchTo(handle) {
    return this.cmd('POST', '/window', { handle });
  }

  async quit() {
    try {
      if (this.sessionId) await this.cmd('DELETE', '');
    } catch {}
    this.driver?.kill();
  }
}
