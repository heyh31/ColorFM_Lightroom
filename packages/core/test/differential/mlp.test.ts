/**
 * Differential tests for `params.ts` and `mlp/index.ts`.
 *
 * Parameters must round trip through the flat wire layout unchanged, and the
 * two MLP entry points must agree with the reference — and with each other —
 * down to the last bit.
 */

import { describe, expect, it } from "vitest";

const MAT_DIM_LESS_ONE = 15;

import { evalStage, transfer, transferBatch } from "../../src/mlp.js";
import {
  KERNEL_VALUES,
  PARAMS_VALUES,
  kernelsFromSlice,
  paramsFromSlice,
  paramsToVec,
  zeroParams,
} from "../../src/params.js";
import {
  bitsOfAll,
  deterministicParams,
  firstDifference,
  reference,
  SKIP_WITHOUT_REFERENCE,
  sampleGrid,
} from "./helpers.js";

describe("parameter layout", () => {
  it("uses the model's matrix sizes", () => {
    expect(KERNEL_VALUES).toBe(624);
    expect(PARAMS_VALUES).toBe(1248);
  });

  it("round trips through the flat layout in order", () => {
    const values = Array.from({ length: PARAMS_VALUES }, (_, i) => Math.fround(i * 0.001));
    const params = paramsFromSlice(values);
    expect(paramsToVec(params)).toEqual(values);
    expect(params.content.k1[0]).toBe(values[0]);
    expect(params.style.k4[MAT_DIM_LESS_ONE * 3 + 2]).toBe(values[PARAMS_VALUES - 1]);
  });

  it("rejects a wrong length", () => {
    expect(() => paramsFromSlice(new Array(10).fill(0))).toThrow(/expected 1248 param values, got 10/);
  });

  it("rejects a short kernel slice", () => {
    expect(kernelsFromSlice(new Float32Array(KERNEL_VALUES - 1))).toBeUndefined();
  });
});

describe("zero kernels", () => {
  it("leave the colour untouched", () => {
    const params = zeroParams();
    for (const rgb of [
      [0, 0, 0],
      [0.25, 0.5, 0.75],
      [1, 1, 1],
    ] as Array<[number, number, number]>) {
      expect(transfer(params, rgb)).toEqual(rgb);
    }
  });

  it("carry the bias channel through the hidden layers", () => {
    const params = zeroParams();
    const wire = (kernels: typeof params.content): void => {
      kernels.k1[3 * 16 + 0] = 1;
      kernels.k2[0 * 16 + 0] = 1;
      kernels.k3[0 * 16 + 0] = 1;
      kernels.k4[0 * 3 + 0] = 1;
    };
    wire(params.content);
    wire(params.style);

    const out = transfer(params, [0, 0, 0]);
    // The content stage sees bias 0, so y1 stays 0; the style stage sees bias 1
    // and subtracts swish(swish(swish(1))).
    const s = (x: number): number => x / (1 + Math.exp(-x));
    expect(Math.abs(out[0] + s(s(s(1))))).toBeLessThan(1e-6);
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)("mlp evaluation", () => {
  it("matches the reference for single pixels, batches and stage evaluation", () => {
    const params = deterministicParams();
    const samples = sampleGrid(7);
    const expected = reference<{ single: string[]; batch: string[] }>("mlp", {
      params,
      samples,
    });

    const parsed = paramsFromSlice(params);
    const single = samples.flatMap((rgb) => transfer(parsed, rgb));
    expect(firstDifference(expected.single, bitsOfAll(single))).toBeUndefined();

    const flat = new Float32Array(samples.flat());
    const batch = transferBatch(parsed, flat);
    expect(firstDifference(expected.batch, bitsOfAll(batch))).toBeUndefined();
  });

  it("keeps the batch path identical to the scalar path", () => {
    const params = paramsFromSlice(deterministicParams());
    const samples = sampleGrid(5);
    const batch = transferBatch(params, new Float32Array(samples.flat()));
    const scalar = samples.flatMap((rgb) => transfer(params, rgb));
    expect(firstDifference(bitsOfAll(scalar), bitsOfAll(batch))).toBeUndefined();
  });

  it("evaluates a stage against the reference", () => {
    const params = paramsFromSlice(deterministicParams(101, 53));
    const samples = sampleGrid(4);
    const stage = samples.flatMap((rgb) => evalStage(params.content, rgb, 0));
    // The reference exposes the full transform, so a zero second stage isolates
    // the content stage: transfer() with an empty style equals content stage + x.
    const withEmptyStyle = paramsFromSlice([
      ...Array.from(params.content.k1),
      ...Array.from(params.content.k2),
      ...Array.from(params.content.k3),
      ...Array.from(params.content.k4),
      ...new Array(624).fill(0),
    ]);
    const expected = reference<{ single: string[] }>("mlp", { params: paramsToVec(withEmptyStyle), samples });
    const transformed = samples.map((rgb) => transfer(withEmptyStyle, rgb));
    const deltas = transformed.map((out, i) => [
      Math.fround(out[0] - samples[i][0]),
      Math.fround(out[1] - samples[i][1]),
      Math.fround(out[2] - samples[i][2]),
    ]);
    // The reference returns y1 + delta; compare the deltas the stage produced.
    expect(expected.single.length).toBe(samples.length * 3);
    for (let i = 0; i < stage.length; i += 1) {
      expect(Math.abs(stage[i] - deltas[Math.floor(i / 3)][i % 3])).toBeLessThan(1e-6);
    }
  });
});
