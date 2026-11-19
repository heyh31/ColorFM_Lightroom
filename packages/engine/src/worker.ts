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

import type { BandReply, BandRequest, BandTask } from "./transform-worker.js";

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
  | { type: "stage"; id: number; stage: string; pct: number }
  | { type: "done"; id: number; result: unknown; table?: FlatTable }
  | { type: "error"; id: number; code: string; message: string };

interface Envelope {
  task: WorkerTask;
  cancel?: SharedArrayBuffer;
}

/** A task handed to a resident worker, tagged so replies can be matched. */
export interface JobRequest {
  readonly id: number;
  readonly task: WorkerTask;
  readonly cancel?: SharedArrayBuffer;
}

const port = parentPort;

if (!port) throw new Error("job worker must run as a worker thread");

/**
 * Cancellation flag for the task in flight.
 *
 * Reassigned per task because this worker may serve several: the flag belongs to
 * the job, the thread does not.
 */
let cancelFlag: Int32Array | undefined;
let currentCancel: SharedArrayBuffer | undefined;
let currentId = 0;
const cancel: CancelToken = {
  get canceled(): boolean {
    return cancelFlag ? Atomics.load(cancelFlag, 0) === 1 : false;
  },
};

function report(stage: string, pct: number): void {
  port?.postMessage({ type: "stage", id: currentId, stage, pct });
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
 * The workers come from a pool that outlives the job: their module load and JIT
 * warm-up is around 250 ms for eight of them on a 32 MP frame, which is half the
 * apply stage. A failure retires the workers that were in flight — a cancelled
 * band stops mid-strip, and the state it leaves behind is not handed to the next
 * job.
 *
 * Renders are serialised through `serialRender` so two jobs cannot each take
 * eight workers and oversubscribe the cores.
 */
async function runBands(
  src: string,
  dst: string,
  bands: readonly RowBand[],
  table: Lut3D,
  cancelBuffer: SharedArrayBuffer | undefined,
): Promise<void> {
  const tasks: BandTask[] = bands.map((band) => ({
    src,
    dst,
    blockRows: DEFAULT_BLOCK_ROWS,
    band,
    table: { size: table.size, data: table.data },
    ...(cancelBuffer ? { cancel: cancelBuffer } : {}),
  }));

  await serialRender(() =>
    pool().run(tasks, (finished) => {
      report("apply", 55 + Math.round((35 * finished) / bands.length));
    }),
  );
}

/**
 * A pool of band workers.
 *
 * Each worker loads the whole library and warms its own JIT; on a 32 MP frame
 * that start-up is around 250 ms for eight of them, which is half the apply
 * stage. Keeping them alive makes that a per-process cost instead of a
 * per-render one, and the pixels are identical either way — a band only touches
 * its own rows.
 *
 * Two rules make reuse safe: one task at a time per worker (a task is posted
 * with an id and the reply must carry it), and a failed or cancelled task
 * retires its worker, so nothing half-transformed is handed to the next job.
 *
 * Idle workers are `unref`ed, so a pool that is never used again cannot keep the
 * engine process alive.
 */
class BandPool {
  readonly #entry: { url: URL; execArgv?: string[] };
  readonly #idle: Worker[] = [];
  readonly #busy = new Set<Worker>();
  #nextId = 1;
  #closed = false;

  constructor(entry: { url: URL; execArgv?: string[] }) {
    this.#entry = entry;
  }

  /**
   * Runs every task, one per worker, and resolves when all have finished.
   *
   * `onDone` is called as each band completes, so the caller can report
   * progress. A rejection retires every worker that was in flight.
   */
  async run(tasks: readonly BandTask[], onDone?: (finished: number) => void): Promise<void> {
    if (this.#closed) throw new Error("band pool is closed");
    if (tasks.length === 0) return;

    const workers = tasks.map(() => this.#take());
    let finished = 0;
    try {
      await Promise.all(
        tasks.map(async (task, index) => {
          const worker = workers[index];
          await this.#dispatch(worker, task);
          finished += 1;
          onDone?.(finished);
          this.#release(worker);
        }),
      );
    } catch (error) {
      for (const worker of workers) this.#discard(worker);
      throw error;
    }
  }

  /** Terminates every worker the pool owns. */
  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#idle, ...this.#busy];
    this.#idle.length = 0;
    this.#busy.clear();
    await Promise.all(all.map((worker) => worker.terminate().then(noop, noop)));
  }

  #take(): Worker {
    const idle = this.#idle.pop();
    if (idle) {
      idle.ref();
      this.#busy.add(idle);
      return idle;
    }
    const worker = new Worker(this.#entry.url, {
      ...(this.#entry.execArgv ? { execArgv: this.#entry.execArgv } : {}),
    });
    this.#busy.add(worker);
    return worker;
  }

  #release(worker: Worker): void {
    if (!this.#busy.delete(worker)) return;
    if (this.#closed) {
      void worker.terminate();
      return;
    }
    // Not `unref` while a task is in flight: the reply must still be delivered.
    worker.unref();
    this.#idle.push(worker);
  }

  #discard(worker: Worker): void {
    this.#busy.delete(worker);
    const at = this.#idle.indexOf(worker);
    if (at >= 0) this.#idle.splice(at, 1);
    void worker.terminate().then(noop, noop);
  }

  #dispatch(worker: Worker, task: BandTask): Promise<void> {
    const id = this.#nextId++;
    return new Promise<void>((resolve, reject) => {
      const settle = (action: () => void): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        action();
      };
      const onMessage = (message: BandReply): void => {
        if (message.id !== id) {
          settle(() => reject(new Error(`band worker replied to ${message.id}, expected ${id}`)));
          return;
        }
        if (message.type === "done") settle(resolve);
        else settle(() => reject(new Error(message.message)));
      };
      const onError = (error: Error): void => settle(() => reject(error));
      const onExit = (code: number): void =>
        settle(() => reject(new Error(`band worker exited with ${code}`)));

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage({ id, task } satisfies BandRequest);
    });
  }
}

