/**
 * Colour transform maths, and the batch primitives that move a TIFF through it.
 *
 * This is the whole public surface of the library. Two rules decide what is in
 * it:
 *
 * 1. **No scheduling.** Nothing here decides how many cores to use, spawns a
 *    worker, splits a file, caches a table or remembers a previous call. `bake`
 *    bakes, `runRows` transforms the rows it is given, `applyLutToRows` applies a
 *    table to one band and returns. Spreading those batches across threads is
 *    the engine's job (`engine/src/bands.ts`, `worker.ts`).
 * 2. **No policy about the outside world.** Paths are arguments, not settings;
 *    nothing reads the environment; nothing logs. A caller passes bytes or a
 *    path in and gets a value back, so the same code runs in a CLI, in a test
 *    and inside a job worker.
 *
 * Everything else stays internal to the package: the sample-format helpers, the
 * MLP stages, the codecs and the TIFF reader/writer are implementation detail. The
 * tests import them by path, which keeps that split honest — if a test needs a
 * name, it is not part of the contract.
 */

export { ColorfmError, type ColorfmErrorKind } from "./error.js";

// --- parameters ------------------------------------------------------------
// The 1248-float kernel set: the unit everything else is expressed in.
export { PARAMS_VALUES, paramsFromSlice, paramsIntoBuffer, paramsToVec, type Params } from "./params.js";

// --- 3D LUT ----------------------------------------------------------------
// Baking is a batch over grid nodes; applying is a batch over pixels.
export { applyInPlace, applyInPlaceStrength, bake, createLut, type Lut3D } from "./lut/index.js";
export * as cube from "./lut/cube.js";

// --- whole-file pipeline ---------------------------------------------------
// Compositions of the batches above, for callers that want the file handled in
// one call. `applyLutToRows` is the same work restricted to a row range.
export {
  applyDirect,
  applyDirectWithCancel,
  applyDirectWithCancelStrength,
  applyLut,
  applyLutToRows,
  applyLutWithCancel,
  applyLutWithCancelStrength,
  render,
  type Apply,
} from "./pipeline.js";

// --- TIFF batch primitives -------------------------------------------------
export {
  DEFAULT_BLOCK_ROWS,
  editableLayout,
  prepareCopy,
  runRows,
  transform,
  transformWithCancel,
  type CancelToken,
  type ImageInfo,
  type RowBand,
  type StripTransform,
} from "./io/tiff.js";

// --- thumbnails and previews ----------------------------------------------
// Decoding and encoding are I/O; resampling is the model's own preprocessing.
export { encodeJpeg, fitWithin, preview, savePng16, thumbnailAny } from "./io/thumb.js";

// --- inference -------------------------------------------------------------
export { OnnxPredictor } from "./infer/onnx.js";
export { INPUT_SIZE, thumbOf, type BackendInfo, type ParamPredictor, type Thumb } from "./infer/index.js";

// --- colour management boundary -------------------------------------------
// Deliberately empty for now: profiles are carried through byte for byte. The
// module documents the contract a future implementation has to meet.
