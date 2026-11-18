/**
 * Worker entry point for the pixel work.
 *
 * Baking a LUT and streaming a 45 MP TIFF take seconds; keeping them
 * off the HTTP thread is what lets the UI keep polling job status while a render
 * runs. The main thread keeps the model session and all file bookkeeping; this
 * worker only does arithmetic it is handed.
 *
 * Tasks arrive as `workerData`, progress goes back as `stage` messages, and the
 * outcome is one `done` or `error` message. Cancellation is a shared flag the
 * main thread flips, polled per strip.
 */

import { writeFileSync } from "node:fs";
import { parentPort, workerData, Worker } from "node:worker_threads";

import {
  applyInPlace,
  applyDirectWithCancelStrength,
  applyLutWithCancel,
  bake,
  ColorfmError,
  cube,
  DEFAULT_BLOCK_ROWS,
  encodeJpeg,
  paramsFromSlice,
  prepareCopy,
  preview as previewImage,
  thumbnailAny,
  type CancelToken,
  type Lut3D,
  type Params,
  type RowBand,
} from "@colorfm/core";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BandMessage, BandTask } from "./transform-worker.js";

/** A baked table in the form it travels between threads. */
export interface FlatTable {
  readonly size: number;
  readonly data: Float32Array;
}

/** Tasks this worker understands. */
export type WorkerTask =
  | { kind: "thumbs"; content: string; style?: string; side: number }
  | {
      kind: "render";
      src: string;
      dst: string;
      params: Float32Array;
      grid: number;
      strength: number;
      direct: boolean;
      /** Present when the main thread still has the table from a previous job. */
      table?: FlatTable;
      /**
       * Row bands planned by the main thread. Absent when the source needs a
       * re-encode or only one worker is allowed.
       */
      plan?: {
        bands: RowBand[];
        width: number;
        height: number;
      };
    }
  | {
      kind: "preview";
      src: string;
      style?: string;
      params: Float32Array;
      grid: number;
      strength: number;
      maxEdge: number;
      quality: number;
      table?: FlatTable;
    }
  | { kind: "bake-lut"; params: Float32Array; grid: number; out: string };

/** Progress or completion, as seen from the main thread. */
export type WorkerMessage =
  | { type: "stage"; stage: string; pct: number }
  | { type: "done"; result: unknown; table?: FlatTable }
  | { type: "error"; code: string; message: string };

interface Envelope {
  task: WorkerTask;
  cancel?: SharedArrayBuffer;
}

const envelope = workerData as Envelope;
const port = parentPort;

if (!port) throw new Error("job worker must run as a worker thread");

/** Cancellation flag shared with the main thread. */
const cancelFlag = envelope.cancel ? new Int32Array(envelope.cancel) : undefined;
const cancel: CancelToken = {
  get canceled(): boolean {
    return cancelFlag ? Atomics.load(cancelFlag, 0) === 1 : false;
  },
};

function report(stage: string, pct: number): void {
  port?.postMessage({ type: "stage", stage, pct } satisfies WorkerMessage);
}

/**
 * Resolves a worker entry next to this module.
 *
 * Written out here rather than shared with the HTTP side: this module may run
 * from `dist/*.js` or from `src/*.ts` under a TypeScript loader, and the
 * loader does not necessarily remap a sibling `./x.js` specifier back to `x.ts`.
 * Looking the file up and handing the worker its path avoids the question.
 */
function entryFor(name: string): { url: URL; execArgv?: string[] } {
  const compiled = new URL(`./${name}.js`, import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled };
  return {
    url: new URL(`./${name}.ts`, import.meta.url),
    execArgv: ["--import", "tsx"],
  };
}

/**
 * Runs one band per worker and waits for all of them.
 *
 * A failure cancels the siblings: the destination is a copy that will be
 * overwritten by the next attempt, and leaving half the bands running would
 * only burn cores on a render nobody is waiting for.
 */
async function runBands(
  src: string,
  dst: string,
  bands: readonly RowBand[],
  table: Lut3D,
  cancelBuffer: SharedArrayBuffer | undefined,
): Promise<void> {
  const entry = entryFor("transform-worker");
  let finished = 0;
  const running: Worker[] = [];

  const failed = (index: number): void => {
    for (let other = 0; other < running.length; other += 1) {
      const sibling = running[other];
      if (other !== index && sibling) void sibling.terminate();
    }
  };

  try {
    await Promise.all(
      bands.map(
        (band, index) =>
          new Promise<void>((resolve, reject) => {
            const task: BandTask = {
              src,
              dst,
              blockRows: DEFAULT_BLOCK_ROWS,
              band,
              table: { size: table.size, data: table.data },
              ...(cancelBuffer ? { cancel: cancelBuffer } : {}),
            };
            const worker = new Worker(entry.url, {
              workerData: task,
              ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
            });
            running[index] = worker;

            let settled = false;
            const finish = (action: () => void): void => {
              if (settled) return;
              settled = true;
              void worker.terminate().then(action, action);
            };

            worker.on("message", (message: BandMessage) => {
              if (message.type === "done") {
                finished += 1;
                report("apply", 55 + Math.round((35 * finished) / bands.length));
                finish(resolve);
                return;
              }
              failed(index);
              finish(() => reject(new ColorfmError("io", message.message)));
            });
            worker.on("error", (error) => {
              failed(index);
              finish(() => reject(error));
            });
            worker.on("exit", (code) => {
              // A worker we terminated ourselves exits with 1; only an
              // unexpected exit means the band never finished.
              if (settled) return;
              if (code !== 0) {
                failed(index);
                finish(() => reject(new Error(`band worker exited with ${code}`)));
              } else {
                failed(index);
                finish(() => reject(new Error("band worker exited without a result")));
              }
            });
          }),
      ),
    );
  } finally {
    for (const worker of running) void worker.terminate();
  }
}

