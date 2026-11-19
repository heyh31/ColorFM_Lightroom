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
 * Below this many pixels a band costs more to start than it can save.
 *
 * A worker re-imports the module graph and warms its own JIT; on a thumbnail
 * that start-up is the whole job. 250k pixels keeps a preview on one thread and
 * leaves a real photo well above the floor.
 */
export const MIN_PIXELS_PER_BAND = 250_000;

/**
 * Splits `rowCount` rows into at most `workers` contiguous bands.
 *
 * The first `workers - 1` bands get `floor(rowCount / workers)` rows and the
 * last one takes the remainder, so every row is covered exactly once whatever
 * the numbers are.
 *
 * `width` is optional and only used for the small-image floor: pass it and a
 * frame with fewer than {@link MIN_PIXELS_PER_BAND} per band gets fewer bands.
 */
export function planBands(rowCount: number, workers: number, width = 0): RowBand[] {
  let count = Math.max(1, Math.floor(workers) || 1);
  if (rowCount <= 0) return [];
  if (width > 0) {
    const affordable = Math.floor((rowCount * width) / MIN_PIXELS_PER_BAND);
    count = Math.min(count, Math.max(1, affordable));
  }
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
  return { bands: planBands(layout.height, workers, layout.width), ...layout };
}
