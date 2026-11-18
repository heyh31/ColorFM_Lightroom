/**
 * Inference: predict {@link Params} from a content and a reference thumbnail.
 *
 * Two `1x3x256x256` sRGB inputs in `[0,1]`, eight kernels out (`k1_c..k4_s`).
 * Resizing is the caller's job — feeding anything but 256x256 is rejected
 * here, because the graph has a hard-coded token grid.
 */

import { ColorfmError } from "../error.js";
import type { Params } from "../params.js";

/** Side length the model expects. */
export const INPUT_SIZE = 256;

/** A square sRGB thumbnail, row-major, values in `[0,1]`. */
export interface Thumb {
  readonly width: number;
  readonly height: number;
  /** `width * height * 3` interleaved RGB values. */
  readonly pixels: Float32Array;
}

/** Builds a thumbnail, rejecting a pixel count that does not match the size. */
export function thumbOf(width: number, height: number, pixels: Float32Array): Thumb {
  const expected = width * height;
  if (pixels.length !== expected * 3) {
    throw ColorfmError.badImage(
      `expected ${expected} pixels for ${width}x${height}, got ${pixels.length / 3}`,
    );
  }
  return { width, height, pixels };
}

/** Builds a thumbnail from 8-bit RGB bytes (sRGB encoded, row-major). */
export function thumbFromRgb8(width: number, height: number, bytes: Uint8Array): Thumb {
  const expected = width * height * 3;
  if (bytes.length !== expected) {
    throw ColorfmError.badImage(
      `expected ${expected} bytes for ${width}x${height} RGB8, got ${bytes.length}`,
    );
  }
  const pixels = new Float32Array(expected);
  for (let i = 0; i < expected; i += 1) pixels[i] = bytes[i] / 255;
  return { width, height, pixels };
}

/** Rejects anything the model cannot consume. */
export function requireModelSize(thumb: Thumb): void {
  if (thumb.width !== INPUT_SIZE || thumb.height !== INPUT_SIZE) {
    throw ColorfmError.badImage(
      `model needs ${INPUT_SIZE}x${INPUT_SIZE}, got ${thumb.width}x${thumb.height}`,
    );
  }
}

/** Which backend produced a prediction, for `/v1/health` and diagnostics. */
export interface BackendInfo {
  readonly name: string;
  readonly inputSize: number;
}

/** Anything that can turn two thumbnails into grading parameters. */
export interface ParamPredictor {
  /**
   * `content` is the photo being graded, `reference` the look to apply.
   * Both must be {@link INPUT_SIZE} square.
   */
  predict(content: Thumb, reference: Thumb): Promise<Params>;

  backendInfo(): BackendInfo;
}
