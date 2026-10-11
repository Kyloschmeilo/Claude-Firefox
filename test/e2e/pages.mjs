// Testseiten für die End-to-End-Tests (werden von einem lokalen HTTP-Server ausgeliefert).

export function testPages(port) {
  const other = `http://localhost:${port}`;
  return {
    '/form': {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><title>Testformular</title>
<style>body{margin:0;font:16px sans-serif} #spacer{height:2000px} #scroller{height:100px;overflow:auto;border:1px solid}
#scroller div{height:600px} input,textarea,button,select{display:block;margin:8px;font-size:16px}</style></head>
<body>
<form id="f"><input id="name" name="name" autocomplete="off"><button id="submit" type="submit">Senden</button></form>
<textarea id="ta"></textarea>
<div id="ce" contenteditable="true" style="width:300px;height:40px;border:1px solid"></div>
<button id="btn">Klick</button>
<label><input type="checkbox" id="cb"> Haken</label>
<select id="sel"><option>eins</option><option>zwei</option><option>drei</option></select>
<a id="blank" href="http://127.0.0.1:${port}/target" target="_blank">Neuer Tab</a>
<button id="logbtn">Log</button>
<button id="fetchbtn">Fetch</button>
<div id="scroller"><div>scroll</div></div>
<iframe id="xf" src="${other}/frame" style="width:300px;height:80px;border:0"></iframe>
<div id="spacer"></div>
<script>
  window.events = { clicks: 0, submits: 0, keydowns: [], inputs: 0, dbl: 0 };
  document.getElementById('btn').addEventListener('click', (e) => { events.clicks++; events.lastClickTrusted = e.isTrusted; events.clickX = e.clientX; });
  document.getElementById('btn').addEventListener('dblclick', () => events.dbl++);
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); events.submits++; events.submitted = document.getElementById('name').value; });
  document.getElementById('name').addEventListener('keydown', (e) => events.keydowns.push(e.key + ':' + e.keyCode));
  document.getElementById('name').addEventListener('input', () => events.inputs++);
  document.getElementById('logbtn').addEventListener('click', () => { console.log('log-click', 123, {a: 1}); console.warn('warn-click'); setTimeout(() => { throw new Error('boom-click'); }, 0); });
  document.getElementById('fetchbtn').addEventListener('click', () => fetch('/api/data?x=1').catch(() => {}));
  console.log('page-loaded-log');
</script>
</body></html>`,
    },
    '/frame': {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><body style="margin:0"><button id="fb" style="width:200px;height:40px">Frame-Knopf</button><input id="fi">
<script>window.frameClicks = 0; document.getElementById('fb').addEventListener('click', () => { window.frameClicks++; document.title = 'frame-clicked-' + window.frameClicks; });</script></body>`,
    },
    '/target': { headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><title>Ziel</title><p>Ziel</p>' },
    '/csp': {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'; object-src 'none'" },
      body: '<!doctype html><title>CSP</title><input id="i">',
    },
    '/oauth-js': {
      headers: { 'Content-Type': 'text/html' },
      body: `<!doctype html><title>OAuth JS</title><script>setTimeout(() => {
  location.href = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html?code=js-code&state=s1';
}, 200);</script>`,
    },
    '/oauth-302': {
      status: 302,
      headers: { Location: 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html?code=http-code&state=s2' },
      body: '',
    },
    '/api/data': { headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' },
    '/external': {
      headers: { 'Content-Type': 'text/html' },
      body: `<!doctype html><title>Extern</title><script>
  window.result = new Promise((resolve) => {
    const start = Date.now();
    const tryIt = () => {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        if (Date.now() - start > 3000) return resolve({ error: 'no chrome.runtime.sendMessage' });
        return setTimeout(tryIt, 50);
      }
      chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn', { type: 'ping' }, (res) => {
        resolve({ res, lastError: chrome.runtime.lastError && chrome.runtime.lastError.message });
      });
    };
    tryIt();
  });
  window.result.then((r) => { document.title = 'external:' + JSON.stringify(r); });
</script>`,
    },
  };
}
