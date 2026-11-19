/**
 * Grading parameters: the eight kernels the network predicts.
 *
 * One stage is `k1: 4x16, k2: 16x16, k3: 16x16, k4: 16x3`, 624 values per stage
 * and 1248 for a full set. The order is fixed so the values can cross a process
 * boundary, be cached in `params.bin` or be pinned into a project file without a
 * schema negotiation.
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
 * One array per row, row-major, so `k1` reads as four rows of sixteen. Values
 * are f32-precision: every reader rounds with `Math.fround` on the way in, which
 * is exactly what the model produced. The arithmetic after that runs in double,
 * so the only rounding in the pipeline is the quantisation at the ends.
 */
export interface Kernels {
  /** 4 x 16. */
  readonly k1: number[][];
  /** 16 x 16. */
  readonly k2: number[][];
  /** 16 x 16. */
  readonly k3: number[][];
  /** 16 x 3. */
  readonly k4: number[][];
}

/** `rowCount` rows of `cols` zeros. */
function emptyMatrix(rowCount: number, cols: number): number[][] {
  const rows: number[][] = [];
  for (let r = 0; r < rowCount; r += 1) rows.push(new Array<number>(cols).fill(0));
  return rows;
}

/** Kernels with every weight at zero: the transform is the identity. */
export function zeroKernels(): Kernels {
  return {
    k1: emptyMatrix(4, MAT_DIM),
    k2: emptyMatrix(MAT_DIM, MAT_DIM),
    k3: emptyMatrix(MAT_DIM, MAT_DIM),
    k4: emptyMatrix(MAT_DIM, 3),
  };
}

/**
 * Reads 624 floats laid out as `k1, k2, k3, k4`, starting at `offset`.
 * Returns `undefined` on a length mismatch instead of throwing, so callers can
 * decide whether that is an error (see {@link paramsFromSlice}).
 */
export function kernelsFromSlice(values: ArrayLike<number>, offset = 0): Kernels | undefined {
  if (values.length - offset < KERNEL_VALUES) return undefined;
  let i = offset;
  // The single rounding point for the whole pipeline: everything downstream
  // reads these cells and multiplies doubles.
  const take = (rowCount: number, cols: number): number[][] => {
    const rows: number[][] = [];
    for (let r = 0; r < rowCount; r += 1) {
      const row = new Array<number>(cols);
      for (let c = 0; c < cols; c += 1) row[c] = Math.fround(values[i++]);
      rows.push(row);
    }
    return rows;
  };
  return {
    k1: take(4, MAT_DIM),
    k2: take(MAT_DIM, MAT_DIM),
    k3: take(MAT_DIM, MAT_DIM),
    k4: take(MAT_DIM, 3),
  };
}

/** Appends 624 floats in the same order {@link kernelsFromSlice} expects. */
export function writeKernels(kernels: Kernels, out: number[]): void {
  for (const matrix of [kernels.k1, kernels.k2, kernels.k3, kernels.k4]) {
    for (const row of matrix) {
      for (let c = 0; c < row.length; c += 1) out.push(row[c]);
    }
  }
}

/** Deep copy, used where a caller must not see later mutation. */
export function cloneKernels(kernels: Kernels): Kernels {
  const copy = (matrix: number[][]): number[][] => matrix.map((row) => row.slice());
  return {
    k1: copy(kernels.k1),
    k2: copy(kernels.k2),
    k3: copy(kernels.k3),
    k4: copy(kernels.k4),
  };
}

/** Structural equality on the raw weights. */
export function kernelsEqual(a: Kernels, b: Kernels): boolean {
  return sameValues(a.k1, b.k1) && sameValues(a.k2, b.k2) && sameValues(a.k3, b.k3) && sameValues(a.k4, b.k4);
}

function sameValues(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r += 1) {
    const rowA = a[r];
    const rowB = b[r];
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c += 1) {
      if (!Object.is(rowA[c], rowB[c])) return false;
    }
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
      for (const row of matrix) {
        out.set(row, offset);
        offset += row.length;
      }
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
