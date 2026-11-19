/**
 * Worker entry for one band of rows.
 *
 * A render is split into contiguous runs of rows; each run gets one of these
 * workers, and they all interpolate their own slice of the image at the same
 * time. The destination is already a copy of the source, so a band only ever
 * touches its own byte range — no coordination, no locking, and the bytes come
 * out the same as a single-threaded pass.
 *
 * The module graph this file imports takes tens of milliseconds to load and
 * warm, which is the whole job for a band of a thumbnail. So a worker is
 * reusable: it takes one task from `workerData` when it is spawned that way, and
 * otherwise serves tasks over `message` until the pool closes it.
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

/** A task handed to a pooled worker, tagged so replies can be matched. */
export interface BandRequest {
  readonly id: number;
  readonly task: BandTask;
}

export type BandMessage = { type: "done"; band: RowBand } | { type: "error"; code: string; message: string };

/** A reply from a pooled worker, carrying the request it answers. */
export type BandReply = BandMessage & { id: number };

const port = parentPort;

if (!port) throw new Error("band worker must run as a worker thread");

function cancelToken(cancel?: SharedArrayBuffer): CancelToken {
  const flag = cancel ? new Int32Array(cancel) : undefined;
  return {
    get canceled(): boolean {
      return flag ? Atomics.load(flag, 0) === 1 : false;
    },
  };
}

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

/** Runs one band and returns the message to send back. */
function runTask(task: BandTask): BandMessage {
  try {
    const table = createLut(task.table.size, task.table.data);
    applyLutToRows(task.src, task.dst, task.band, table, cancelToken(task.cancel));
    return { type: "done", band: task.band };
  } catch (error) {
    return errorMessage(error);
  }
}

const initial = workerData as BandTask | undefined;

if (initial && initial.band) {
  // Spawned with a task: run it once and let the thread end.
  port.postMessage(runTask(initial));
} else {
  // Pooled: serve tasks until the pool terminates this worker.
  port.on("message", (request: BandRequest) => {
    port.postMessage({ id: request.id, ...runTask(request.task) } satisfies BandReply);
  });
}
