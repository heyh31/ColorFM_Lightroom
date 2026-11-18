/**
 * Differential tests for `lut/`: baking, trilinear lookup, strength blending
 * and the `.cube` serialisation.
 */

import { describe, expect, it } from "vitest";

import {
  apply,
  applyBatch,
  applyInPlace,
  applyInPlaceStrength,
  applyParallel,
  bake,
  blend,
  blendExtrapolate,
  cube,
  identityLut,
  lutOffset,
} from "../../src/lut/index.js";
import { createLut } from "../../src/lut/index.js";
import { paramsFromSlice, zeroParams } from "../../src/params.js";
import {
  bitsOfAll,
  deterministicParams,
  firstDifference,
  reference,
  SKIP_WITHOUT_REFERENCE,
  sampleGrid,
} from "./helpers.js";

describe("table shape", () => {
  it("indexes red fastest", () => {
    const lut = identityLut(4);
    expect(lutOffset(lut, 1, 0, 0)).toBe(3);
    expect(lutOffset(lut, 0, 1, 0)).toBe(12);
    expect(lutOffset(lut, 0, 0, 1)).toBe(48);
    expect(Array.from(lut.data.slice(3, 6))).toEqual([Math.fround(1 / 3), 0, 0]);
  });

  it("rejects tables that do not match their size", () => {
    expect(() => createLut(2, new Float32Array(3))).toThrow(/expected 8/);
    expect(() => createLut(1, new Float32Array(3))).toThrow(/at least 2/);
  });
});

describe("blending", () => {
  it("hits both endpoints and extrapolates past the target", () => {
    const identity = identityLut(3);
    const graded = createLut(
      3,
      Float32Array.from(identity.data, (value, index) =>
        index % 3 === 0 ? Math.min(1, value + 0.2) : value,
      ),
    );

    expect(Array.from(blend(identity, graded, 0).data)).toEqual(Array.from(identity.data));
    expect(Array.from(blend(identity, graded, 1).data)).toEqual(Array.from(graded.data));

    const over = blendExtrapolate(identity, graded, 2);
    for (let i = 0; i < identity.data.length; i += 1) {
      const expected = Math.fround(
        identity.data[i] + Math.fround(Math.fround(graded.data[i] - identity.data[i]) * 2),
      );
      expect(over.data[i]).toBe(expected);
    }
    // The clamped helper keeps its Amount semantics.
    expect(Array.from(blend(identity, graded, 2).data)).toEqual(Array.from(graded.data));
  });
});

describe("zero parameters", () => {
  it("bake to the identity table", () => {
    const lut = bake(zeroParams(), 9);
    for (let i = 0; i < lut.data.length / 3; i += 1) {
      expect(lut.data[i * 3]).toBe(Math.fround((i % 9) / 8));
      expect(lut.data[i * 3 + 1]).toBe(Math.fround((Math.floor(i / 9) % 9) / 8));
      expect(lut.data[i * 3 + 2]).toBe(Math.fround(Math.floor(i / 81) / 8));
    }
  });

  it("look up to themselves within interpolation error", () => {
    const lut = identityLut(33);
    for (const rgb of [
      [0, 0, 0],
      [0.1, 0.55, 0.9],
      [1, 1, 1],
    ] as Array<[number, number, number]>) {
      const out = apply(lut, rgb);
      for (let k = 0; k < 3; k += 1) expect(Math.abs(out[k] - rgb[k])).toBeLessThan(1e-5);
    }
  });

  it("clamp out-of-range input", () => {
    const lut = identityLut(5);
    expect(apply(lut, [-1, 0.5, 2])).toEqual([0, 0.5, 1]);
  });
});

