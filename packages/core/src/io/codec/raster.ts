/**
 * Raster decode/encode through sharp (libvips).
 *
 * sharp owns every raster format except TIFF: PNG, JPEG, WebP, HEIC and
 * whatever else libvips was built with. TIFF keeps its own reader in
 * `codec/tiff.ts`, because the graded output has to be a byte copy of the source
 * with only the pixels replaced, and it has to stream.
 *
 * Everything here is **async**: sharp has no synchronous API. That is why the
 * thumbnail and preview helpers it feeds are async too.
 *
 * Two rules fix the decoded form:
 *
 * * pixels are sRGB, 8-bit, no alpha — the model's input domain;
 * * a 16-bit source is narrowed with `(value + 128) / 257`, the rounding the
 *   native build applies.
 */

import type { OutputInfo } from "sharp";

import { ColorfmError } from "../../error.js";
import { clamp01 } from "../../float32.js";

/**
 * sharp is loaded on first use, not at import time.
 *
 * libvips brings a shared library and a thread pool. The band workers reach this
 * module through `io/` but only ever walk TIFF strips, so it stays unloaded for
 * them.
 */
type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;

function loadSharp(): Promise<Sharp> {
  sharpModule ??= import("sharp").then((module) => module.default);
  return sharpModule;
}

/** Decoded 8-bit RGB raster. */
export interface Rgb8Image {
  width: number;
  height: number;
  /** `width * height * 3` bytes, row-major. */
  data: Uint8Array;
}

/**
 * Decodes any raster sharp understands to packed 8-bit RGB.
 *
 * `source` may be a path (the common case: sharp reads it itself and never
 * holds the whole file in memory) or bytes when the caller already has them.
 */
export async function decodeRgb8(source: string | Uint8Array): Promise<Rgb8Image> {
  let data: Buffer;
  let info: OutputInfo;
  let wide: boolean;
  try {
    const sharp = await loadSharp();
    const image =
      typeof source === "string"
        ? sharp(source, { failOn: "error" })
        : sharp(Buffer.from(source), { failOn: "error" });

    // `raw()` alone hands back 8 bits, letting libvips narrow a 16-bit source
    // with its own rounding. Ask for the native depth instead and narrow here,
    // so the values match the native build exactly.
    const meta = await image.metadata();
    wide = meta.depth === "ushort";

    ({ data, info } = await image
      // "srgb" means the 8-bit sRGB interpretation to libvips, so a 16-bit
      // source must be named "rgb16" or it is rounded down and back up before we
      // ever see the samples.
      .toColourspace(wide ? "rgb16" : "srgb")
      .removeAlpha()
      .raw(wide ? { depth: "ushort" } : {})
      .toBuffer({ resolveWithObject: true }));
  } catch (error) {
    throw ColorfmError.badImage((error as Error).message);
  }

  if (info.channels !== 3) {
    throw ColorfmError.badImage(`expected three channels, decoded ${info.channels}`);
  }

  if (wide) {
    // 16-bit source: narrow with the same rounding the native build uses.
    const count = info.width * info.height * 3;
    const narrow = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      narrow[i] = Math.floor((data.readUInt16LE(i * 2) + 128) / 257);
    }
    return { width: info.width, height: info.height, data: narrow };
  }

  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
  };
}

/** Pixel size, read from the header by libvips. */
export async function rasterDimensions(source: string): Promise<{ width: number; height: number }> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(source, { failOn: "error" }).metadata();
    if (!meta.width || !meta.height) throw new Error("image has no dimensions");
    return { width: meta.width, height: meta.height };
  } catch (error) {
    throw ColorfmError.badImage((error as Error).message);
  }
}

/**
 * Encodes interleaved float RGB in `[0,1]` as a JPEG.
 *
 * 4:4:4 chroma at quality 95: these are UI previews meant to be judged on, and
 * the extra chroma resolution costs a few kilobytes. Values are rounded to 8
 * bits the same way the 16-bit writer quantises.
 */
export async function encodeJpegRgb(
  pixels: Float32Array,
  width: number,
  height: number,
  quality: number,
): Promise<Buffer> {
  const count = width * height;
  if (pixels.length < count * 3) throw ColorfmError.badImage("pixel buffer is too small");

  const rgb = Buffer.allocUnsafe(count * 3);
  for (let i = 0; i < count * 3; i += 1) rgb[i] = Math.round(clamp01(pixels[i]) * 255);

  try {
    const sharp = await loadSharp();
    return await sharp(rgb, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: Math.max(1, Math.min(100, Math.round(quality))), chromaSubsampling: "4:4:4" })
      .toBuffer();
  } catch (error) {
    throw ColorfmError.badImage((error as Error).message);
  }
}
