/**
 * Where the cuts go.
 *
 * Splitting a frame across threads is a scheduling decision, so it lives in the
 * engine. The library answers one question — how many rows can be edited in
 * place — and this module turns that into contiguous bands.
 */

import { availableParallelism } from "node:os";

import { editableLayout, type RowBand } from "@colorfm/core";

/**
 * How many workers a render may use.
 *
 * One core is left for the HTTP thread; past eight, memory bandwidth saturates
 * and extra workers stop paying.
 */
export function renderWorkerCount(): number {
  const override = process.env.COLORFM_WORKERS;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed)) return Math.min(8, Math.max(1, parsed));
  }
  return Math.min(8, Math.max(1, availableParallelism() - 1));
}

/**
 * Splits `rowCount` rows into at most `workers` contiguous bands.
 *
 * The first `workers - 1` bands get `floor(rowCount / workers)` rows and the
 * last one takes the remainder, so every row is covered exactly once whatever
 * the numbers are.
 */
export function planBands(rowCount: number, workers: number): RowBand[] {
  const count = Math.max(1, Math.floor(workers) || 1);
  if (rowCount <= 0) return [];
  const per = Math.floor(rowCount / count);
  if (per === 0) {
    // More workers than rows: one band per row, no empty bands.
    return Array.from({ length: rowCount }, (_, index) => ({ firstRow: index, rows: 1 }));
  }
  const bands: RowBand[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    bands.push({ firstRow: index * per, rows: per });
  }
  bands.push({ firstRow: (count - 1) * per, rows: rowCount - (count - 1) * per });
  return bands;
}

/**
 * Bands for `src`, or `undefined` when the source needs a re-encode and has to
 * be streamed on one thread.
 */
export function planRenderBands(
  src: string,
  workers: number,
): { bands: RowBand[]; width: number; height: number } | undefined {
  const layout = editableLayout(src);
  if (!layout) return undefined;
  return { bands: planBands(layout.height, workers), ...layout };
}
