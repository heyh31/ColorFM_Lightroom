/**
 * 16-bit RGB PNG writing.
 *
 * sharp takes raw samples but ignores `depth`, so a 16-bit buffer comes out as
 * an 8-bit PNG. The model input has to keep its precision, so the writer lives
 * here: zlib for the pixels, a CRC per chunk, filter 0 on every row.
 *
 * Used only for `content-256.png` and `style-256.png`, the exact model inputs
 * kept beside a cached parameter set.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | undefined;

function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 4, "latin1");
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes interleaved RGB samples as a 16-bit, filter-none PNG. */
export function encodePng16(width: number, height: number, samples: Uint16Array): Buffer {
  if (!(width > 0 && height > 0)) throw new RangeError("image must be non-empty");
  const expected = width * height * 3;
  if (samples.length < expected) throw new RangeError(`expected ${expected} samples, got ${samples.length}`);

  const rowBytes = width * 6;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // Filter type 0 ("none"): the encoder is for small images, and a predictor
    // would only complicate the round trip.
    const rowAt = y * (rowBytes + 1);
    raw[rowAt] = 0;
    const sampleAt = y * width * 3;
    for (let i = 0; i < width * 3; i += 1) {
      raw.writeUInt16BE(samples[sampleAt + i], rowAt + 1 + i * 2);
    }
  }

  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16; // bit depth
  header[9] = 2; // color type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
