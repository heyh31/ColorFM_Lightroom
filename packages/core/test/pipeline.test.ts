/**
 * The two ways parameters reach pixels.
 *
 * The LUT path is what ships; the direct path evaluates the transform per pixel
 * and is only used as an accuracy check, so the LUT must stay close to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { applyDirectWithCancelStrength, applyLutWithCancelStrength } from "../src/pipeline.js";
import { applyInPlaceU16, bake, type Lut3D } from "../src/lut/index.js";
import { paramsFromSlice } from "../src/params.js";
import { NEVER_CANCELED, runRows, editableLayout, prepareCopy, type StripTransform } from "../src/io/tiff.js";
import { TiffReader } from "../src/io/codec/tiff.js";
import { cleanupScratch, deterministicParams, makeTiff, readBytes, scratch } from "./helpers.js";

afterAll(cleanupScratch);

const params = paramsFromSlice(deterministicParams());
const table: Lut3D = bake(params, 33);

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

describe("LUT pipeline", () => {
  const dir = scratch("pipeline");
  const source = join(dir, "src.tiff");
  makeTiff(source, { width: 48, height: 36, kind: "wide" });

  it("keeps the metadata and writes a byte copy of the source", () => {
    const out = join(dir, "lut.tiff");
    const info = applyLutWithCancelStrength(source, out, table, 0.7, NEVER_CANCELED);
    expect(info.metadataPreserved).toBe(true);
    expect(info.width).toBe(48);
    expect(info.height).toBe(36);
    // A copy keeps every tag, so the two files have the same size.
    expect(readBytes(out).length).toBe(readBytes(source).length);
  });

  it("matches the same work applied band by band", () => {
    const single = join(dir, "single.tiff");
    const banded = join(dir, "banded.tiff");
    applyLutWithCancelStrength(source, single, table, 0.7, NEVER_CANCELED);

    const layout = editableLayout(source);
    expect(layout).toBeDefined();
    prepareCopy(source, banded);
    const rows = layout!.height;
    const per = Math.ceil(rows / 4);
    for (let first = 0; first < rows; first += per) {
      const fn = ((pixels: Float32Array) => {
        const before = Float32Array.from(pixels);
        const graded = floatLookup(table, before);
        for (let i = 0; i < pixels.length; i += 1) {
          pixels[i] = before[i] + (graded[i] - before[i]) * 0.7;
        }
      }) as StripTransform;
      fn.applyU16 = (codes) => applyInPlaceU16(table, codes, 0.7);
      runRows(source, banded, 16, { firstRow: first, rows: Math.min(per, rows - first) }, NEVER_CANCELED, fn);
    }
    expect(Array.from(samples(single))).toEqual(Array.from(samples(banded)));
  });

  it("leaves the pixels untouched at strength 0", () => {
    const out = join(dir, "zero.tiff");
    applyLutWithCancelStrength(source, out, table, 0, NEVER_CANCELED);
    expect(Array.from(samples(out))).toEqual(Array.from(samples(source)));
  });

  it("writes the full grade at strength 1", () => {
    const full = join(dir, "full.tiff");
    const almost = join(dir, "almost.tiff");
    applyLutWithCancelStrength(source, full, table, 1, NEVER_CANCELED);
    applyLutWithCancelStrength(source, almost, table, 0.999, NEVER_CANCELED);

    const a = samples(full);
    const b = samples(almost);
    let worst = 0;
    for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThanOrEqual(64);
  });
});

describe("direct pipeline", () => {
  const dir = scratch("direct");
  const source = join(dir, "src.tiff");
  makeTiff(source, { width: 32, height: 24, kind: "wide" });

  it("stays close to the LUT it bakes from", () => {
    const lut = join(dir, "lut.tiff");
    const direct = join(dir, "direct.tiff");
    applyLutWithCancelStrength(source, lut, table, 1, NEVER_CANCELED);
    applyDirectWithCancelStrength(source, direct, params, 1, NEVER_CANCELED);

    const a = samples(lut);
    const b = samples(direct);
    let worst = 0;
    let total = 0;
    for (let i = 0; i < a.length; i += 1) {
      const delta = Math.abs(a[i] - b[i]);
      worst = Math.max(worst, delta);
      total += delta;
    }
    // A 33³ grid interpolates: the error is bounded by the grid spacing, not by
    // the arithmetic. One percent of full scale is a generous ceiling.
    expect(worst).toBeLessThan(0.01 * 65535);
    expect(total / a.length).toBeLessThan(0.003 * 65535);
  });

  it("writes the same file twice, byte for byte", () => {
    const first = join(dir, "a.tiff");
    const second = join(dir, "b.tiff");
    applyDirectWithCancelStrength(source, first, params, 0.8, NEVER_CANCELED);
    applyDirectWithCancelStrength(source, second, params, 0.8, NEVER_CANCELED);
    expect(existsSync(first)).toBe(true);
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
  });
});

/** Trilinear lookup for a float buffer, kept here so the test does not depend
 * on the in-place helper it is checking against. */
function floatLookup(lut: Lut3D, pixels: Float32Array): Float32Array {
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
      out[p + k] = sum;
    }
  }
  return out;
}
