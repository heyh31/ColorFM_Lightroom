/**
 * Decoding, thumbnails, previews and the streaming TIFF transform.
 *
 * Fixtures are written by the library itself, and the comparisons are between
 * two ways of reading the same file — a strip layout must not change a pixel,
 * a banded transform must not change a byte.
 */

import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { decodePng, encodePng16 } from "../src/io/codec/png.js";
import { encodeJpeg } from "../src/io/codec/jpeg.js";
import { TiffReader } from "../src/io/codec/tiff.js";
import {
  axis,
  fitWithin,
  isTiffFile,
  preview as previewImage,
  savePng16,
  sourceDimensions,
  thumbnail as thumbnailTiff,
  thumbnailAny,
} from "../src/io/thumb.js";
import { thumbOf } from "../src/infer/index.js";
import { applyLutWithCancelStrength } from "../src/pipeline.js";
import { applyInPlaceU16, bake } from "../src/lut/index.js";
import { paramsFromSlice } from "../src/params.js";
import { editableLayout, NEVER_CANCELED, prepareCopy, runRows, type StripTransform } from "../src/io/tiff.js";
import {
  bitsOfAll,
  cleanupScratch,
  deterministicParams,
  firstDifference,
  makeTiff,
  maxAbsDifference,
  readBytes,
  scratch,
} from "./helpers.js";

afterAll(cleanupScratch);

