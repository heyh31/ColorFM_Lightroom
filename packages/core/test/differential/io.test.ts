/**
 * Differential tests for `io/`: thumbnail sampling, preview sizing, the TIFF
 * transform and its metadata-preserving copy path.
 */

import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { decodePng, encodePng16 } from "../../src/io/codec/png.js";
import { encodeJpeg } from "../../src/io/codec/jpeg.js";
import { TiffReader } from "../../src/io/codec/tiff.js";
import {
  axis,
  fitWithin,
  isTiffFile,
  preview,
  savePng16,
  sourceDimensions,
  thumbnail,
  thumbnailAny,
} from "../../src/io/thumb.js";
import { thumbOf } from "../../src/infer/index.js";
import { applyDirect, applyLutWithCancelStrength } from "../../src/pipeline.js";
import { apply, applyInPlaceStrength, bake, cube } from "../../src/lut/index.js";
import { paramsFromSlice } from "../../src/params.js";
import { editableLayout, NEVER_CANCELED, prepareCopy, runRows, transform } from "../../src/io/tiff.js";
import {
  bitsOfAll,
  cleanupScratch,
  deterministicParams,
  firstDifference,
  maxAbsDifference,
  readBytes,
  reference,
  scratch,
  SKIP_WITHOUT_REFERENCE,
} from "./helpers.js";

afterAll(cleanupScratch);

