// Macht PNG-Icons quadratisch (Mozillas Prüfung verlangt quadratische Icons).
// Unterstützt 8-Bit-PNGs ohne Interlacing; alles andere bleibt unverändert.

import zlib from 'node:zlib';
import { crc32 } from './zip.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunks(buf) {
  const list = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    list.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return list;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Liefert ein quadratisches PNG (zugeschnitten) oder null, wenn nichts zu tun/möglich ist. */
export function squarePng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  const list = chunks(buf);
  const ihdr = list.find((c) => c.type === 'IHDR');
  if (!ihdr) return null;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (width === height) return null;
  if (depth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) return null;

  const bpp = CHANNELS[colorType];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  if (raw.length < height * (stride + 1)) return null;

  // Filter rückgängig machen.
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[x] = v & 0xff;
    }
  }

  // Mittig auf die kleinere Kantenlänge zuschneiden.
  const size = Math.min(width, height);
  const offX = Math.floor((width - size) / 2);
  const offY = Math.floor((height - size) / 2);
  const outStride = size * bpp;
  const filtered = Buffer.alloc(size * (outStride + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(filtered, y * (outStride + 1) + 1, (y + offY) * stride + offX * bpp, (y + offY) * stride + (offX + size) * bpp);
  }

  const newIhdr = Buffer.from(ihdr.data);
  newIhdr.writeUInt32BE(size, 0);
  newIhdr.writeUInt32BE(size, 4);
  const keep = list.filter((c) => ['PLTE', 'tRNS', 'gAMA', 'sRGB', 'cHRM', 'iCCP'].includes(c.type));
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', newIhdr),
    ...keep.map((c) => chunk(c.type, c.data)),
    chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
