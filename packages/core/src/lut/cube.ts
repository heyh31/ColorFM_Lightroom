/**
 * Iridas `.cube` read/write.
 *
 * Written values use six decimals and the usual `TITLE / LUT_3D_SIZE /
 * DOMAIN_MIN / DOMAIN_MAX` header, so the file can be diffed against other
 * bakers line by line.
 */

import { ColorfmError } from "../error.js";
import { createLut, lutEntries, type Lut3D } from "./table.js";

/** Serialises a table. One entry per line, red varying fastest. */
export function write(lut: Lut3D, title: string): string {
  const lines: string[] = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
    "DOMAIN_MIN 0 0 0",
    "DOMAIN_MAX 1 1 1",
  ];
  const data = lut.data;
  for (let i = 0; i < data.length; i += 3) {
    lines.push(`${format6(data[i])} ${format6(data[i + 1])} ${format6(data[i + 2])}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Minimal parser: headers, comments and blank lines are accepted, only 3D
 * LUTs are understood.
 */
export function read(text: string): Lut3D {
  let size: number | undefined;
  const values: number[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE") || upper.startsWith("DOMAIN")) continue;
    if (upper.startsWith("LUT_3D_SIZE")) {
      const token = line.split(/\s+/)[1];
      const parsed = token === undefined ? Number.NaN : Number.parseInt(token, 10);
      size = Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined;
      continue;
    }

    let count = 0;
    for (const token of line.split(/\s+/)) {
      if (count === 3) break;
      const value = Number(token);
      if (!Number.isFinite(value) && !token.toLowerCase().includes("inf") && token.toLowerCase() !== "nan") {
        throw ColorfmError.badCube(`bad value ${JSON.stringify(token)}`);
      }
      values.push(Math.fround(value));
      count += 1;
    }
    if (count !== 3) {
      throw ColorfmError.badCube(`expected 3 values, got ${count}`);
    }
  }

  if (size === undefined) throw ColorfmError.badCube("missing LUT_3D_SIZE");
  const expected = lutEntries(size);
  if (values.length / 3 !== expected) {
    throw ColorfmError.badCube(`${values.length / 3} entries, expected ${expected} for size ${size}`);
  }
  return createLut(size, Float32Array.from(values));
}

/**
 * Six-decimal formatting that keeps a leading minus for values that round to
 * zero, so a `-0.000000` entry stays distinguishable.
 */
function format6(value: number): string {
  const text = value.toFixed(6);
  if (text === "0.000000" && (Object.is(value, -0) || value < 0)) return "-0.000000";
  return text;
}
