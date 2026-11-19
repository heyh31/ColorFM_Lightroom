/**
 * Strip-based TIFF transform.
 *
 * The point is bounded memory: an 8K 16-bit RGB image is 199 MB on disk and
 * 398 MB once widened to f32, so nothing here ever holds more than one strip
 * (plus one input chunk) at a time.
 *
 * ```text
 * for each strip:
 *     decode chunk -> u16 -> f32 sRGB
 *     f(&pixels)                 // the LUT or MLP plugs in here
 *     f32 -> u16 -> write strip
 * ```
 *
 * **Metadata**: when the source is plain uncompressed RGB16 — what Lightroom
 * exports for this workflow — the output is a byte copy of the source with only
 * the pixel bytes replaced. EXIF, IPTC, XMP, ICC and the thumbnail all survive
 * untouched, which is also what makes Lightroom sort the result next to the
 * original, since `DateTimeOriginal` is still there. Sources that need a real
 * re-encode (compressed or tiled) fall back to writing a fresh file and lose
 * those tags; {@link ImageInfo.metadataPreserved} reports which path ran.
 */

import { closeSync, copyFileSync, openSync, realpathSync, writeSync } from "node:fs";

import { ColorfmError } from "../error.js";
import { quantizeU16, toUnit } from "../float32.js";
import { Rgb16TiffWriter, TiffReader } from "./codec/tiff.js";

/** Rows per output strip. 64 rows of 8K RGB is about 3 MB of f32 buffer. */
export const DEFAULT_BLOCK_ROWS = 64;

/** What the transform saw, useful for diagnostics. */
export interface ImageInfo {
  width: number;
  height: number;
  bitDepth: number;
  iccProfileBytes: number;
  /**
   * True when the output is a copy of the source with only pixel data
   * replaced, so EXIF / IPTC / XMP / ICC survived. False when the file had to
   * be re-encoded and those tags were dropped.
   */
  metadataPreserved: boolean;
}

/** Cooperative cancellation, checked once per strip. */
export interface CancelToken {
  readonly canceled: boolean;
}

/** A token that is never cancelled. */
export const NEVER_CANCELED: CancelToken = { canceled: false };

/** Pixels of one strip, interleaved RGB, sRGB-encoded, values in `[0,1]`. */
export type StripTransform = {
  (pixels: Float32Array): void;
  /**
   * Optional fused path: transform 16-bit samples in place.
   *
   * When present the caller skips the float buffer entirely — codes are widened,
   * looked up, blended and quantised in one traversal. Only valid for the
   * little-endian uncompressed layout, which the caller checks.
   */
  applyU16?: (samples: Uint16Array) => void;
};

/** A contiguous run of strips: the unit of parallel work. */
/**
 * Streams `src` through `transform` and writes the result to `dst`.
 *
 * Strips are handled in order, so the transform has no dependencies between
 * them and may write in place.
 */
export function transform(
  src: string,
  dst: string,
  stripRows: number,
  transformFn: StripTransform,
): ImageInfo {
  return transformWithCancel(src, dst, stripRows, NEVER_CANCELED, transformFn);
}

/**
 * {@link transform} with a cancellation token, checked once per strip.
 *
 * A cancelled job still leaves a partially written `dst`; callers are expected
 * to delete it. That is the price of not buffering the whole image.
 */
