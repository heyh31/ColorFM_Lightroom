/**
 * JPEG decoding and encoding.
 *
 * The codec itself lives in `raster.ts` (sharp/libvips); this module keeps the
 * names the rest of the library calls. Decoding handles
 * baseline, progressive and CMYK sources; encoding is libjpeg-turbo.
 *
 * Neither path is used for the graded output — that is always 16-bit TIFF.
 */

import { decodeRgb8, encodeJpegRgb, type Rgb8Image } from "./raster.js";

export type { Rgb8Image };

/** Decodes a JPEG into 8-bit RGB, dropping any alpha channel. */
export async function decodeJpeg(source: string | Uint8Array): Promise<Rgb8Image> {
  return decodeRgb8(source);
}

/** Encodes interleaved float RGB in `[0,1]` as a JPEG at `quality`. */
export async function encodeJpeg(
  pixels: Float32Array,
  width: number,
  height: number,
  quality: number,
): Promise<Buffer> {
  return encodeJpegRgb(pixels, width, height, quality);
}
