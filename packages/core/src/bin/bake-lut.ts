#!/usr/bin/env node
/**
 * `bake-lut <params.txt> <out.cube> [grid=33] [--report N]`
 *
 * Development and verification tool: reads 1248 whitespace-separated floats
 * (`content` k1..k4 then `style` k1..k4) and writes an Iridas `.cube`.
 *
 * `--report N` also compares N pseudo-random pixels against direct MLP
 * evaluation, which is how the grid-size decision (33^3 vs 65^3) gets made.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";

import { apply, bake, cube, type Lut3D } from "../lut/index.js";
import { transfer } from "../mlp.js";
import { paramsFromSlice, type Params } from "../params.js";

/** Deterministic 64-bit xorshift, so the reported error is reproducible. */
class XorShift {
  private state: bigint;
  private readonly mask = (1n << 64n) - 1n;

  constructor(seed: bigint) {
    this.state = seed;
  }

  nextU32(): number {
    let x = this.state;
    x ^= (x << 13n) & this.mask;
    x ^= x >> 7n;
    x ^= (x << 17n) & this.mask;
    this.state = x & this.mask;
    return Number((x >> 32n) & 0xffffffffn);
  }

  nextF32(): number {
    return Math.fround(this.nextU32() / 4294967295);
  }
}

function maxInterpolationError(params: Params, table: Lut3D, samples: number): number {
  const rng = new XorShift(0x9e3779b97f4a7c15n);
  let worst = 0;
  for (let i = 0; i < samples; i += 1) {
    const rgb: [number, number, number] = [rng.nextF32(), rng.nextF32(), rng.nextF32()];
    const exact = transfer(params, rgb);
    const approx = apply(table, rgb);
    for (let k = 0; k < 3; k += 1) {
      worst = Math.max(worst, Math.abs(exact[k] - approx[k]));
    }
  }
  return worst;
}

function reportSamples(args: string[]): number | undefined {
  const at = args.indexOf("--report");
  if (at < 0) return undefined;
  const value = Number.parseInt(args[at + 1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function run(args: string[]): string {
  const text = readFileSync(args[0], "utf8");
  const values = text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => Number(token));
  const params = paramsFromSlice(values);

  const grid = args[2] !== undefined ? Number.parseInt(args[2], 10) : 33;
  const table = bake(params, grid);

  writeFileSync(args[1], cube.write(table, "ColorFM"));
  const bytes = statSync(args[1]).size;

  let message = `wrote ${args[1]} (${grid}^3 = ${table.data.length / 3} entries, ${bytes} bytes)`;
  const n = reportSamples(args);
  if (n !== undefined) {
    const worst = maxInterpolationError(params, table, n);
    message += `\nmax |lut - direct| over ${n} samples: ${worst.toExponential(3)}  (1/255 = 3.922e-03)`;
  }
  return message;
}

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bake-lut <params.txt> <out.cube> [grid=33] [--report N]");
  process.exit(2);
}

try {
  console.log(run(argv));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
