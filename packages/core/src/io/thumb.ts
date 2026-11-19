/**
 * Model-input thumbnails and UI previews, produced from the same TIFF the LUT
 * will later be applied to.
 *
 * The model resizes whatever it is given to 256x256 with a plain bilinear
 * stretch (`align_corners=False`). That means:
 *
 * * the aspect ratio is **not** preserved and nothing is cropped;
 * * resampling happens on sRGB-encoded values, not in linear light;
 * * there is no antialiasing, so this matches the model's own preprocessing
 *   rather than a photographic resizer.
 *
 * Only two source rows are held at a time in the TIFF path, so memory stays
 * constant no matter how large the file is.
 */

import { closeSync, openSync, readSync, writeFileSync } from "node:fs";

import { ColorfmError } from "../error.js";
import { quantizeU16 } from "../samples.js";
import { thumbOf, type Thumb } from "../infer/index.js";
import { encodeJpeg as encodeJpegBuffer } from "./codec/jpeg.js";
import { encodePng16 } from "./codec/png.js";
import { decodeRgb8, rasterDimensions } from "./codec/raster.js";
import { TiffReader } from "./codec/tiff.js";

/**
 * Model input from any supported file: TIFF is decoded here (must be RGB16),
 * every other raster goes through sharp at 8 bits.
 */
export async function thumbnailAny(src: string, side: number): Promise<Thumb> {
  if (isTiffFile(src)) return thumbnail(src, side);
  const { width, height, data } = await decodeRgb8(src);
  return makeThumb(side, side, resample8(data, width, height, side, side));
}

/** True for classic TIFF and BigTIFF, detected from the magic bytes. */
export function isTiffFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const read = readSync(fd, magic, 0, 4, 0);
    if (read < 4) return false;
    const text = magic.toString("latin1");
    return text === "II*\u0000" || text === "MM\u0000*" || text === "II+\u0000" || text === "MM\u0000+";
  } finally {
    closeSync(fd);
  }
}

/**
 * Display preview: the whole frame scaled to fit within `maxEdge`, aspect
 * preserved. Returns the output size and interleaved RGB pixels.
 */
export async function preview(
  src: string,
  maxEdge: number,
): Promise<{ width: number; height: number; pixels: Float32Array }> {
  const { width, height } = await sourceDimensions(src);
  const [outWidth, outHeight] = fitWithin(width, height, maxEdge);

  if (isTiffFile(src)) {
    return { width: outWidth, height: outHeight, pixels: resampleTiff(src, outWidth, outHeight) };
  }
  const decoded = await decodeRgb8(src);
  return {
    width: outWidth,
    height: outHeight,
    pixels: resample8(decoded.data, decoded.width, decoded.height, outWidth, outHeight),
  };
}

/** Pixel size of a source file, read from the header only. */
export async function sourceDimensions(path: string): Promise<{ width: number; height: number }> {
  if (isTiffFile(path)) {
    const reader = TiffReader.open(path);
    try {
      return { width: reader.info.width, height: reader.info.height };
    } finally {
      reader.close();
    }
  }
  return rasterDimensions(path);
}

