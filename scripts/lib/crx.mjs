// CRX-Dateien (Chrome-Extension-Pakete) auspacken.
// CRX2/CRX3 = kleiner Header + ganz normales ZIP. Aus dem Header lesen wir die
// Chrome-Extension-ID, weil claude.ai Nachrichten genau an diese ID adressiert.

import crypto from 'node:crypto';

/** Wandelt 16 Bytes in eine Chrome-Extension-ID um (Hex-Ziffern 0-f -> a-p). */
export function bytesToExtensionId(bytes) {
  return [...Buffer.from(bytes).subarray(0, 16).toString('hex')]
    .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
    .join('');
}

/** Extension-ID aus einem öffentlichen Schlüssel (DER/SPKI) berechnen. */
export function publicKeyToExtensionId(der) {
  return bytesToExtensionId(crypto.createHash('sha256').update(der).digest());
}

/** Extension-ID aus dem "key"-Feld eines Chrome-Manifests (Base64-DER). */
export function manifestKeyToExtensionId(key) {
  if (typeof key !== 'string' || !key.trim()) return null;
  return publicKeyToExtensionId(Buffer.from(key.replace(/\s+/g, ''), 'base64'));
}

// --- Minimaler Protobuf-Leser für den CRX3-Header ---------------------------

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('Protobuf: unerwartetes Ende');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}

function* protoFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      yield { field, wire, value: v };
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      yield { field, wire, value: buf.subarray(pos, end) };
      pos = end;
    } else if (wire === 1) {
      yield { field, wire, value: buf.subarray(pos, pos + 8) };
      pos += 8;
    } else if (wire === 5) {
      yield { field, wire, value: buf.subarray(pos, pos + 4) };
      pos += 4;
    } else {
      throw new Error(`Protobuf: Wire-Type ${wire} nicht unterstützt`);
    }
  }
}

function crx3ExtensionId(header) {
  // CrxFileHeader: Feld 10000 = signed_header_data (SignedData), darin Feld 1 = crx_id (16 Bytes).
  for (const f of protoFields(header)) {
    if (f.field === 10000 && f.wire === 2) {
      for (const g of protoFields(f.value)) {
        if (g.field === 1 && g.wire === 2 && g.value.length === 16) return bytesToExtensionId(g.value);
      }
    }
  }
  // Fallback: erster RSA-Schlüssel (Feld 2 = sha256_with_rsa, darin Feld 1 = public_key).
  for (const f of protoFields(header)) {
    if (f.field === 2 && f.wire === 2) {
      for (const g of protoFields(f.value)) {
        if (g.field === 1 && g.wire === 2) return publicKeyToExtensionId(g.value);
      }
    }
  }
  return null;
}

/**
 * Trennt ein CRX in ZIP-Daten und Extension-ID. Akzeptiert auch reine ZIP-Dateien.
 * @param {Buffer} buf
 * @returns {{ zip: Buffer, extensionId: string|null, format: string }}
 */
export function unpackCrx(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    return { zip: buf, extensionId: null, format: 'zip' };
  }
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') {
    throw new Error('Datei ist weder CRX noch ZIP. (Wurde vielleicht eine HTML-Fehlerseite heruntergeladen?)');
  }
  const version = buf.readUInt32LE(4);
  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    const header = buf.subarray(12, 12 + headerSize);
    return { zip: buf.subarray(12 + headerSize), extensionId: crx3ExtensionId(header), format: 'crx3' };
  }
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const key = buf.subarray(16, 16 + keyLen);
    return {
      zip: buf.subarray(16 + keyLen + sigLen),
      extensionId: publicKeyToExtensionId(key),
      format: 'crx2',
    };
  }
  throw new Error(`Unbekannte CRX-Version ${version}.`);
}