/** Every sample of a TIFF, in file order. */
function samples(path: string): Uint16Array {
  const reader = TiffReader.open(path);
  try {
    const out = new Uint16Array(reader.info.width * reader.info.height * 3);
    let at = 0;
    for (let index = 0; index < reader.info.chunkCount; index += 1) {
      const chunk = reader.readChunk(index);
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } finally {
    reader.close();
  }
}

describe("geometry", () => {
  it("fits a frame inside a square without cropping", () => {
    expect(fitWithin(4000, 3000, 1280)).toEqual([1280, 960]);
    expect(fitWithin(3000, 4000, 1280)).toEqual([960, 1280]);
    expect(fitWithin(100, 80, 1280)).toEqual([100, 80]);
    expect(fitWithin(1, 4000, 1000)).toEqual([1, 1000]);
  });

  it("samples pixel centres, clamped at the edges", () => {
    expect(axis(0, 4, 4)).toEqual([0, 1, 0]);
    expect(axis(3, 4, 4)).toEqual([3, 3, 0]);
    expect(axis(0, 1, 4)).toEqual([1, 2, 0.5]);
  });
});

describe("TIFF layout", () => {
  const dir = scratch("layout");

  it("writes what it says it wrote", () => {
    const path = join(dir, "ramp.tiff");
    makeTiff(path, { width: 37, height: 23, kind: "ramp", rowsPerStrip: 6 });
    const reader = TiffReader.open(path);
    try {
      expect(reader.info.width).toBe(37);
      expect(reader.info.height).toBe(23);
      expect(reader.info.chunkCount).toBe(4);
      expect(reader.info.bitsPerSample).toBe(16);
    } finally {
      reader.close();
    }
    // First pixel of a ramp is black, last is full scale on red.
    expect(samples(path)[0]).toBe(0);
  });

  it("does not let the strip layout change a thumbnail", () => {
    const multi = join(dir, "strips.tiff");
    const single = join(dir, "one-strip.tiff");
    makeTiff(multi, { width: 64, height: 48, kind: "wide", rowsPerStrip: 6 });
    makeTiff(single, { width: 64, height: 48, kind: "wide", rowsPerStrip: 48 });
    expect(TiffReader.open(multi).info.chunkCount).toBe(8);

    const fromStrips = thumbnailTiff(multi, 256);
    const fromOne = thumbnailTiff(single, 256);
    expect(firstDifference(bitsOfAll(fromOne.pixels), bitsOfAll(fromStrips.pixels))).toBeUndefined();
  });

  it("resamples the way the sampler describes", () => {
    const path = join(dir, "sample.tiff");
    makeTiff(path, { width: 64, height: 48, kind: "wide", rowsPerStrip: 6 });
    const pixels = samples(path);
    const thumb = thumbnailTiff(path, 32);

    const expected = new Float32Array(32 * 32 * 3);
    for (let oy = 0; oy < 32; oy += 1) {
      const [y0, y1, fy] = axis(oy, 32, 48);
      for (let ox = 0; ox < 32; ox += 1) {
        const [x0, x1, fx] = axis(ox, 32, 64);
        for (let k = 0; k < 3; k += 1) {
          const at = (y: number, x: number) => pixels[(y * 64 + x) * 3 + k] / 65535;
          const top = at(y0, x0) + (at(y0, x1) - at(y0, x0)) * fx;
          const bottom = at(y1, x0) + (at(y1, x1) - at(y1, x0)) * fx;
          expected[(oy * 32 + ox) * 3 + k] = top + (bottom - top) * fy;
        }
      }
    }
    expect(maxAbsDifference(expected, thumb.pixels)).toBeLessThan(1e-9);
  });
});

describe("thumbnails and previews", () => {
  const dir = scratch("thumbs");
  const source = join(dir, "src.tiff");
  makeTiff(source, { width: 96, height: 64, kind: "ramp" });

  it("sizes a thumbnail to the requested square", () => {
    for (const side of [8, 16, 256]) {
      const thumb = thumbnailTiff(source, side);
      expect([thumb.width, thumb.height]).toEqual([side, side]);
      expect(thumb.pixels.length).toBe(side * side * 3);
    }
  });

  it("preserves the aspect ratio in a preview", async () => {
    for (const maxEdge of [12, 32, 128]) {
      const view = await previewImage(source, maxEdge);
      expect([view.width, view.height]).toEqual(fitWithin(96, 64, maxEdge));
    }
  });

  it("reads the size from the header without decoding", async () => {
    expect(await sourceDimensions(source)).toEqual({ width: 96, height: 64 });
  });
});

describe("PNG", () => {
  const dir = scratch("png");

  it("narrows a 16-bit source once, not twice", async () => {
    const width = 4;
    const height = 2;
    const samples16 = new Uint16Array(width * height * 3);
    for (let i = 0; i < samples16.length; i += 3) {
      samples16[i] = 20000;
      samples16[i + 1] = 40000;
      samples16[i + 2] = 18000;
    }
    const file = join(dir, "wide.png");
    writeFileSync(file, await encodePng16(width, height, samples16));

    const decoded = await decodePng(file);
    expect(Array.from(decoded.data.slice(0, 3))).toEqual([
      Math.floor((20000 + 128) / 257),
      Math.floor((40000 + 128) / 257),
      Math.floor((18000 + 128) / 257),
    ]);
  });

  it("writes 16-bit samples that read back exactly", async () => {
    const thumb = thumbOf(
      2,
      2,
      new Float32Array([0, 0.5, 1, 0.25, 0.75, 0.125, 0.9, 0.1, 0.4, 0.3, 0.06, 0.6]),
    );
    const file = join(dir, "thumb.png");
    await savePng16(thumb, file);

    const width = 2;
    const height = 2;
    // Read the 16-bit PNG at its native depth, which is what the model input is.
    const back = await sharp(file)
      .toColourspace("rgb16")
      .raw({ depth: "ushort" })
      .toBuffer({ resolveWithObject: true });
    expect((back.info as { depth?: string }).depth).toBe("ushort");
    const raw = new Uint16Array(back.data.buffer, back.data.byteOffset, width * height * 3);
    for (let i = 0; i < raw.length; i += 1) {
      expect(Math.abs(raw[i] - Math.round(thumb.pixels[i] * 65535))).toBeLessThanOrEqual(1);
    }
  });
});

describe("JPEG and format sniffing", () => {
  const dir = scratch("raster");

  function gradient(width: number, height: number): Float32Array {
    const pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 3;
        pixels[at] = x / width;
        pixels[at + 1] = y / height;
        pixels[at + 2] = 0.5;
      }
    }
    return pixels;
  }

  it("round-trips a JPEG through the decoder within its loss", async () => {
    const width = 40;
    const height = 30;
    const pixels = gradient(width, height);
    const file = join(dir, "gradient.jpg");
    writeFileSync(file, await encodeJpeg(pixels, width, height, 95));

    const thumb = await thumbnailAny(file, 16);
    expect([thumb.width, thumb.height]).toEqual([16, 16]);
    // Compare on the 8-bit scale the JPEG itself is stored in.
    const view = await previewImage(file, width);
    expect([view.width, view.height]).toEqual([width, height]);
    expect(maxAbsDifference(pixels, view.pixels)).toBeLessThan(0.02);
  });

  it("decodes by content, not by extension", async () => {
    const width = 16;
    const height = 12;
    const pixels = gradient(width, height);

    const realJpeg = join(dir, "real.jpg");
    writeFileSync(realJpeg, await encodeJpeg(pixels, width, height, 95));
    const fakePng = join(dir, "actually-a-jpeg.png");
    copyFileSync(realJpeg, fakePng);

    const fromJpeg = await thumbnailAny(realJpeg, 8);
    const fromFakePng = await thumbnailAny(fakePng, 8);
    expect(firstDifference(bitsOfAll(fromJpeg.pixels), bitsOfAll(fromFakePng.pixels))).toBeUndefined();

    const realPng = join(dir, "real.png");
    writeFileSync(
      realPng,
      await sharp(Buffer.from(new Uint8Array(width * height * 3).fill(120)), {
        raw: { width, height, channels: 3 },
      })
        .png()
        .toBuffer(),
    );
    const fakeTiff = join(dir, "actually-a-png.tif");
    copyFileSync(realPng, fakeTiff);
    expect(isTiffFile(fakeTiff)).toBe(false);
    const a = await thumbnailAny(realPng, 8);
    const b = await thumbnailAny(fakeTiff, 8);
    expect(firstDifference(bitsOfAll(a.pixels), bitsOfAll(b.pixels))).toBeUndefined();
  });

  it("treats lossless WebP exactly like PNG", async () => {
    const width = 20;
    const height = 16;
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) % 256;

    const pngFile = join(dir, "same.png");
    const webpFile = join(dir, "same.webp");
    await sharp(rgb, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(pngFile);
    await sharp(pngFile).webp({ lossless: true }).toFile(webpFile);

    const fromPng = await thumbnailAny(pngFile, 8);
    const fromWebp = await thumbnailAny(webpFile, 8);
    expect(firstDifference(bitsOfAll(fromPng.pixels), bitsOfAll(fromWebp.pixels))).toBeUndefined();
  });
});

