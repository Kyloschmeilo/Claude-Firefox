// Lädt die aktuelle Version einer Extension aus dem Chrome Web Store.
// Das ist dieselbe öffentliche Update-Schnittstelle, die Chrome selbst benutzt.

export function crxDownloadUrl(extensionId, prodVersion = '140.0.0.0') {
  const x = encodeURIComponent(`id=${extensionId}&uc`);
  return (
    'https://clients2.google.com/service/update2/crx' +
    `?response=redirect&prodversion=${prodVersion}&acceptformat=crx2,crx3&x=${x}`
  );
}

export async function downloadCrx(extensionId, { prodVersion } = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18 oder neuer wird benötigt (fetch fehlt).');
  const url = crxDownloadUrl(extensionId, prodVersion);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 claude-firefox-port' } });
  } catch (err) {
    throw new Error(`Download fehlgeschlagen (${err.cause?.code || err.message}). Internetverbindung prüfen.`);
  }
  if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error('Leere Antwort vom Chrome Web Store. Ist die Extension-ID richtig?');
  }
  return buf;
}
