/**
 * Unit conversion and 16-bit quantisation — the only places precision is
 * reduced on purpose.
 */

import { describe, expect, it } from "vitest";

import { clamp01, quantizeU16, toUnit, UNIT_PER_CODE } from "../src/float32.js";

describe("unit conversion", () => {
  it("maps the ends of the 16-bit range exactly", () => {
    expect(toUnit(0)).toBe(0);
    expect(toUnit(65535)).toBe(1);
  });

  it("round-trips every code without loss", () => {
    for (const code of [0, 1, 255, 256, 1023, 32768, 65534, 65535]) {
      expect(quantizeU16(toUnit(code))).toBe(code);
    }
  });

  it("uses one step per code", () => {
    expect(UNIT_PER_CODE).toBeCloseTo(1 / 65535, 15);
    expect(toUnit(2) - toUnit(1)).toBeCloseTo(UNIT_PER_CODE, 12);
  });
});

describe("quantisation", () => {
  it("rounds to the nearest code", () => {
    expect(quantizeU16(0.5 / 65535)).toBe(1);
    expect(quantizeU16(0.49 / 65535)).toBe(0);
    expect(quantizeU16(0.5)).toBe(32768);
  });

  it("clamps out-of-range values instead of wrapping", () => {
    expect(quantizeU16(-1)).toBe(0);
    expect(quantizeU16(2)).toBe(65535);
    expect(quantizeU16(1)).toBe(65535);
    expect(quantizeU16(1.0001)).toBe(65535);
  });

  it("treats NaN as zero", () => {
    expect(quantizeU16(Number.NaN)).toBe(0);
  });

  it("covers the range without gaps", () => {
    let previous = -1;
    for (let code = 0; code <= 65535; code += 1) {
      const quantised = quantizeU16(toUnit(code));
      expect(quantised).toBe(code);
      expect(quantised).toBeGreaterThan(previous);
      previous = quantised;
    }
  });
});

describe("clamping", () => {
  it("keeps values inside the unit interval", () => {
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