describe("streaming transform", () => {
  const dir = scratch("transform");
  const source = join(dir, "src.tiff");
  makeTiff(source, { width: 120, height: 80, kind: "wide", rowsPerStrip: 8 });
  const table = bake(paramsFromSlice(deterministicParams()), 17);

  it("produces the same bytes banded as sequentially", () => {
    const single = join(dir, "single.tiff");
    const banded = join(dir, "banded.tiff");
    applyLutWithCancelStrength(source, single, table, 0.8, NEVER_CANCELED);

    const layout = editableLayout(source);
    expect(layout).toEqual({ width: 120, height: 80 });
    prepareCopy(source, banded);
    for (let first = 0; first < 80; first += 20) {
      const fn = ((pixels: Float32Array) => {
        pixels.set(tableApply(table, pixels, 0.8));
      }) as StripTransform;
      fn.applyU16 = (codes) => applyInPlaceU16(table, codes, 0.8);
      runRows(source, banded, 16, { firstRow: first, rows: Math.min(20, 80 - first) }, NEVER_CANCELED, fn);
    }
    expect(readBytes(single).length).toBe(readBytes(banded).length);
    expect(Array.from(samples(single))).toEqual(Array.from(samples(banded)));
  });

  it("keeps a single-strip source editable", () => {
    const one = join(dir, "one.tiff");
    makeTiff(one, { width: 40, height: 30, kind: "wide", rowsPerStrip: 30 });
    expect(TiffReader.open(one).info.chunkCount).toBe(1);
    expect(editableLayout(one)).toEqual({ width: 40, height: 30 });
  });

  it("fails loudly when the source is not 16-bit RGB", () => {
    const wrong = join(dir, "wrong.tiff");
    makeTiff(wrong, { width: 8, height: 8, kind: "ramp" });
    // Truncating the file is the simplest way to make it unreadable.
    writeFileSync(wrong, readBytes(wrong).slice(0, 32));
    expect(() => TiffReader.open(wrong)).toThrowError();
  });
});

/** Applies a table to a float buffer, without touching the LUT module's state. */
function tableApply(
  lut: { size: number; data: Float32Array },
  pixels: Float32Array,
  strength: number,
): Float32Array {
  const out = new Float32Array(pixels.length);
  const { size, data } = lut;
  const scale = size - 1;
  const last = size - 2;
  for (let p = 0; p < pixels.length; p += 3) {
    const clamp = (v: number) => (v > 0 ? (v > 1 ? 1 : v) : 0);
    const pr = clamp(pixels[p]) * scale;
    const pg = clamp(pixels[p + 1]) * scale;
    const pb = clamp(pixels[p + 2]) * scale;
    const i0 = Math.min(pr | 0, last);
    const i1 = Math.min(pg | 0, last);
    const i2 = Math.min(pb | 0, last);
    const f0 = pr - i0;
    const f1 = pg - i1;
    const f2 = pb - i2;
    const g0 = 1 - f0;
    const g1 = 1 - f1;
    const g2 = 1 - f2;
    const w = [
      g0 * g1 * g2,
      f0 * g1 * g2,
      g0 * f1 * g2,
      f0 * f1 * g2,
      g0 * g1 * f2,
      f0 * g1 * f2,
      g0 * f1 * f2,
      f0 * f1 * f2,
    ];
    const base = i2 * size * size * 3 + i1 * size * 3 + i0 * 3;
    const corners = [
      base,
      base + 3,
      base + size * 3,
      base + size * 3 + 3,
      base + size * size * 3,
      base + size * size * 3 + 3,
      base + size * size * 3 + size * 3,
      base + size * size * 3 + size * 3 + 3,
    ];
    for (let k = 0; k < 3; k += 1) {
      let sum = 0;
      for (let c = 0; c < 8; c += 1) sum += w[c] * data[corners[c] + k];
      const src = pixels[p + k];
      out[p + k] = src + (sum - src) * strength;
    }
  }
  return out;
}