describe("bake strength", () => {
  const params = paramsFromSlice(deterministicParams(101, 23));

  it("is the raw bake at 1 and the identity at 0", () => {
    // 1 has to be the bake itself, byte for byte: it is the common case, and
    // blending through t = 1 would only cost time.
    expect(bake(params, 17, 1).data).toEqual(bake(params, 17).data);
    expect(bake(params, 17, 0).data).toEqual(identityLut(17).data);
  });

  it("folds a partial and an over-driven Amount into the table", () => {
    const graded = bake(params, 17);
    const identity = identityLut(17);

    for (const strength of [0.35, 1.4]) {
      const folded = bake(params, 17, strength);
      for (let i = 0; i < graded.data.length; i += 1) {
        const expected = Math.fround(
          identity.data[i] + Math.fround(Math.fround(graded.data[i] - identity.data[i]) * strength),
        );
        expect(folded.data[i], `strength ${strength}, entry ${i}`).toBe(expected);
      }
    }
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)("baking", () => {
  it("matches the reference for every grid size the pipeline uses", () => {
    const params = deterministicParams();
    for (const size of [2, 5, 17, 33]) {
      const expected = reference<{ size: number; bits: string[]; parallel_bits: string[] }>("bake", {
        params,
        size,
        threads: 3,
      });
      const parsed = paramsFromSlice(params);
      const table = bake(parsed, size);
      // The harness computes the grid both point-wise and chunked; one table has
      // to satisfy both, which is the check that the batch evaluator agrees with
      // the per-pixel path.
      expect(bitsOfAll(table.data)).toEqual(expected.bits);
      expect(bitsOfAll(table.data)).toEqual(expected.parallel_bits);
    }
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)("lookup", () => {
  it("matches the reference for in-range and out-of-range samples", () => {
    const params = deterministicParams(101, 61);
    const samples: Array<[number, number, number]> = [
      ...sampleGrid(9),
      [-1, 0.5, 2],
      [0.5, -0.25, 1.5],
      [1.0001, 0.9999, 0],
      [-1e30, 1e30, 0.5],
    ];
    const expected = reference<{
      apply: string[];
      batch: string[];
      in_place: string[];
      strength: string[];
      parallel: string[];
    }>("apply", { params, samples, size: 17, strength: 0.63 });

    const parsed = paramsFromSlice(params);
    const table = bake(parsed, 17);

    expect(
      firstDifference(expected.apply, bitsOfAll(samples.flatMap((rgb) => apply(table, rgb)))),
    ).toBeUndefined();
    expect(
      firstDifference(expected.batch, bitsOfAll(applyBatch(table, new Float32Array(samples.flat())))),
    ).toBeUndefined();

    const inPlace = new Float32Array(samples.flat());
    applyInPlace(table, inPlace);
    expect(firstDifference(expected.in_place, bitsOfAll(inPlace))).toBeUndefined();

    const withStrength = new Float32Array(samples.flat());
    applyInPlaceStrength(table, withStrength, 0.63);
    expect(firstDifference(expected.strength, bitsOfAll(withStrength))).toBeUndefined();

    const parallel = applyParallel(table, new Float32Array(samples.flat()), 3);
    expect(firstDifference(expected.parallel, bitsOfAll(parallel))).toBeUndefined();
  });

  it("matches the reference when extrapolating past full strength", () => {
    const params = deterministicParams(101, 71);
    for (const t of [0, 0.25, 1, 1.5, 2, 2.5]) {
      const expected = reference<{ clamped: string[]; extrapolated: string[] }>("blend", {
        params,
        size: 9,
        t,
      });
      const parsed = paramsFromSlice(params);
      const table = bake(parsed, 9);
      const identity = identityLut(9);
      expect(firstDifference(expected.clamped, bitsOfAll(blend(identity, table, t).data))).toBeUndefined();
      expect(
        firstDifference(expected.extrapolated, bitsOfAll(blendExtrapolate(identity, table, t).data)),
      ).toBeUndefined();
    }
  });
});

describe.skipIf(SKIP_WITHOUT_REFERENCE)(".cube files", () => {
  it("writes the same text as the reference", () => {
    const params = deterministicParams();
    const expected = reference<{ text: string }>("cube_write", { params, size: 9, title: "ColorFM" });
    const text = cube.write(bake(paramsFromSlice(params), 9), "ColorFM");
    expect(text).toBe(expected.text);
  });

  it("parses what the reference writes", () => {
    const params = deterministicParams(101, 43);
    const written = reference<{ text: string }>("cube_write", { params, size: 5, title: "round trip" });
    const parsed = cube.read(written.text);
    expect(parsed.size).toBe(5);
    expect(parsed.data.length).toBe(5 * 5 * 5 * 3);
    // Six decimals is the only loss in the round trip.
    const exact = bake(paramsFromSlice(params), 5);
    for (let i = 0; i < exact.data.length; i += 1) {
      expect(Math.abs(parsed.data[i] - exact.data[i])).toBeLessThanOrEqual(1e-6);
    }
  });

  it("rejects truncated data and missing sizes", () => {
    expect(() => cube.read("LUT_3D_SIZE 2\n0.0 0.0 0.0\n")).toThrow(/expected 8/);
    expect(() => cube.read("0.0 0.0 0.0\n")).toThrow(/missing LUT_3D_SIZE/);
    expect(() => cube.read("LUT_3D_SIZE 2\n0.0 nope 0.0\n")).toThrow(/bad value/);
  });

  it("keeps the header stable", () => {
    const text = cube.write(identityLut(2), "ColorFM");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe('TITLE "ColorFM"');
    expect(lines[1]).toBe("LUT_3D_SIZE 2");
    expect(lines[2]).toBe("DOMAIN_MIN 0 0 0");
    expect(lines[3]).toBe("DOMAIN_MAX 1 1 1");
    expect(lines.length).toBe(4 + 8);
  });
});
