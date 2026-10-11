// Minimaler ZIP-Leser/-Schreiber ohne externe Abhängigkeiten.
// Reicht für Chrome-Extension-Pakete (CRX enthält ein normales ZIP) und für das
// Firefox-XPI, das wir am Ende erzeugen.

import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buf) {
  // Der EOCD-Record steht am Ende, gefolgt von einem bis zu 65535 Byte langen Kommentar.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('Kein gültiges ZIP-Archiv (End-of-Central-Directory nicht gefunden).');
}

/**
 * Liest ein ZIP-Archiv und liefert alle Dateien (Ordner werden übersprungen).
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64-Archive werden nicht unterstützt.');
  }
  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`Beschädigtes ZIP (Central Directory bei ${p}).`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`Verschlüsselte ZIP-Einträge werden nicht unterstützt: ${name}`);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`Beschädigtes ZIP (Local Header für ${name}).`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unbekannte ZIP-Kompression ${method} bei ${name}.`);
    if (data.length !== size) throw new Error(`Größe stimmt nicht bei ${name}.`);
    files.set(normalizeEntryName(name), data);
  }
  return files;
}

export function normalizeEntryName(name) {
  const n = name.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (n.split('/').some((part) => part === '..')) throw new Error(`Unsicherer Pfad im Archiv: ${name}`);
  return n;
}

// Fester Zeitstempel (2024-01-01 00:00), damit Builds reproduzierbar sind.
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/**
 * Erzeugt ein ZIP-Archiv.
 * @param {Map<string, Buffer>} files
 * @returns {Buffer}
 */
export function writeZip(files) {
  const names = [...files.keys()].sort((a, b) => {
    // manifest.json zuerst – nicht nötig, aber üblich und hilft beim Debuggen.
    if (a === 'manifest.json') return -1;
    if (b === 'manifest.json') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const data = files.get(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    let method = 8;
    let body = zlib.deflateRawSync(data, { level: 9 });
    if (body.length >= data.length) {
      method = 0;
      body = data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