export function transformWithCancel(
  src: string,
  dst: string,
  stripRows: number,
  cancel: CancelToken,
  transformFn: StripTransform,
): ImageInfo {
  if (!(stripRows > 0)) throw new RangeError("stripRows must be positive");
  if (cancel.canceled) throw ColorfmError.canceled();
  if (sameFile(src, dst)) {
    throw ColorfmError.unsupported("source and destination are the same file");
  }

  const reader = TiffReader.open(src);
  try {
    reader.requireRgb16();
    const { width, height } = reader.info;
    const icc = reader.readIccProfile();
    const info: ImageInfo = {
      width,
      height,
      bitDepth: 16,
      iccProfileBytes: icc?.length ?? 0,
      metadataPreserved: false,
    };

    // Preferred path: keep the file, replace the pixels. It depends on being
    // able to copy the source over the destination, which the OS can refuse
    // (file provider, a locked folder, a sandbox). A refused copy is not worth
    // failing the whole render over: `reencode` writes the same graded pixels
    // from scratch, it only loses the tags the copy would have carried.
    const band = fullBand(reader);
    if (band) {
      try {
        prepareCopy(src, dst, reader);
        runRows(src, dst, stripRows, band, cancel, transformFn);
        info.metadataPreserved = true;
        return info;
      } catch (error) {
        if (!(error instanceof ColorfmError) || error.kind !== "io") throw error;
      }
    }

    reencode(dst, reader, stripRows, cancel, icc, transformFn);
    return info;
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// Parallel form
//
// Rows are independent: a band is a contiguous run of rows, and the transform
// never reads a row another band writes. Bands are rows rather than strips
// because a Lightroom export is one strip for the whole frame.
// ---------------------------------------------------------------------------

/** A contiguous run of image rows: the unit of parallel work. */
export interface RowBand {
  /** First row, inclusive. */
  readonly firstRow: number;
  /** Number of rows in the band. */
  readonly rows: number;
}

/** The whole image as one band, when the source can be edited in place. */
function fullBand(reader: TiffReader): RowBand | undefined {
  if (!stripLayout(reader)) return undefined;
  return { firstRow: 0, rows: reader.info.height };
}

/**
 * The shape of `src` if it can be edited in place, `undefined` when it needs a
 * re-encode (compressed, tiled, planar).
 *
 * This is the only question a scheduler has to ask before splitting a file.
 * Splitting itself is the caller's business — see `engine/src/bands.ts`.
 */
export function editableLayout(source: string): { width: number; height: number } | undefined {
  const reader = TiffReader.open(source);
  try {
    reader.requireRgb16();
    if (!stripLayout(reader)) return undefined;
    return { width: reader.info.width, height: reader.info.height };
  } finally {
    reader.close();
  }
}

/** Copies `src` over `dst` once, before any band is applied. */
export function prepareCopy(src: string, dst: string, reader?: TiffReader): void {
  const source = reader ?? TiffReader.open(src);
  try {
    if (!stripLayout(source)) {
      throw ColorfmError.unsupported("source cannot be edited in place");
    }
    copyFile(src, dst);
  } catch (error) {
    if (error instanceof ColorfmError) throw error;
    throw ColorfmError.io(`cannot copy the source into ${dst}: ${(error as Error).message}`, error);
  } finally {
    if (!reader) source.close();
  }
}

/**
 * Transforms one band of rows in place inside `dst`, which must already be a
 * copy of `src`.
 *
 * This is the batch primitive: it does exactly the rows it is given and returns.
 * Running several bands at once — and deciding where the cuts go — belongs to
 * the caller. Bands are safe to overlap in time: every row occupies its own byte
 * range of the file.
 */
export function runRows(
  src: string,
  dst: string,
  blockRows: number,
  band: RowBand,
  cancel: CancelToken,
  transformFn: StripTransform,
): void {
  if (!(blockRows > 0)) throw new RangeError("blockRows must be positive");
  const reader = TiffReader.open(src);
  try {
    const layout = stripLayout(reader);
    if (!layout) throw ColorfmError.unsupported("source cannot be edited in place");
    replaceRows(dst, reader, layout, band, blockRows, cancel, transformFn);
  } finally {
    reader.close();
  }
}

/**
 * Byte copy of the source into the destination.
 *
 * A plain copy is used rather than a clone that also replicates ACLs and
 * extended attributes: those metadata passes are the part the OS can refuse,
 * and the bytes are all this module needs — EXIF, IPTC, XMP, the thumbnail and
 * the ICC profile all live inside them.
 */
function copyFile(src: string, dst: string): void {
  copyFileSync(src, dst);
}

/** True when both paths resolve to the same existing file. */
function sameFile(src: string, dst: string): boolean {
  try {
    return realpathSync(src) === realpathSync(dst);
  } catch {
    return false;
  }
}

/** Where the pixel bytes live in a source we are allowed to edit in place. */
interface StripLayout {
  offsets: number[];
  byteCounts: number[];
  /** First row of each strip, in image coordinates. */
  starts: number[];
  /** Rows in each strip. */
  rows: number[];
  littleEndian: boolean;
}

/**
 * Returns the strip layout only when writing over the source's own bytes is
 * safe: uncompressed, chunky, untiled, no predictor, tightly packed RGB16.
 */
function stripLayout(reader: TiffReader): StripLayout | undefined {
  if (reader.info.compression !== 1) return undefined;
  if (reader.info.planarConfiguration !== 1) return undefined;
  if (reader.info.predictor !== 1) return undefined;
  if (reader.info.tiled) return undefined;

  const offsets = reader.chunkOffsets();
  const byteCounts = reader.chunkByteCounts();
  if (offsets.length === 0 || offsets.length !== byteCounts.length) return undefined;

  // Every strip must be exactly its rows' worth of RGB16 pixels, otherwise the
  // byte count would not match what we write back.
  const { width, height } = reader.info;
  const rowBytes = width * 6;
  const starts: number[] = [];
  const rowsPerStrip: number[] = [];
  let remaining = height;
  let at = 0;
  for (const count of byteCounts) {
    if (remaining === 0) return undefined;
    const rows = Math.min(Math.floor(count / rowBytes), remaining);
    if (rows === 0 || rows * rowBytes !== count) return undefined;
    starts.push(at);
    rowsPerStrip.push(rows);
    at += rows;
    remaining -= rows;
  }
  if (remaining !== 0) return undefined;

  return {
    offsets,
    byteCounts,
    starts,
    rows: rowsPerStrip,
    littleEndian: reader.info.littleEndian,
  };
}

/** Rewrites the pixel bytes of `band` in place inside `dst`. */
function replaceRows(
  dst: string,
  reader: TiffReader,
  layout: StripLayout,
  band: RowBand,
  blockRows: number,
  cancel: CancelToken,
  transformFn: StripTransform,
): void {
  let fd: number;
  try {
    fd = openSync(dst, "r+");
  } catch (error) {
    throw ColorfmError.io(`cannot reopen ${dst}: ${(error as Error).message}`, error);
  }

  const { width } = reader.info;
  const rowSamples = width * 3;
  const rowBytes = rowSamples * 2;
  // Little-endian is the common case and lets the quantised samples be written
  // through a Uint16Array view instead of one Buffer method call per channel.
  const littleEndian = layout.littleEndian;
  const lastRow = band.firstRow + band.rows;
  let strip = 0;
  while (strip + 1 < layout.starts.length && layout.starts[strip + 1] <= band.firstRow) {
    strip += 1;
  }

  let scratch = new Float32Array(0);
  let writeBuffer = Buffer.alloc(0);

  try {
    let row = band.firstRow;
    while (row < lastRow) {
      if (cancel.canceled) throw ColorfmError.canceled();

      while (strip + 1 < layout.starts.length && row >= layout.starts[strip] + layout.rows[strip]) {
        strip += 1;
      }
      const inStrip = row - layout.starts[strip];
      // The block never crosses a strip boundary, so its bytes are contiguous:
      // one read, one transform, one write.
      const take = Math.min(lastRow - row, layout.rows[strip] - inStrip, blockRows);
      const count = take * rowSamples;

      const bytes = reader.readStripBytes(strip, inStrip, take);
      const aligned = littleEndian && bytes.byteOffset % 2 === 0 && bytes.length === count * 2;

      // Fused path: codes in, codes out, one traversal, no float buffer.
      if (transformFn.applyU16 && aligned) {
        const samples = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
        transformFn.applyU16(samples);
        writeFully(
          fd,
          Buffer.from(bytes.buffer, bytes.byteOffset, count * 2),
          layout.offsets[strip] + inStrip * rowBytes,
        );
        row += take;
        continue;
      }

      // One scratch buffer per band: a 64-row block is 5 MB, and allocating it
      // per block would zero 390 MB over a 32 MP frame.
      if (scratch.length < count) scratch = new Float32Array(count);
      const pixels = scratch.subarray(0, count);
      if (aligned) {
        const samples = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
        for (let i = 0; i < count; i += 1) pixels[i] = toUnit(samples[i]);
      } else {
        for (let i = 0; i < count; i += 1) {
          const at = i * 2;
          const value = littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1];
          pixels[i] = toUnit(value);
        }
      }

      transformFn(pixels);

      if (writeBuffer.length < count * 2) writeBuffer = Buffer.allocUnsafe(count * 2);
      const buffer = writeBuffer;
      if (littleEndian) {
        const out = new Uint16Array(buffer.buffer, buffer.byteOffset, count);
        for (let i = 0; i < count; i += 1) out[i] = quantizeU16(pixels[i]);
      } else {
        for (let i = 0; i < count; i += 1) buffer.writeUInt16BE(quantizeU16(pixels[i]), i * 2);
      }
      writeFully(fd, buffer, layout.offsets[strip] + inStrip * rowBytes);

      row += take;
    }
  } finally {
    closeSync(fd);
  }
}

/** Writes the whole buffer, retrying short writes. */
function writeFully(fd: number, buffer: Buffer, position: number): void {
  let done = 0;
  while (done < buffer.length) {
    const written = writeSync(fd, buffer, done, buffer.length - done, position + done);
    if (written <= 0) throw ColorfmError.io("cannot write the destination file");
    done += written;
  }
}

/** Fallback: write a fresh TIFF. Metadata is lost, pixels are exact. */
function reencode(
  dst: string,
  reader: TiffReader,
  stripRows: number,
  cancel: CancelToken,
  icc: Uint8Array | undefined,
  transformFn: StripTransform,
): void {
  const { width, height } = reader.info;
  const writer = new Rgb16TiffWriter(dst, width, height, stripRows, icc);
  const stripPixels = width * stripRows;
  const pending = new Float32Array(stripPixels * 3);
  let filled = 0;

  try {
    for (let index = 0; index < reader.info.chunkCount; index += 1) {
      const samples = reader.readChunk(index);
      if (samples.length % 3 !== 0) {
        throw ColorfmError.unsupported("sample count is not a multiple of 3");
      }

      // Fill one output strip at a time. A single-strip TIFF hands us the whole
      // image in one chunk, so the loop consumes it in slices instead of
      // copying it around.
      let offset = 0;
      while (offset < samples.length) {
        const room = stripPixels - filled;
        const available = Math.floor((samples.length - offset) / 3);
        const take = Math.min(room, available);
        for (let i = 0; i < take * 3; i += 1) {
          pending[filled * 3 + i] = toUnit(samples[offset + i]);
        }
        offset += take * 3;
        filled += take;

        if (filled === stripPixels) {
          if (cancel.canceled) throw ColorfmError.canceled();
          emitStrip(writer, pending, transformFn);
          filled = 0;
        }
      }
    }

    if (filled > 0) {
      if (cancel.canceled) throw ColorfmError.canceled();
      emitStrip(writer, pending.subarray(0, filled * 3), transformFn);
    }
    writer.finish();
  } catch (error) {
    writer.finish();
    throw error;
  }
}

function emitStrip(writer: Rgb16TiffWriter, pixels: Float32Array, transformFn: StripTransform): void {
  const graded = Float32Array.from(pixels);
  transformFn(graded);
  const samples = new Uint16Array(graded.length);
  for (let i = 0; i < graded.length; i += 1) samples[i] = quantizeU16(graded[i]);
  writer.writeStrip(samples);
}
