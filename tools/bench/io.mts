/**
 * Where a 32 MP write-back spends its time: the byte copy, the encode and the
 * disk.
 *
 * The three are reported apart on purpose. `apply` as a single number moves
 * between runs by more than any optimisation changes it — the copy lands in the
 * page cache, the writes are buffered, and the two hide each other. Splitting
 * them makes a change to the arithmetic show up as a change to `encode`.
 *
 *   npx tsx tools/bench/io.mts [--reps 3] [--width 6960] [--height 4640]
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLutWithCancelStrength,
  bake,
  paramsFromSlice,
  prepareCopy,
  type StageTimings,
} from "../../packages/core/src/index.js";
// Test-and-bench-only plumbing, same as the suite uses.
import { Rgb16TiffWriter } from "../../packages/core/src/io/codec/tiff.js";
import { NEVER_CANCELED } from "../../packages/core/src/io/tiff.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const REPS = Number(arg("reps", "3"));
const WIDTH = Number(arg("width", "6960"));
const HEIGHT = Number(arg("height", "4640"));

const scratch = mkdtempSync(join(tmpdir(), "cf-bench-io-"));

function writeSource(path: string): void {
  // One strip for the whole frame, the shape a Lightroom export has.
  const writer = new Rgb16TiffWriter(path, WIDTH, HEIGHT, HEIGHT);
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 3;
      samples[at] = (x * 65535) / (WIDTH - 1);
      samples[at + 1] = (y * 65535) / (HEIGHT - 1);
      samples[at + 2] = (x * 131 + y * 977) % 65536;
    }
  }
  writer.writeStrip(samples);
  writer.finish();
}

const raw: number[] = [];
for (let i = 0; i < 1248; i += 1) raw.push(((i * 37) % 101) / 101 - 0.5);
const params = paramsFromSlice(raw);
const table = bake(params, 33);

const source = join(scratch, "source.tiff");
const copyTarget = join(scratch, "copy.tiff");
const renderTarget = join(scratch, "render.tiff");
writeSource(source);

const bytes = statSync(source).size;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const copies: number[] = [];
const totals: number[] = [];
const encodes: number[] = [];
const writes: number[] = [];

for (let rep = 0; rep < REPS; rep += 1) {
  rmSync(copyTarget, { force: true });
  let started = performance.now();
  prepareCopy(source, copyTarget);
  copies.push(performance.now() - started);

  rmSync(renderTarget, { force: true });
  const timings: StageTimings = { encode: 0, write: 0 };
  started = performance.now();
  applyLutWithCancelStrength(source, renderTarget, table, 0.8, NEVER_CANCELED, timings);
  totals.push(performance.now() - started);
  encodes.push(timings.encode);
  writes.push(timings.write);
}

const mp = (WIDTH * HEIGHT) / 1e6;
const copy = median(copies);
const total = median(totals);
const encode = median(encodes);
const write = median(writes);
const rest = total - encode - write;

console.log(`${WIDTH}x${HEIGHT}, ${(bytes / 1e6).toFixed(0)} MB, ${REPS} runs, median\n`);
console.log(`copy into the destination   ${copy.toFixed(0).padStart(5)} ms`);
console.log(
  `encode (widen+lookup+quant) ${encode.toFixed(0).padStart(5)} ms   ${(mp / (encode / 1000)).toFixed(1)} Mpx/s`,
);
console.log(`write                       ${write.toFixed(0).padStart(5)} ms`);
console.log(`copy + open + scan          ${rest.toFixed(0).padStart(5)} ms`);
console.log(
  `apply end to end            ${total.toFixed(0).padStart(5)} ms   ${(mp / (total / 1000)).toFixed(1)} Mpx/s`,
);

rmSync(scratch, { recursive: true, force: true });
