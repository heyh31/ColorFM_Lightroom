/**
 * PNG decoding and 16-bit encoding.
 *
 * The codec itself is sharp/libvips (`raster.ts`); this module keeps the 8-bit
 * RGB entry point and the 16-bit writer, which sharp cannot provide. 16-bit
 * output is what stores a model input for later reproduction, so it has to
 * survive a round trip — PNG is lossless, and the decoder narrows with the same
 * rounding the native build uses.
 */

import { encodePng16 as encodePng16Samples } from "./png16.js";
import { decodeRgb8, type Rgb8Image } from "./raster.js";

export type { Rgb8Image };

/** Decodes a PNG into 8-bit RGB. */
export async function decodePng(source: string | Uint8Array): Promise<Rgb8Image> {
  return decodeRgb8(source);
}

/**
 * Encodes 16-bit RGB samples as a PNG.
 *
 * Async for symmetry with the decoder; the work is synchronous, because sharp
 * cannot write 16-bit PNGs from raw samples (see `png16.ts`).
 */
export async function encodePng16(width: number, height: number, samples: Uint16Array): Promise<Buffer> {
  return encodePng16Samples(width, height, samples);
}
