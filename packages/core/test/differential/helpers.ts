/**
 * Shared plumbing for the differential tests.
 *
 * Every test in this folder runs the same input through this port and through
 * the reference implementation, then compares the raw f32 bit patterns. The
 * reference is a small Rust binary under `tools/reference` that links the
 * original library, so the comparison is against the shipped behaviour rather
 * than against a second reading of it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const REFERENCE_BINARY = join(REPO_ROOT, "tools/reference/target/release/colorfm-reference");

/** True when the reference binary has been built. */
export function referenceAvailable(): boolean {
  return existsSync(REFERENCE_BINARY);
}

export const SKIP_WITHOUT_REFERENCE = referenceAvailable()
  ? false
  : "reference binary missing: run `npm run reference:build`";

let scratchRoot: string | undefined;

/** A per-run scratch directory, removed by `cleanupScratch`. */
export function scratch(name: string): string {
  if (!scratchRoot) {
    scratchRoot = mkdtempSync(join(tmpdir(), "colorfm-diff-"));
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

/** Runs one reference command and returns its JSON response. */
export function reference<T = unknown>(command: string, request: unknown): T {
  const dir = scratch("requests");
  const id = `${command}-${Math.random().toString(16).slice(2)}.json`;
  const requestPath = join(dir, id);
  writeFileSync(requestPath, JSON.stringify(request));
  const stdout = execFileSync(REFERENCE_BINARY, [command, requestPath], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

const scratchView = new DataView(new ArrayBuffer(4));

/** The f32 bit pattern of a value, as eight lowercase hex digits. */
export function bitsOf(value: number): string {
  scratchView.setFloat32(0, value);
  return scratchView.getUint32(0).toString(16).padStart(8, "0");
}

/** Bit patterns of an interleaved buffer. */
export function bitsOfAll(values: ArrayLike<number>): string[] {
  const out: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = bitsOf(values[i]);
  return out;
}

/** Reads a value back from its bit pattern. */
export function fromBits(bits: string): number {
  scratchView.setUint32(0, Number.parseInt(bits, 16));
  return scratchView.getFloat32(0);
}

/**
 * Compares two bit arrays and returns a description of the first mismatch,
 * or `undefined` when they are identical.
 */
export function firstDifference(expected: readonly string[], actual: readonly string[]): string | undefined {
  if (expected.length !== actual.length) {
    return `length ${actual.length}, expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) {
      return (
        `index ${i}: ${actual[i]} vs expected ${expected[i]} ` +
        `(${fromBits(actual[i])} vs ${fromBits(expected[i])})`
      );
    }
  }
  return undefined;
}

/** Largest absolute difference between two bit arrays, for tolerance reports. */
export function maxAbsDifference(expected: readonly string[], actual: readonly string[]): number {
  const count = Math.min(expected.length, actual.length);
  let worst = 0;
  for (let i = 0; i < count; i += 1) {
    worst = Math.max(worst, Math.abs(fromBits(actual[i]) - fromBits(expected[i])));
  }
  return worst;
}

/** The 1248 deterministic floats the reference tests use. */
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
        samples.push([
          Math.fround(i / (steps - 1)),
          Math.fround(j / (steps - 1)),
          Math.fround(k / (steps - 1)),
        ]);
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
