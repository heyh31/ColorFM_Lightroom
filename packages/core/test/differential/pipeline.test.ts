/**
 * Differential tests for `pipeline.ts`: the two ways parameters reach pixels.
 *
 * The LUT path is what ships; the direct path is the accuracy baseline, so both
 * have to agree with the reference on a real TIFF.
 */

import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { TiffReader } from "../../src/io/codec/tiff.js";
import { applyDirect, applyLut, render } from "../../src/pipeline.js";
import { bake } from "../../src/lut/index.js";
import { paramsFromSlice } from "../../src/params.js";
import {
  bitsOfAll,
  cleanupScratch,
  deterministicParams,
  firstDifference,
  reference,
  scratch,
  SKIP_WITHOUT_REFERENCE,
} from "./helpers.js";

afterAll(cleanupScratch);

/** Reads a TIFF back as normalised samples, in row order. */
function samplesOf(path: string): number[] {
  const reader = TiffReader.open(path);
  try {
    const out: number[] = [];
    for (let index = 0; index < reader.info.chunkCount; index += 1) {
      const chunk = reader.readChunk(index);
      for (let i = 0; i < chunk.length; i += 1) out.push(Math.fround(chunk[i] / 65535));
    }
    return out;
  } finally {
    reader.close();
  }
}

describe.skipIf(SKIP_WITHOUT_REFERENCE)("pipeline", () => {
  const dir = scratch("pipeline");
  const src = join(dir, "src.tiff");

  it("creates the source fixture", () => {
    reference("fixture", { path: src, width: 36, height: 28, kind: "ramp" });
    expect(TiffReader.open(src).info.width).toBe(36);
  });

  it("renders through the LUT path identically to the reference", () => {
    const params = deterministicParams(101, 29);
    const mine = join(dir, "lut-mine.tiff");
    const theirs = join(dir, "lut-theirs.tiff");

    const table = bake(paramsFromSlice(params), 17);
    const info = applyLut(src, mine, table);
    expect(info.metadataPreserved).toBe(true);

    const expected = reference<{ ok: boolean }>("transform", {
      src,
      dst: theirs,
      params,
      size: 17,
    });
    expect(expected.ok).toBe(true);
    expect(firstDifference(bitsOfAll(samplesOf(theirs)), bitsOfAll(samplesOf(mine)))).toBeUndefined();
  });

  it("renders through the direct path identically to the reference", () => {
    const params = deterministicParams(101, 47);
    const mine = join(dir, "direct-mine.tiff");
    const theirs = join(dir, "direct-theirs.tiff");

    applyDirect(src, mine, paramsFromSlice(params));
    const expected = reference<{ ok: boolean }>("transform", {
      src,
      dst: theirs,
      params,
      size: 9,
      direct: true,
    });
    expect(expected.ok).toBe(true);
    expect(firstDifference(bitsOfAll(samplesOf(theirs)), bitsOfAll(samplesOf(mine)))).toBeUndefined();
  });

  it("dispatches render() to the mode it was asked for", () => {
    const params = paramsFromSlice(deterministicParams(101, 59));
    const lutOut = join(dir, "render-lut.tiff");
    const directOut = join(dir, "render-direct.tiff");

    const viaLut = render(src, lutOut, params, { kind: "lut", grid: 17 });
    const viaDirect = render(src, directOut, params, { kind: "direct" });
    expect(viaLut.width).toBe(viaDirect.width);

    // A 17^3 grid is a close approximation, not the exact curve: the two files
    // must differ by less than one 8-bit step but not be identical.
    const a = samplesOf(lutOut);
    const b = samplesOf(directOut);
    let worst = 0;
    for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1 / 255);
  });
});