/** Bit patterns of a decoded TIFF's samples, at native size. */
function tiffSamples(path: string): Uint16Array {
  const reader = TiffReader.open(path);
  try {
    const { width, height, chunkCount } = reader.info;
    const out = new Uint16Array(width * height * 3);
    let at = 0;
    for (let index = 0; index < chunkCount; index += 1) {
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
  it("fits a frame inside a square without cropping", async () => {
    expect(fitWithin(4000, 3000, 1280)).toEqual([1280, 960]);
    expect(fitWithin(3000, 4000, 1280)).toEqual([960, 1280]);
    expect(fitWithin(100, 80, 1280)).toEqual([100, 80]);
    expect(fitWithin(1, 4000, 1000)).toEqual([1, 1000]);
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)("fixtures", () => {
  const dir = scratch("fixtures");
  const tiffRamp = join(dir, "ramp.tiff");
  const tiffWide = join(dir, "wide.tiff");
  const tiffLzw = join(dir, "lzw.tiff");

  it("creates the source files", async () => {
    reference("fixture", { path: tiffRamp, width: 37, height: 23, kind: "ramp" });
    reference("fixture", { path: tiffWide, width: 64, height: 48, kind: "wide" });
    reference("fixture", { path: tiffLzw, width: 31, height: 17, kind: "random", compression: "lzw" });
    expect(TiffReader.open(tiffRamp).info.width).toBe(37);
  });

  it("decodes our writer exactly as the reference does", async () => {
    // Round trip through both readers: the reference writes, we read, and the
    // reference re-reads the same file for comparison.
    const expected = reference<{ ok: boolean; bits: string[] }>("raw_pixels", {
      path: tiffWide,
      width: 64,
      height: 48,
    });
    expect(expected.ok).toBe(true);
    const samples = tiffSamples(tiffWide);
    expect(bitsOfAll(Array.from(samples, (value) => Math.fround(value / 65535)))).toEqual(
      expected.bits.filter((_, index) => index % 3 !== -1),
    );
  });

  it("matches the reference on thumbnails of an uncompressed TIFF", async () => {
    for (const side of [8, 16, 64, 256]) {
      const expected = reference<{ ok: boolean; width: number; height: number; bits: string[] }>("thumb", {
        src: tiffRamp,
        side,
      });
      const thumb = thumbnail(tiffRamp, side);
      expect(thumb.width).toBe(expected.width);
      expect(firstDifference(expected.bits, bitsOfAll(thumb.pixels))).toBeUndefined();
    }
  });

  it("matches the reference on compressed sources", async () => {
    for (const side of [8, 32]) {
      const expected = reference<{ ok: boolean; bits: string[] }>("thumb", { src: tiffLzw, side });
      expect(expected.ok).toBe(true);
      const thumb = await thumbnailAny(tiffLzw, side);
      expect(firstDifference(expected.bits, bitsOfAll(thumb.pixels))).toBeUndefined();
    }
  });

  it("reads rows in any order when a file has several strips", async () => {
    // Upscaling a multi-strip file makes the sampler ask for a row it has
    // already passed: row 5 after row 6. The reader has to go back for it.
    const multi = join(dir, "strips-8.tiff");
    const single = join(dir, "strips-1.tiff");
    reference("fixture", { path: multi, width: 64, height: 48, kind: "wide", rows_per_strip: 6 });
    reference("fixture", { path: single, width: 64, height: 48, kind: "wide" });

    const fromStrips = thumbnail(multi, 256);
    const fromOneStrip = thumbnail(single, 256);
    expect(TiffReader.open(multi).info.chunkCount).toBe(8);

    // Strip layout must not change a single sample.
    expect(firstDifference(bitsOfAll(fromOneStrip.pixels), bitsOfAll(fromStrips.pixels))).toBeUndefined();

    // ...and the result must match resampling the same samples by hand.
    const samples = tiffSamples(multi);
    const expected = new Float32Array(256 * 256 * 3);
    const toUnit = (value: number): number => Math.fround(value / 65535);
    for (let oy = 0; oy < 256; oy += 1) {
      const [y0, y1, fy] = axis(oy, 256, 48);
      for (let ox = 0; ox < 256; ox += 1) {
        const [x0, x1, fx] = axis(ox, 256, 64);
        for (let k = 0; k < 3; k += 1) {
          const a = toUnit(samples[(y0 * 64 + x0) * 3 + k]);
          const b = toUnit(samples[(y0 * 64 + x1) * 3 + k]);
          const c = toUnit(samples[(y1 * 64 + x0) * 3 + k]);
          const d = toUnit(samples[(y1 * 64 + x1) * 3 + k]);
          const top = Math.fround(a + Math.fround(Math.fround(b - a) * fx));
          const bottom = Math.fround(c + Math.fround(Math.fround(d - c) * fx));
          expected[(oy * 256 + ox) * 3 + k] = Math.fround(top + Math.fround(Math.fround(bottom - top) * fy));
        }
      }
    }
    expect(firstDifference(bitsOfAll(expected), bitsOfAll(fromStrips.pixels))).toBeUndefined();
  });

  it("matches the reference on previews", async () => {
    for (const maxEdge of [12, 32, 128]) {
      const expected = reference<{ ok: boolean; width: number; height: number; bits: string[] }>("preview", {
        src: tiffRamp,
        max_edge: maxEdge,
      });
      const result = await preview(tiffRamp, maxEdge);
      expect(result.width).toBe(expected.width);
      expect(result.height).toBe(expected.height);
      expect(firstDifference(expected.bits, bitsOfAll(result.pixels))).toBeUndefined();
    }
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)("PNG and JPEG references", () => {
  const dir = scratch("references");
  const png = join(dir, "ref.png");
  const jpg = join(dir, "ref.jpg");

  it("matches the reference on a 16-bit PNG", async () => {
    const width = 24;
    const height = 18;
    const samples = new Uint16Array(width * height * 3);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (i * 6553) % 65536;
    writeFileSync(png, await encodePng16(width, height, samples));

    const expected = reference<{ ok: boolean; bits: string[] }>("thumb", { src: png, side: 8 });
    expect(expected.ok).toBe(true);
    const thumb = await thumbnailAny(png, 8);
    expect(firstDifference(expected.bits, bitsOfAll(thumb.pixels))).toBeUndefined();
  });

  it("agrees with the reference on a JPEG reference to within one 8-bit step", async () => {
    const width = 40;
    const height = 30;
    const pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 3;
        pixels[at] = x / width;
        pixels[at + 1] = y / height;
        pixels[at + 2] = 0.5;
      }
    }
    writeFileSync(jpg, await encodeJpeg(pixels, width, height, 95));

    const expected = reference<{ ok: boolean; bits: string[] }>("thumb", { src: jpg, side: 16 });
    expect(expected.ok).toBe(true);
    const thumb = await thumbnailAny(jpg, 16);
    // Two independent JPEG decoders: the inverse DCT may round differently, so
    // compare in 8-bit units rather than bit for bit. libjpeg-turbo lands within
    // half a step of the reference (measured 0.52/255); the bound stays at one.
    const worst = maxAbsDifference(expected.bits, bitsOfAll(thumb.pixels));
    expect(worst).toBeLessThanOrEqual(1 / 255);

    // Preview sizing reads the frame header rather than the pixels; a stretched
    // and a fitted resize must agree on the output geometry.
    const view = await preview(jpg, 20);
    expect(fitWithin(width, height, 20)).toEqual([20, 15]);
    expect([view.width, view.height]).toEqual([20, 15]);
    const sized = await sourceDimensions(jpg);
    expect([sized.width, sized.height]).toEqual([width, height]);
  });

  it("narrows a 16-bit PNG once, not twice", async () => {
    // libvips will happily round a 16-bit source down to 8 bits for us; if that
    // happens and the decoder narrows again, every sample collapses towards 0.
    const width = 4;
    const height = 2;
    const samples = new Uint16Array(width * height * 3);
    for (let i = 0; i < samples.length; i += 3) {
      samples[i] = 20000;
      samples[i + 1] = 40000;
      samples[i + 2] = 18000;
    }
    const file = join(dir, "wide.png");
    writeFileSync(file, await encodePng16(width, height, samples));

    const decoded = await decodePng(file);
    expect(Array.from(decoded.data.slice(0, 3))).toEqual([
      Math.floor((20000 + 128) / 257),
      Math.floor((40000 + 128) / 257),
      Math.floor((18000 + 128) / 257),
    ]);
  });

  it("decodes by content, not by extension", async () => {
    // Nothing downstream declares a format any more: the decoder sniffs the
    // bytes, so a JPEG named .png (or a PNG named .tif) decodes the same as the
    // correctly named file. Only TIFF is routed specially, and that is decided
    // from the magic bytes too.
    const width = 16;
    const height = 12;
    const pixels = new Float32Array(width * height * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = (i % 255) / 255;
      pixels[i + 1] = 0.5;
      pixels[i + 2] = 0.25;
    }

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
    // The reference image may arrive as WebP or HEIC; the decoder has to land on
    // the same pixels a lossless PNG of the same frame would. Both files are
    // 8-bit so this compares the formats, not the 16→8 rounding.
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

describe.skipIf(SKIP_WITHOUT_REFERENCE)("TIFF transform", () => {
  const dir = scratch("transform");
  const src = join(dir, "src.tiff");
  const params = deterministicParams(101, 37);

  it("produces the same pixels as the reference on the copy path", async () => {
    reference("fixture", { path: src, width: 40, height: 30, kind: "wide" });
    const mine = join(dir, "mine.tiff");
    const theirs = join(dir, "theirs.tiff");
    const table = bake(paramsFromSlice(params), 17);

    const info = applyLutWithCancelStrength(src, mine, table, 0.8, NEVER_CANCELED);
    expect(info.metadataPreserved).toBe(true);

    const expected = reference<{
      ok: boolean;
      info: { width: number; height: number; metadata_preserved: boolean };
    }>("transform", { src, dst: theirs, params, size: 17, strength: 0.8 });
    expect(expected.ok).toBe(true);
    expect(expected.info.metadata_preserved).toBe(true);
    expect(info.width).toBe(expected.info.width);

    const mineBits = bitsOfAll(Array.from(tiffSamples(mine), (value) => Math.fround(value / 65535)));
    const theirBits = bitsOfAll(Array.from(tiffSamples(theirs), (value) => Math.fround(value / 65535)));
    expect(firstDifference(theirBits, mineBits)).toBeUndefined();
  });

  it("produces the same pixels on the re-encode path", async () => {
    const lzw = join(dir, "lzw-src.tiff");
    reference("fixture", { path: lzw, width: 33, height: 21, kind: "random", compression: "lzw" });
    const mine = join(dir, "mine-reencoded.tiff");
    const theirs = join(dir, "theirs-reencoded.tiff");
    const table = bake(paramsFromSlice(params), 9);

    const info = applyLutWithCancelStrength(lzw, mine, table, 1, NEVER_CANCELED);
    expect(info.metadataPreserved).toBe(false);

    const expected = reference<{ ok: boolean; info: { metadata_preserved: boolean } }>("transform", {
      src: lzw,
      dst: theirs,
      params,
      size: 9,
      strength: 1,
    });
    expect(expected.ok).toBe(true);
    expect(expected.info.metadata_preserved).toBe(false);

    // The reference must be able to read what we wrote.
    const reread = reference<{ ok: boolean; bits: string[] }>("raw_pixels", {
      path: mine,
      width: 33,
      height: 21,
    });
    expect(reread.ok).toBe(true);
    const mineBits = bitsOfAll(Array.from(tiffSamples(mine), (value) => Math.fround(value / 65535)));
    expect(firstDifference(reread.bits, mineBits)).toBeUndefined();

    const theirBits = bitsOfAll(Array.from(tiffSamples(theirs), (value) => Math.fround(value / 65535)));
    expect(firstDifference(theirBits, mineBits)).toBeUndefined();
  });

  it("matches the direct MLP path", async () => {
    const direct = join(dir, "direct-mine.tiff");
    const directTheirs = join(dir, "direct-theirs.tiff");
    const flat = paramsFromSlice(params);

    applyDirect(src, direct, flat);
    const expected = reference<{ ok: boolean }>("transform", {
      src,
      dst: directTheirs,
      params,
      size: 9,
      direct: true,
    });
    expect(expected.ok).toBe(true);

    const mineBits = bitsOfAll(Array.from(tiffSamples(direct), (value) => Math.fround(value / 65535)));
    const theirBits = bitsOfAll(Array.from(tiffSamples(directTheirs), (value) => Math.fround(value / 65535)));
    expect(firstDifference(theirBits, mineBits)).toBeUndefined();
  });

  it("writes a multi-block frame byte for byte like the reference", async () => {
    // 1200x800 is 5.7 MB of pixels and 13 blocks of 64 rows: this is the path
    // where the strip loop, the seek arithmetic and the 16-bit quantisation all
    // have to line up over a real buffer.
    const big = join(dir, "big.tiff");
    reference("fixture", { path: big, width: 1200, height: 800, kind: "wide" });
    const mine = join(dir, "big-mine.tiff");
    const theirs = join(dir, "big-theirs.tiff");
    const table = bake(paramsFromSlice(params), 33);

    applyLutWithCancelStrength(big, mine, table, 0.8, NEVER_CANCELED);
    const expected = reference<{ ok: boolean }>("transform", {
      src: big,
      dst: theirs,
      params,
      size: 33,
      strength: 0.8,
    });
    expect(expected.ok).toBe(true);

    // Compared by hand rather than with a deep-equal: element-wise comparison
    // of six million samples is far faster than building a diff.
    const a = readBytes(mine);
    const b = readBytes(theirs);
    expect(a.length).toBe(b.length);
    let first = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        first = i;
        break;
      }
    }
    expect(first).toBe(-1);
  });

  /**
   * Applies the same job one band at a time and compares the bytes.
   *
   * Core only reports the layout; the split is the caller's (the engine has its
   * own `planBands`). Four equal runs are enough to prove the primitive.
   */
  function bandedMatchesSequential(source: string, tag: string): void {
    const layout = editableLayout(source);
    expect(layout).toBeDefined();
    expect(layout!.height).toBe(360);

    const rows = layout!.height;
    const per = Math.ceil(rows / 4);
    const bands = Array.from({ length: Math.ceil(rows / per) }, (_, index) => ({
      firstRow: index * per,
      rows: Math.min(per, rows - index * per),
    }));

    const single = join(dir, `bands-${tag}-single.tiff`);
    const banded = join(dir, `bands-${tag}-parallel.tiff`);
    const params = deterministicParams(101, 31);
    const table = bake(paramsFromSlice(params), 17);

    applyLutWithCancelStrength(source, single, table, 0.7, NEVER_CANCELED);

    // Same work, but applied band by band — what the worker fan-out does,
    // without the threads.
    prepareCopy(source, banded);
    for (const band of bands) {
      runRows(source, banded, 64, band, NEVER_CANCELED, (pixels) => {
        applyInPlaceStrength(table, pixels, 0.7);
      });
    }

    const a = readBytes(single);
    const b = readBytes(banded);
    expect(a.length).toBe(b.length);
    let first = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        first = i;
        break;
      }
    }
    expect(first).toBe(-1);
  }

  it("writes the same bytes band by band as in one pass", async () => {
    const source = join(dir, "bands-src.tiff");
    reference("fixture", { path: source, width: 240, height: 360, kind: "wide", rows_per_strip: 30 });
    bandedMatchesSequential(source, "strips");
  });

  it("splits a single-strip export, which is what Lightroom writes", async () => {
    // One strip for the whole frame: the case where splitting by strip index
    // would hand the entire image to a single thread.
    const source = join(dir, "single-strip.tiff");
    reference("fixture", {
      path: source,
      width: 240,
      height: 360,
      kind: "wide",
      rows_per_strip: 360,
    });
    expect(TiffReader.open(source).info.chunkCount).toBe(1);
    bandedMatchesSequential(source, "onestrip");
  });

  it("refuses to write over the source", async () => {
    expect(() => transform(src, src, 8, () => {})).toThrow(/same file/);
  });

  it("writes a thumbnail PNG the reference can read back", async () => {
    const pngPath = join(dir, "thumb.png");
    const pixels = new Float32Array(4 * 4 * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i % 17) / 16;
    await savePng16(thumbOf(4, 4, pixels), pngPath);
    const expected = reference<{ ok: boolean; bits: string[] }>("thumb", { src: pngPath, side: 4 });
    // A 16-bit PNG is narrowed to 8 bits by the reference reader; the same
    // rounding must apply on our side.
    expect(expected.ok).toBe(true);
    const ours = await thumbnailAny(pngPath, 4);
    expect(firstDifference(expected.bits, bitsOfAll(ours.pixels))).toBeUndefined();
  });
});

describe("cube output of a baked table survives a resample", () => {
  it("stays finite and in range", async () => {
    const table = bake(paramsFromSlice(deterministicParams()), 9);
    const text = cube.write(table, "smoke");
    expect(text.split("\n").length).toBeGreaterThan(100);
    const back = cube.read(text);
    const out = apply(back, [0.4, 0.6, 0.2]);
    for (const channel of out) expect(Number.isFinite(channel)).toBe(true);
  });
});
