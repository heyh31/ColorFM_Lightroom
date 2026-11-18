/**
 * Where a render is cut.
 *
 * The split is the engine's decision: core reports the layout, and this module
 * turns it into contiguous row bands. Getting the arithmetic wrong here shows up
 * as a duplicated or missing strip in the output, so the coverage property is
 * asserted directly.
 */

import { describe, expect, it } from "vitest";

import { planBands } from "../src/bands.js";

describe("band planning", () => {
  it("covers every row exactly once", () => {
    expect(planBands(10, 3)).toEqual([
      { firstRow: 0, rows: 3 },
      { firstRow: 3, rows: 3 },
      { firstRow: 6, rows: 4 },
    ]);

    // More workers than rows: one band per row, no empty bands.
    expect(planBands(2, 8)).toEqual([
      { firstRow: 0, rows: 1 },
      { firstRow: 1, rows: 1 },
    ]);

    const covered = planBands(4640, 8).flatMap((band) =>
      Array.from({ length: band.rows }, (_, index) => band.firstRow + index),
    );
    expect(covered).toEqual(Array.from({ length: 4640 }, (_, index) => index));
  });

  it("never asks for zero workers", () => {
    expect(planBands(9, 0)).toEqual([{ firstRow: 0, rows: 9 }]);
    expect(planBands(9, -3)).toEqual([{ firstRow: 0, rows: 9 }]);
    expect(planBands(0, 4)).toEqual([]);
  });
});
