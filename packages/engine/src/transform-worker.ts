/**
 * Worker entry for one band of rows.
 *
 * A render is split into contiguous runs of rows; each run gets one of these
 * workers, and they all interpolate their own slice of the image at the same
 * time. The destination is already a copy of the source, so a band only ever
 * touches its own byte range — no coordination, no locking, and the bytes come
 * out the same as a single-threaded pass.
 *
 * The worker owns nothing but the call: the library applies a table to a row
 * range, and that is exactly the primitive used here.
 */

import { parentPort, workerData } from "node:worker_threads";

import { applyLutToRows, ColorfmError, createLut, type CancelToken, type RowBand } from "@colorfm/core";

export interface BandTask {
  readonly src: string;
  readonly dst: string;
  readonly blockRows: number;
  readonly band: RowBand;
  /** Grid size and flattened table, so the band does not re-bake it. */
  readonly table: { readonly size: number; readonly data: Float32Array };
  readonly cancel?: SharedArrayBuffer;
}

export type BandMessage = { type: "done"; band: RowBand } | { type: "error"; code: string; message: string };

const task = workerData as BandTask;
const port = parentPort;

if (!port) throw new Error("band worker must run as a worker thread");

const cancelFlag = task.cancel ? new Int32Array(task.cancel) : undefined;
const cancel: CancelToken = {
  get canceled(): boolean {
    return cancelFlag ? Atomics.load(cancelFlag, 0) === 1 : false;
  },
};

function errorMessage(error: unknown): BandMessage {
  if (error instanceof Error && error.name === "Canceled") {
    return { type: "error", code: "E_CANCELED", message: "canceled by request" };
  }
  if (error instanceof ColorfmError) {
    const code =
      error.kind === "unsupported" ? "E_UNSUPPORTED" : error.kind === "canceled" ? "E_CANCELED" : "E_IO";
    return { type: "error", code, message: error.message };
  }
  return {
    type: "error",
    code: "E_INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

try {
  const table = createLut(task.table.size, task.table.data);
  applyLutToRows(task.src, task.dst, task.band, table, cancel);
  port.postMessage({ type: "done", band: task.band } satisfies BandMessage);
} catch (error) {
  port.postMessage(errorMessage(error));
}
