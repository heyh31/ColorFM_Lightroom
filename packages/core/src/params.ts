/**
 * Grading parameters: the eight kernels the network predicts.
 *
 * One stage is `k1: 4x16, k2: 16x16, k3: 16x16, k4: 16x3`, stored flat and
 * row-major, 624 floats per stage and 1248 for a full set. The order is fixed
 * so the values can cross a process boundary, be cached in `params.bin` or be
 * pinned into a project file without a schema negotiation.
 */

import { ColorfmError } from "./error.js";

/** Hidden width of every kernel (the model's `mat_dim`). */
export const MAT_DIM = 16;

/** Floats in one stage (`content` or `style`). */
export const KERNEL_VALUES = 4 * MAT_DIM + MAT_DIM * MAT_DIM * 2 + MAT_DIM * 3;

/** Floats in a full parameter set (both stages). */
export const PARAMS_VALUES = KERNEL_VALUES * 2;

/**
 * One stage of the transform.
 *
 * One `Float32Array` per matrix, flat and row-major: a write rounds to f32, so
 * the weights stay exactly what the model produced, and the same layout is used
 * by `params.bin`, the wire and `paramsIntoBuffer`.
 */
export interface Kernels {
  /** 4 x 16, row-major. */
  readonly k1: Float32Array;
  /** 16 x 16, row-major. */
  readonly k2: Float32Array;
  /** 16 x 16, row-major. */
  readonly k3: Float32Array;
  /** 16 x 3, row-major. */
  readonly k4: Float32Array;
}

/** Kernels with every weight at zero: the transform is the identity. */
export function zeroKernels(): Kernels {
  return {
    k1: new Float32Array(4 * MAT_DIM),
    k2: new Float32Array(MAT_DIM * MAT_DIM),
    k3: new Float32Array(MAT_DIM * MAT_DIM),
    k4: new Float32Array(MAT_DIM * 3),
  };
}

/**
 * Reads 624 floats laid out as `k1, k2, k3, k4`, starting at `offset`.
 * Returns `undefined` on a length mismatch instead of throwing, so callers can
 * decide whether that is an error (see {@link paramsFromSlice}).
 */
export function kernelsFromSlice(values: ArrayLike<number>, offset = 0): Kernels | undefined {
  if (values.length - offset < KERNEL_VALUES) return undefined;
  const out = zeroKernels();
  let i = offset;
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < MAT_DIM; c += 1) {
      out.k1[r * MAT_DIM + c] = values[i++];
    }
  }
  for (const matrix of [out.k2, out.k3]) {
    for (let r = 0; r < MAT_DIM; r += 1) {
      for (let c = 0; c < MAT_DIM; c += 1) {
        matrix[r * MAT_DIM + c] = values[i++];
      }
    }
  }
  for (let r = 0; r < MAT_DIM; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out.k4[r * 3 + c] = values[i++];
    }
  }
  return out;
}

/** Appends 624 floats in the same order {@link kernelsFromSlice} expects. */
export function writeKernels(kernels: Kernels, out: number[]): void {
  for (let i = 0; i < kernels.k1.length; i += 1) out.push(kernels.k1[i]);
  for (const matrix of [kernels.k2, kernels.k3]) {
    for (let i = 0; i < matrix.length; i += 1) out.push(matrix[i]);
  }
  for (let i = 0; i < kernels.k4.length; i += 1) out.push(kernels.k4[i]);
}

/** Deep copy, used where a caller must not see later mutation. */
export function cloneKernels(kernels: Kernels): Kernels {
  return {
    k1: kernels.k1.slice(),
    k2: kernels.k2.slice(),
    k3: kernels.k3.slice(),
    k4: kernels.k4.slice(),
  };
}

/** Structural equality on the raw weights. */
export function kernelsEqual(a: Kernels, b: Kernels): boolean {
  return sameValues(a.k1, b.k1) && sameValues(a.k2, b.k2) && sameValues(a.k3, b.k3) && sameValues(a.k4, b.k4);
}

function sameValues(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/** A full transform: first stage (`content`), then the inverse stage (`style`). */
export interface Params {
  readonly content: Kernels;
  readonly style: Kernels;
}

/** Both stages at zero: `transfer` returns its input unchanged. */
export function zeroParams(): Params {
  return { content: zeroKernels(), style: zeroKernels() };
}

/** Parses the 1248-float wire layout. Throws `paramLength` on a size mismatch. */
export function paramsFromSlice(values: ArrayLike<number>): Params {
  if (values.length !== PARAMS_VALUES) {
    throw ColorfmError.paramLength(PARAMS_VALUES, values.length);
  }
  const content = kernelsFromSlice(values, 0);
  const style = kernelsFromSlice(values, KERNEL_VALUES);
  if (!content || !style) throw ColorfmError.paramLength(PARAMS_VALUES, values.length);
  return { content, style };
}

/** Serialises both stages into one flat array of 1248 floats. */
export function paramsToVec(params: Params): number[] {
  const out: number[] = [];
  writeKernels(params.content, out);
  writeKernels(params.style, out);
  return out;
}

/** Serialises into a caller-owned buffer, avoiding the intermediate array. */
export function paramsIntoBuffer(params: Params, out: Float32Array): Float32Array {
  let offset = 0;
  for (const kernels of [params.content, params.style]) {
    for (const matrix of [kernels.k1, kernels.k2, kernels.k3, kernels.k4]) {
      out.set(matrix, offset);
      offset += matrix.length;
    }
  }
  return out;
}

/** Deep copy. */
export function cloneParams(params: Params): Params {
  return { content: cloneKernels(params.content), style: cloneKernels(params.style) };
}

/** Structural equality, used to check cached parameters against a fresh run. */
export function paramsEqual(a: Params, b: Params): boolean {
  return kernelsEqual(a.content, b.content) && kernelsEqual(a.style, b.style);
}
