/**
 * The TIFF decoder against files another encoder produced.
 *
 * The render path only ever reads uncompressed strips, but the fallback and the
 * thumbnail row reader go through `readChunk`, which handles LZW, Deflate and
 * PackBits plus the horizontal predictor. Those branches are the ones nobody
 * exercises by accident, so they are checked here against files sharp wrote: a
 * decoder that reports the wrong length truncates a strip silently, and the only
 * symptom is a wrong pixel.
 */

import { writeFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { TiffReader } from "../src/io/codec/tiff.js";

import { scratch } from "./helpers.js";

const WIDTH = 97;
const HEIGHT = 43;

/** A frame with both flat and noisy runs, so every compression has work to do. */
function pixels8(): Buffer {
  const buffer = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < buffer.length; i += 1) {
    // Runs of one value give PackBits something to encode; the pattern after
    // them gives it something that must not be collapsed.
    buffer[i] = i % 61 < 20 ? 0x40 : (i * 37 + (i >> 5)) & 0xff;
  }
  return buffer;
}

async function writeTiff(
  name: string,
  compression: "none" | "lzw" | "packbits" | "deflate",
  predictor: "none" | "horizontal",
): Promise<string> {
  const path = scratch("tiff-compression").concat(`/${name}.tiff`);
  const bytes = await sharp(pixels8(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .tiff({ compression, predictor })
    .toBuffer();
  writeFileSync(path, bytes);
  return path;
}

function readAll(path: string): { samples: Uint16Array; compression: number } {
  const reader = TiffReader.open(path);
  try {
    const out = new Uint16Array(WIDTH * HEIGHT * 3);
    let at = 0;
    for (let index = 0; index < reader.info.chunkCount; index += 1) {
      const chunk = reader.readChunk(index);
      out.set(chunk.subarray(0, Math.min(chunk.length, out.length - at)), at);
      at += chunk.length;
    }
    return { samples: out, compression: reader.info.compression };
  } finally {
    reader.close();
  }
}

describe("TIFF decoding of compressed strips", () => {
  const source = pixels8();

  for (const compression of ["none", "lzw", "deflate", "packbits"] as const) {
    it(`round-trips ${compression}`, async () => {
      const path = await writeTiff(compression, compression, "none");
      const { samples } = readAll(path);
      expect(samples).toHaveLength(WIDTH * HEIGHT * 3);

      let wrong = 0;
      for (let i = 0; i < source.length; i += 1) {
        if (samples[i] !== source[i]) wrong += 1;
      }
      expect(wrong).toBe(0);
    });
  }

  it("refuses an 8-bit horizontal predictor instead of guessing", async () => {
    // Undoing the predictor needs the sample width to wrap at 8 or 16 bits;
    // this decoder implements 16 only, and says so rather than returning
    // plausible-looking wrong pixels.
    const path = await writeTiff("lzw-horizontal", "lzw", "horizontal");
    expect(() => readAll(path)).toThrowError(/predictor with 8-bit/);
  });

  it("decodes a flat frame to its full length", async () => {
    // 0x40 everywhere compresses to a few hundred bytes; a decoder that trusts
    // the compressed count would return that many samples and stop.
    const path = scratch("tiff-compression").concat("/flat-packbits.tiff");
    const flat = Buffer.alloc(WIDTH * HEIGHT * 3, 0x40);
    writeFileSync(
      path,
      await sharp(flat, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
        .tiff({ compression: "packbits" })
        .toBuffer(),
    );

    const { samples } = readAll(path);
    expect(samples).toHaveLength(WIDTH * HEIGHT * 3);
    expect(samples.every((value) => value === 0x40)).toBe(true);
  });
});
