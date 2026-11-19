/**
 * Shared plumbing for the tests.
 *
 * Fixtures are written by the library's own TIFF writer, and every comparison
 * is between two paths through this code — the batch evaluator against the
 * per-pixel one, a banded render against a sequential one. There is no external
 * reference to compare against; these numbers are the standard.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Rgb16TiffWriter } from "../src/io/codec/tiff.js";

let scratchRoot: string | undefined;

/** A per-run scratch directory, removed by `cleanupScratch`. */
export function scratch(name: string): string {
  if (!scratchRoot) {
    scratchRoot = mkdtempSync(join(tmpdir(), "colorfm-test-"));
  }
  const dir = join(scratchRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupScratch(): void {
  if (scratchRoot) {
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  }
}

/** How a fixture's pixels are generated. */
export type FixtureKind = "ramp" | "wide" | "random";

/**
 * Writes an uncompressed RGB16 TIFF to use as a source.
 *
 * `rowsPerStrip` defaults to four strips, enough to exercise the strip
 * bookkeeping; pass `height` for the single-strip shape Lightroom uses.
 */
export function makeTiff(
  path: string,
  options: { width: number; height: number; kind?: FixtureKind; rowsPerStrip?: number },
): void {
  const { width, height, kind = "ramp" } = options;
  const rowsPerStrip = options.rowsPerStrip ?? Math.max(1, Math.ceil(height / 4));
  const writer = new Rgb16TiffWriter(path, width, height, rowsPerStrip);

  for (let first = 0; first < height; first += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - first);
    const samples = new Uint16Array(rows * width * 3);
    for (let r = 0; r < rows; r += 1) {
      const y = first + r;
      for (let x = 0; x < width; x += 1) {
        const at = (r * width + x) * 3;
        if (kind === "ramp") {
          samples[at] = Math.round((x * 65535) / Math.max(1, width - 1));
          samples[at + 1] = Math.round((y * 65535) / Math.max(1, height - 1));
          samples[at + 2] = Math.round((((x + y) % width) * 65535) / Math.max(1, width - 1));
        } else if (kind === "wide") {
          samples[at] = (x * 131 + y * 977) % 65536;
          samples[at + 1] = (x * 4099 + y * 61) % 65536;
          samples[at + 2] = (x * 257 + y * 6553) % 65536;
        } else {
          samples[at] = (((x + 1) * 2654435761) >>> 16) & 0xffff;
          samples[at + 1] = ((y + 7) * 40503) % 65536;
          samples[at + 2] = (x * y * 97) % 65536;
        }
      }
    }
    writer.writeStrip(samples);
  }
  writer.finish();
}

const scratchView = new DataView(new ArrayBuffer(8));

/** The f64 bit pattern of a value, as sixteen hex digits. */
export function bitsOf(value: number): string {
  scratchView.setFloat64(0, value);
  return scratchView.getBigUint64(0).toString(16).padStart(16, "0");
}

/** Bit patterns of an interleaved buffer. */
export function bitsOfAll(values: ArrayLike<number>): string[] {
  const out: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = bitsOf(values[i]);
  return out;
}

/**
 * Compares two bit arrays and returns a description of the first mismatch, or
 * `undefined` when they are identical.
 */
export function firstDifference(expected: readonly string[], actual: readonly string[]): string | undefined {
  if (expected.length !== actual.length) {
    return `length ${actual.length}, expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) return `index ${i}: ${actual[i]} vs expected ${expected[i]}`;
  }
  return undefined;
}

/** Largest absolute difference between two sample arrays, in their own units. */
export function maxAbsDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const count = Math.min(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < count; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

/** The 1248 deterministic floats the tests share. */
export function deterministicParams(scale = 101, mulBy = 37): number[] {
  const values: number[] = [];
  for (let i = 0; i < 1248; i += 1) {
    values.push(Math.fround(((i * mulBy) % scale) / scale - 0.5));
  }
  return values;
}

/** A grid of sample colours that covers the cube including its edges. */
export function sampleGrid(steps: number): Array<[number, number, number]> {
  const samples: Array<[number, number, number]> = [];
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      for (let k = 0; k < steps; k += 1) {
        samples.push([i / (steps - 1), j / (steps - 1), k / (steps - 1)]);
      }
    }
  }
  return samples;
}

/** Reads a file as bytes. */
export function readBytes(path: string): Uint8Array {
  const buffer = readFileSync(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
