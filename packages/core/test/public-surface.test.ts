/**
 * The published surface, pinned.
 *
 * Narrowing `index.ts` only holds if it cannot grow by accident: adding a name
 * here means editing this list, which is the point. The second test guards the
 * rule that produced the list — nothing in it schedules work, so names like
 * `bakeParallel` or `planBands` must not come back.
 */

import { describe, expect, it } from "vitest";

import * as core from "../src/index.js";

/** Every value the package exports, sorted. Types are erased and cannot be listed. */
const SURFACE = [
  "ColorfmError",
  "DEFAULT_BLOCK_ROWS",
  "INPUT_SIZE",
  "OnnxPredictor",
  "PARAMS_VALUES",
  "applyDirect",
  "applyDirectWithCancel",
  "applyDirectWithCancelStrength",
  "applyInPlace",
  "applyInPlaceStrength",
  "applyLut",
  "applyLutToRows",
  "applyLutWithCancel",
  "applyLutWithCancelStrength",
  "bake",
  "createLut",
  "cube",
  "editableLayout",
  "encodeJpeg",
  "fitWithin",
  "paramsFromSlice",
  "paramsToVec",
  "prepareCopy",
  "preview",
  "render",
  "runRows",
  "savePng16",
  "thumbOf",
  "thumbnailAny",
  "transform",
  "transformWithCancel",
];

describe("public surface", () => {
  it("is exactly the documented set", () => {
    expect(Object.keys(core).sort()).toEqual([...SURFACE].sort());
  });

  it("carries no scheduling vocabulary", () => {
    // The library hands out batches; deciding how many run at once is the
    // engine's job. A name like these coming back would mean the boundary leaked.
    for (const name of Object.keys(core)) {
      expect(name).not.toMatch(/Parallel|Threads?$|Worker|planBands/);
    }
  });
});
