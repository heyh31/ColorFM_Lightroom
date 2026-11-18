/**
 * Model input types and the inference backends.
 *
 * The inference side is split: `types.ts` holds what a predictor consumes and
 * produces, `onnx.ts` is one backend. Loading the runtime is deferred to the
 * first prediction, so importing the barrel stays cheap.
 */

export * from "./types.js";
export * from "./onnx.js";
