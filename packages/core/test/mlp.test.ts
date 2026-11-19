/**
 * Parameters and the per-pixel transform.
 *
 * The two MLP entry points have to agree with each other: the batch evaluator
 * is what bakes LUTs, the per-pixel one is what `--direct` applies, and a
 * difference between them would show up as a different grade depending on which
 * path a job took.
 */

import { describe, expect, it } from "vitest";

import { transfer, transferBatch } from "../src/mlp.js";
import { paramsFromSlice, paramsToVec, zeroParams, type Params } from "../src/params.js";
import { bitsOfAll, deterministicParams, firstDifference } from "./helpers.js";

const params: Params = paramsFromSlice(deterministicParams());

describe("parameter layout", () => {
  it("round-trips through the flat wire form", () => {
    const flat = paramsToVec(params);
    expect(flat).toHaveLength(1248);
    expect(paramsToVec(paramsFromSlice(flat))).toEqual(flat);
  });

  it("rejects a slice of the wrong length", () => {
    expect(() => paramsFromSlice([0, 0, 0])).toThrowError();
  });

  it("keeps each stage independent", () => {
    const different = paramsFromSlice(deterministicParams(211, 53));
    expect(paramsToVec(different)).not.toEqual(paramsToVec(params));
  });
});

describe("the transform", () => {
  it("is the identity when every weight is zero", () => {
    const zero = zeroParams();
    for (const rgb of [
      [0, 0, 0],
      [0.1, 0.55, 0.9],
      [1, 1, 1],
      [0.25, 0.25, 0.25],
    ] as Array<[number, number, number]>) {
      const out = transfer(zero, rgb);
      expect(out[0]).toBeCloseTo(rgb[0], 12);
      expect(out[1]).toBeCloseTo(rgb[1], 12);
      expect(out[2]).toBeCloseTo(rgb[2], 12);
    }
  });

  it("batch and per-pixel agree bit for bit", () => {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 64; i += 1) {
      colors.push([i / 63, ((i * 7) % 64) / 63, ((i * 17) % 64) / 63]);
    }
    const flat = new Float32Array(colors.length * 3);
    colors.forEach(([r, g, b], index) => {
      flat[index * 3] = r;
      flat[index * 3 + 1] = g;
      flat[index * 3 + 2] = b;
    });

    const batch = transferBatch(params, flat);
    for (let i = 0; i < colors.length; i += 1) {
      // `transfer` returns doubles; the batch returns the f32 buffer the
      // baker stores, so compare in that precision.
      const single = transfer(params, [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]).map(Math.fround);
      expect(single[0]).toBe(batch[i * 3]);
      expect(single[1]).toBe(batch[i * 3 + 1]);
      expect(single[2]).toBe(batch[i * 3 + 2]);
    }
  });

  it("does not let one pixel's position in the batch change its result", () => {
    const color: [number, number, number] = [0.31, 0.62, 0.93];
    const alone = transferBatch(params, new Float32Array(color));

    const together = new Float32Array(30);
    for (let i = 0; i < 10; i += 1) {
      together.set(i === 4 ? color : [i / 10, 1 - i / 10, 0.5], i * 3);
    }
    const batch = transferBatch(params, together);

    expect(batch[12]).toBe(alone[0]);
    expect(batch[13]).toBe(alone[1]);
    expect(batch[14]).toBe(alone[2]);
  });

  it("is deterministic across repeated calls", () => {
    const colors = new Float32Array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7]);
    expect(
      firstDifference(bitsOfAll(transferBatch(params, colors)), bitsOfAll(transferBatch(params, colors))),
    ).toBeUndefined();
  });

  it("produces finite values across the cube", () => {
    const grid = new Float32Array(9 * 9 * 9 * 3);
    let at = 0;
    for (let r = 0; r < 9; r += 1) {
      for (let g = 0; g < 9; g += 1) {
        for (let b = 0; b < 9; b += 1) {
          grid[at++] = r / 8;
          grid[at++] = g / 8;
          grid[at++] = b / 8;
        }
      }
    }
    const out = transferBatch(params, grid);
    for (let i = 0; i < out.length; i += 1) expect(Number.isFinite(out[i])).toBe(true);
  });
});
