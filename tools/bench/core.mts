/**
 * Core-level timings for the same two operations the engine leans on: baking a
 * 33³ table and applying it in place.
 *
 * The buffer is the same shape the reference harness uses (8 MP of RGB triples),
 * and the reported value is the minimum of five runs, so the two sides can be
 * compared directly:
 *
 *   npx tsx tools/bench/core.mts
 *   tools/reference/target/release/colorfm-reference bench request.json
 */

import { readFileSync } from "node:fs";

import { applyInPlace, bake, paramsFromSlice } from "@colorfm/core";

const params = paramsFromSlice(
  readFileSync("/tmp/params.txt", "utf8")
    .trim()
    .split(/\s+/)
    .map((value) => Number(value)),
);

const ITERATIONS = Number(process.env.ITERATIONS ?? 5);
const PIXELS = Number(process.env.PIXELS ?? 8_000_000);
const SIZE = Number(process.env.GRID ?? 33);

function bestOf(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// One thread: `bake` is the whole grid, so this is the like-for-like number
// against Rust's single-threaded `bake`.
const bakeMs = bestOf(() => void bake(params, SIZE));
const table = bake(params, SIZE);

const buffer = new Float32Array(PIXELS * 3);
for (let i = 0; i < PIXELS; i += 1) {
  const v = (i % 65536) / 65535;
  buffer[i * 3] = v;
  buffer[i * 3 + 1] = 1 - v * 0.5;
  buffer[i * 3 + 2] = v * 0.25;
}

const applyMs = bestOf(() => applyInPlace(table, buffer));

console.log(
  JSON.stringify(
    {
      size: table.size,
      iterations: ITERATIONS,
      pixels: PIXELS,
      bake_ms: bakeMs,
      apply_ms: applyMs,
      mpx_per_s: PIXELS / (applyMs / 1000) / 1e6,
    },
    null,
    2,
  ),
);