function canceled(): Error {
  const error = new Error("canceled by request");
  error.name = "Canceled";
  return error;
}

/**
 * The table for this job, baked or handed over by the main thread.
 *
 * Every preview and render of the same parameters wants the same table, so the
 * result is reported back for the next job to reuse.
 */
function tableFor(params: Params, grid: number, strength: number, provided?: FlatTable): Lut3D {
  if (provided && provided.size === grid) {
    return { size: provided.size, data: provided.data };
  }
  const table = bake(params, grid, strength);
  bakedTable = { size: table.size, data: table.data };
  return table;
}

/** Table this job baked, echoed to the main thread so it can be cached. */
let bakedTable: FlatTable | undefined;

async function run(task: WorkerTask): Promise<unknown> {
  switch (task.kind) {
    case "thumbs": {
      const content = await thumbnailAny(task.content, task.side);
      const style = task.style ? await thumbnailAny(task.style, task.side) : undefined;
      return {
        content: { width: content.width, height: content.height, pixels: content.pixels },
        style: style ? { width: style.width, height: style.height, pixels: style.pixels } : undefined,
      };
    }

    case "render": {
      const params = paramsFromSlice(task.params);
      report("bake", 45);
      const table = tableFor(params, task.grid, task.strength, task.table);
      if (cancel.canceled) throw canceled();

      report("apply", 55);
      if (task.direct) {
        const info = applyDirectWithCancelStrength(task.src, task.dst, params, task.strength, cancel);
        return { width: info.width, height: info.height, metadataPreserved: info.metadataPreserved };
      }

      // The pixel ranges of an in-place source are independent, so the frame is
      // split into one band per worker. Sources that need a re-encode are
      // streamed on this thread instead, since the writer is sequential.
      const planned = task.plan;
      if (planned && planned.bands.length > 1) {
        try {
          prepareCopy(task.src, task.dst);
        } catch (error) {
          if (error instanceof ColorfmError && error.kind === "io") {
            // The copy was refused; the sequential path can still re-encode.
            const info = applyLutWithCancel(task.src, task.dst, table, cancel);
            return { width: info.width, height: info.height, metadataPreserved: info.metadataPreserved };
          }
          throw error;
        }
        await runBands(task.src, task.dst, planned.bands, table, envelope.cancel);
        return {
          width: planned.width,
          height: planned.height,
          metadataPreserved: true,
        };
      }

      const info = applyLutWithCancel(task.src, task.dst, table, cancel);
      return { width: info.width, height: info.height, metadataPreserved: info.metadataPreserved };
    }

    case "preview": {
      const params = paramsFromSlice(task.params);
      report("bake", 45);
      // The strength is baked into the table, so the preview applies it exactly
      // the way the render will.
      const table = tableFor(params, task.grid, task.strength, task.table);
      if (cancel.canceled) throw canceled();

      report("preview", 55);
      const before = await previewImage(task.src, task.maxEdge);
      const after = Float32Array.from(before.pixels);
      applyInPlace(table, after);
      if (cancel.canceled) throw canceled();

      let style: { width: number; height: number; jpeg: Uint8Array } | undefined;
      if (task.style) {
        const reference = await previewImage(task.style, task.maxEdge);
        style = {
          width: reference.width,
          height: reference.height,
          jpeg: await encodeJpeg(reference.pixels, reference.width, reference.height, task.quality),
        };
      }

      report("encode", 85);
      const contentJpeg = await encodeJpeg(before.pixels, before.width, before.height, task.quality);
      const resultJpeg = await encodeJpeg(after, before.width, before.height, task.quality);
      return {
        width: before.width,
        height: before.height,
        contentJpeg,
        resultJpeg,
        styleJpeg: style?.jpeg,
        styleWidth: style?.width,
        styleHeight: style?.height,
      };
    }

    case "bake-lut": {
      const params = paramsFromSlice(task.params);
      const table = bake(params, task.grid);
      if (cancel.canceled) throw canceled();
      writeFileSync(task.out, cube.write(table, "ColorFM"));
      return { entries: table.data.length / 3 };
    }

    default: {
      const never: never = task;
      throw new Error(`unknown task: ${JSON.stringify(never)}`);
    }
  }
}

function failureMessage(error: unknown): WorkerMessage {
  if (error instanceof Error && error.name === "Canceled") {
    return { type: "error", code: "E_CANCELED", message: "canceled by request" };
  }
  if (error instanceof ColorfmError) {
    const code =
      error.kind === "canceled"
        ? "E_CANCELED"
        : error.kind === "unsupported"
          ? "E_UNSUPPORTED"
          : error.kind === "tiff" || error.kind === "io"
            ? "E_IO"
            : "E_BAD_REQUEST";
    return { type: "error", code, message: error.message };
  }
  return {
    type: "error",
    code: "E_INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

void run(envelope.task).then(
  (result) =>
    port.postMessage({
      type: "done",
      result,
      ...(bakedTable ? { table: bakedTable } : {}),
    } satisfies WorkerMessage),
  (error: unknown) => port.postMessage(failureMessage(error)),
);