/** Fits `width x height` inside a square of `maxEdge`, keeping the aspect. */
export function fitWithin(width: number, height: number, maxEdge: number): [number, number] {
  const longest = Math.max(width, height, 1);
  if (longest <= maxEdge) return [width, height];
  const scale = maxEdge / longest;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** Encodes pixels as JPEG. Used for previews sent to the UI. */
export async function encodeJpeg(
  pixels: Float32Array,
  width: number,
  height: number,
  quality: number,
): Promise<Buffer> {
  return encodeJpegBuffer(pixels, width, height, quality);
}

/** Bilinear stretch of an interleaved RGB8 buffer, `align_corners=False`. */
function resample8(
  buffer: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const out = new Float32Array(outWidth * outHeight * 3);
  let at = 0;
  for (let oy = 0; oy < outHeight; oy += 1) {
    const [y0, y1, fy] = axis(oy, outHeight, height);
    for (let ox = 0; ox < outWidth; ox += 1) {
      const [x0, x1, fx] = axis(ox, outWidth, width);
      for (let k = 0; k < 3; k += 1) {
        const a = buffer[(y0 * width + x0) * 3 + k] / 255;
        const b = buffer[(y0 * width + x1) * 3 + k] / 255;
        const c = buffer[(y1 * width + x0) * 3 + k] / 255;
        const d = buffer[(y1 * width + x1) * 3 + k] / 255;
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        out[at + k] = top + (bottom - top) * fy;
      }
      at += 3;
    }
  }
  return out;
}

/** Saves the thumbnail as a 16-bit PNG: the exact model input. */
export async function savePng16(thumb: Thumb, path: string): Promise<void> {
  const samples = new Uint16Array(thumb.pixels.length);
  for (let i = 0; i < thumb.pixels.length; i += 1) {
    const value = thumb.pixels[i];
    const clamped = !(value > 0) ? 0 : value > 1 ? 1 : value;
    samples[i] = quantizeU16(clamped);
  }
  writeFileSync(path, await encodePng16(thumb.width, thumb.height, samples));
}

/** Resizes a 16-bit TIFF to `side x side` and returns the model input. */
export function thumbnail(src: string, side: number): Thumb {
  if (!(side > 0)) throw new RangeError("side must be positive");
  return makeThumb(side, side, resampleTiff(src, side, side));
}

function makeThumb(width: number, height: number, pixels: Float32Array): Thumb {
  return thumbOf(width, height, pixels);
}

/** Streams a 16-bit TIFF into an arbitrary output grid. */
export function resampleTiff(src: string, outWidth: number, outHeight: number): Float32Array {
  if (!(outWidth > 0 && outHeight > 0)) throw new RangeError("output must be non-empty");
  const reader = TiffReader.open(src);
  try {
    reader.requireRgb16();
    const rows = new RowReader(reader);
    const { width, height } = reader.info;
    const out = new Float32Array(outWidth * outHeight * 3);
    const row0 = new Uint16Array(width * 3);
    const row1 = new Uint16Array(width * 3);
    let at = 0;

    for (let oy = 0; oy < outHeight; oy += 1) {
      const [y0, y1, fy] = axis(oy, outHeight, height);
      rows.rowInto(y0, row0);
      rows.rowInto(y1, row1);

      for (let ox = 0; ox < outWidth; ox += 1) {
        const [x0, x1, fx] = axis(ox, outWidth, width);
        for (let k = 0; k < 3; k += 1) {
          const a = row0[x0 * 3 + k] / 65535;
          const b = row0[x1 * 3 + k] / 65535;
          const c = row1[x0 * 3 + k] / 65535;
          const d = row1[x1 * 3 + k] / 65535;
          const top = a + (b - a) * fx;
          const bottom = c + (d - c) * fx;
          out[at + k] = top + (bottom - top) * fy;
        }
        at += 3;
      }
    }
    return out;
  } finally {
    reader.close();
  }
}

/**
 * Source index pair and fraction for one output index, matching
 * `align_corners=False`: the pixel centre is mapped, and the index is clamped
 * so the last output pixel never reads past the edge.
 */
export function axis(dstIndex: number, dstSize: number, srcSize: number): [number, number, number] {
  const scale = srcSize / dstSize;
  const mapped = (dstIndex + 0.5) * scale;
  const raw = mapped - 0.5;
  const position = Math.max(0, Math.min(raw, srcSize - 1));
  const i0 = Math.floor(position);
  const i1 = Math.min(i0 + 1, srcSize - 1);
  return [i0, i1, position - i0];
}

/**
 * Row access over chunked TIFF data.
 *
 * Rows are read forward, one chunk at a time, so memory stays at one chunk. A
 * request for a row *behind* the current chunk is allowed: bilinear sampling can
 * ask for row 5 after it has already looked at row 6 (that happens when an image
 * with more than one strip per 256 output rows is upscaled), so the chunk index
 * of every chunk seen so far is remembered and the chunk is re-read rather than
 * assumed unreachable.
 */
class RowReader {
  private readonly reader: TiffReader;
  private nextChunk = 0;
  private samples: Uint16Array = new Uint16Array(0);
  private firstRow = 0;
  private rowCount = 0;
  /** First row of every chunk read so far, indexed by chunk number. */
  private readonly chunkStart: number[] = [];
  private readonly chunkRows: number[] = [];

  constructor(reader: TiffReader) {
    this.reader = reader;
  }

  /** Copies row `y` into `out`. */
  rowInto(y: number, out: Uint16Array): void {
    const { width, height } = this.reader.info;
    if (y >= height) throw ColorfmError.unsupported(`row ${y} out of range`);

    if (y < this.firstRow) this.rewindTo(y);

    while (y >= this.firstRow + this.rowCount) {
      if (this.nextChunk >= this.reader.info.chunkCount) {
        throw ColorfmError.unsupported(`row ${y} is missing`);
      }
      const data = this.reader.readChunk(this.nextChunk);
      const rowSamples = width * 3;
      if (data.length % rowSamples !== 0) {
        throw ColorfmError.unsupported("chunk is not a whole number of rows");
      }
      this.firstRow += this.rowCount;
      this.rowCount = data.length / rowSamples;
      this.samples = data;
      this.chunkStart[this.nextChunk] = this.firstRow;
      this.chunkRows[this.nextChunk] = this.rowCount;
      this.nextChunk += 1;
    }

    const start = (y - this.firstRow) * width * 3;
    out.set(this.samples.subarray(start, start + width * 3));
  }

  /** Loads the chunk that contains `y`, which is behind the current one. */
  private rewindTo(y: number): void {
    for (let index = this.nextChunk - 1; index >= 0; index -= 1) {
      const start = this.chunkStart[index];
      if (start !== undefined && y >= start && y < start + this.chunkRows[index]) {
        this.samples = this.reader.readChunk(index);
        this.firstRow = start;
        this.rowCount = this.chunkRows[index];
        this.nextChunk = index + 1;
        return;
      }
    }
    throw ColorfmError.unsupported(`row ${y} is missing`);
  }
}