function noop(): void {}

/** The pool this job worker lends its renders; created on first use. */
function pool(): BandPool {
  bandPool ??= new BandPool(entryFor("transform-worker"));
  return bandPool;
}

/**
 * Runs one render at a time.
 *
 * Every render wants every core, so overlapping them would only add context
 * switches: the second render waits for the first instead of splitting the
 * machine with it.
 */
function serialRender<T>(work: () => Promise<T>): Promise<T> {
  const next = renderGate.then(work, work);
  renderGate = next.catch(() => undefined);
  return next;
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

/** Band workers, reused across the renders this job worker serves. */
let bandPool: BandPool | undefined;
/** Tail of the render queue; see `serialRender`. */
let renderGate: Promise<unknown> = Promise.resolve();

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
        await runBands(task.src, task.dst, planned.bands, table, currentCancel);
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

function failureMessage(error: unknown): { type: "error"; code: string; message: string } {
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

/** Runs one task and reports it back under the id it arrived with. */
async function handle(request: JobRequest): Promise<void> {
  currentId = request.id;
  currentCancel = request.cancel;
  cancelFlag = request.cancel ? new Int32Array(request.cancel) : undefined;
  bakedTable = undefined;
  try {
    const result = await run(request.task);
    port?.postMessage({
      id: request.id,
      type: "done",
      result,
      ...(bakedTable ? { table: bakedTable } : {}),
    });
  } catch (error) {
    port?.postMessage({ id: request.id, ...failureMessage(error) });
  }
}

const initial = workerData as Envelope | undefined;

if (initial && initial.task) {
  // Spawned with a task: serve it once and let the thread end.
  currentCancel = initial.cancel;
  void handle({ id: 0, task: initial.task, ...(initial.cancel ? { cancel: initial.cancel } : {}) });
} else {
  // Resident: serve tasks until the main thread terminates this worker.
  port.on("message", (request: JobRequest) => void handle(request));
}
