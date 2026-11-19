/**
 * Job queue and execution.
 *
 * One job = one file transformation. The record lives in memory and is polled
 * by id; the pixel work happens in a worker thread so the HTTP surface stays
 * responsive, and cancellation is a shared flag the worker polls per strip.
 */

import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { INPUT_SIZE, paramsFromSlice, paramsIntoBuffer, type Params, type Thumb } from "@colorfm/core";

import { planRenderBands, renderWorkerCount } from "./bands.js";
import type { JobRequest } from "./worker.js";
import { EngineError, type WireError } from "./errors.js";
import type { App } from "./state.js";
import { settle } from "./session.js";
import { thumbKey } from "./store.js";
import type { FlatTable, WorkerMessage, WorkerTask } from "./worker.js";
import { workerEntry } from "./worker-entry.js";

/** Upper end of the strength slider: 1.0 is the look as modelled. */
export const MAX_STRENGTH = 2;

/** JPEG quality for UI previews: high enough to judge a grade on. */
export const PREVIEW_JPEG_QUALITY = 95;

/** Long edge used by the interactive workspace previews. */
export const PREVIEW_MAX_EDGE = 1280;

/** What a caller can ask for. */
export interface CreateJob {
  kind: string;
  content?: string;
  style?: string;
  params?: string;
  out?: string;
  grid?: number;
  direct?: boolean;
  /**
   * 0..2, blended toward identity before the LUT is applied. Preview and render
   * use the same maths, so what is judged on screen is what gets written.
   */
  strength?: number;
  max_edge?: number;
}

export type JobState = "queued" | "running" | "done" | "error" | "canceled";

/** A job record as clients see it. */
export interface Job {
  id: string;
  kind: string;
  state: JobState;
  stage: string;
  pct: number;
  error?: WireError;
  result?: unknown;
  /** Cooperative cancellation flag, shared with the worker. */
  readonly cancel: Int32Array;
}

/** Registers the job and starts it. */
export function spawn(app: App, request: CreateJob): string {
  return spawnWithId(app, app.nextJobId(), request);
}

/**
 * Registers a job under an id the caller reserved. Session endpoints take the
 * id first, write it into the session, and only then start the work — a fast
 * job must not finish before its session knows what to wait for.
 */
export function spawnWithId(app: App, id: string, request: CreateJob): string {
  const cancelBuffer = new SharedArrayBuffer(4);
  const cancel = new Int32Array(cancelBuffer);
  const job: Job = {
    id,
    kind: request.kind,
    state: "queued",
    stage: "queued",
    pct: 0,
    cancel,
  };
  app.jobs.set(id, job);

  void runJob(app, id, request, cancel, cancelBuffer).catch((error: unknown) => {
    console.error(`warning: job ${id} crashed: ${(error as Error).message}`);
  });
  return id;
}

function update(app: App, id: string, mutate: (job: Job) => void): void {
  const job = app.jobs.get(id);
  if (job) mutate(job);
}

/** Runs one job to completion and records the outcome. */
async function runJob(
  app: App,
  id: string,
  request: CreateJob,
  cancel: Int32Array,
  cancelBuffer: SharedArrayBuffer,
): Promise<void> {
  update(app, id, (job) => {
    job.state = "running";
    job.stage = "starting";
    job.pct = 1;
  });

  const isCanceled = (): boolean => Atomics.load(cancel, 0) === 1;

  try {
    let result: unknown;
    switch (request.kind) {
      case "render":
        result = await runRender(app, id, request, cancelBuffer, isCanceled);
        break;
      case "bake-lut":
        result = await runBakeLut(app, request, cancelBuffer, isCanceled);
        break;
      case "preview":
        result = await runPreview(app, id, request, cancelBuffer, isCanceled);
        break;
      default:
        throw EngineError.badRequest(`unknown kind: ${request.kind}`);
    }

    update(app, id, (job) => {
      job.state = "done";
      job.stage = "done";
      job.pct = 100;
      job.result = result;
    });
  } catch (error) {
    const failure = error instanceof EngineError ? error : EngineError.fromCore(error);
    if (failure.code === "E_CANCELED") {
      update(app, id, (job) => {
        job.state = "canceled";
        job.stage = "canceled";
        job.error = failure.toWire();
      });
    } else {
      update(app, id, (job) => {
        job.state = "error";
        job.stage = "error";
        job.error = failure.toWire();
      });
    }
  }

  // A Lightroom session may be blocked on this job; moving that state machine
  // forward is the engine's job, not the caller's.
  settle(app, id);
}

/**
 * Baked tables kept between jobs.
 *
 * A session reuses a handful of strengths, so four entries cover it. A hit
 * skips the bake for every preview and for the render that follows.
 */
const TABLE_CACHE_LIMIT = 4;
const tableCache = new Map<string, FlatTable>();

function tableKey(taskId: string | undefined, grid: number, strength: number): string | undefined {
  // Without a task id the parameters came from an explicit file or request, so
  // there is no identity to key on.
  return taskId ? `${taskId}:${grid}:${strength}` : undefined;
}

function rememberTable(key: string | undefined, table: FlatTable | undefined): void {
  if (!key || !table) return;
  tableCache.delete(key);
  tableCache.set(key, table);
  while (tableCache.size > TABLE_CACHE_LIMIT) {
    const oldest = tableCache.keys().next().value;
    if (oldest === undefined) break;
    tableCache.delete(oldest);
  }
}

async function runRender(
  app: App,
  id: string,
  request: CreateJob,
  cancelBuffer: SharedArrayBuffer,
  isCanceled: () => boolean,
): Promise<unknown> {
  const content = request.content;
  if (!content) throw EngineError.badRequest("content is required");
  const out = request.out;
  if (!out) throw EngineError.badRequest("out is required");
  if (isCanceled()) throw EngineError.canceled();

  const resolved = await resolveThumbsAndParams(app, id, request, cancelBuffer);
  const grid = request.grid ?? 33;
  const strength = clampStrength(request.strength ?? 1);

  const key = tableKey(resolved.taskId, grid, strength);
  const offered = key ? tableCache.get(key) : undefined;
  // Splitting the frame is a scheduling decision, so it happens here, on the
  // main thread; the worker only executes the bands it is given.
  const workers = request.direct ? 1 : renderWorkerCount();
  const plan = workers > 1 ? planRenderBands(content, workers) : undefined;
  const { result, table } = await runWorker(
    id,
    app,
    {
      kind: "render",
      src: content,
      dst: out,
      params: toFloat32(resolved.params),
      grid,
      strength,
      direct: request.direct ?? false,
      ...(offered ? { table: offered } : {}),
      ...(plan ? { plan } : {}),
    },
    cancelBuffer,
  );
  rememberTable(key, table);
  const info = result as { width: number; height: number; metadataPreserved: boolean };

  // `false` means the destination could not be a copy of the source, so the
  // result carries no EXIF/capture time. Lightroom sorts on capture time, so
  // say it out loud instead of letting the photo land at the end of the strip
  // with no explanation.
  const notice = info.metadataPreserved ? null : "结果已写回，但未能沿用原文件的元数据（EXIF／拍摄时间）。";

  return {
    out,
    notice,
    width: info.width,
    height: info.height,
    grid,
    strength,
    metadata_preserved: info.metadataPreserved,
    mode: request.direct ? "direct" : "lut",
    cached: resolved.cached,
    task_id: resolved.taskId,
  };
}

async function runBakeLut(
  app: App,
  request: CreateJob,
  cancelBuffer: SharedArrayBuffer,
  isCanceled: () => boolean,
): Promise<unknown> {
  const out = request.out;
  if (!out) throw EngineError.badRequest("out is required");
  if (isCanceled()) throw EngineError.canceled();

  const content = request.content;
  if (!content) throw EngineError.badRequest("content is required");
  const resolved = await resolveThumbsAndParams(app, "bake", request, cancelBuffer);

  const grid = request.grid ?? 33;
  const { result } = await runWorker(
    "bake",
    app,
    { kind: "bake-lut", params: toFloat32(resolved.params), grid, out },
    cancelBuffer,
  );
  const { entries } = result as { entries: number };

  return { out, grid, entries, cached: resolved.cached, task_id: resolved.taskId };
}

async function runPreview(
  app: App,
  id: string,
  request: CreateJob,
  cancelBuffer: SharedArrayBuffer,
  isCanceled: () => boolean,
): Promise<unknown> {
  const content = request.content;
  if (!content) throw EngineError.badRequest("content is required");
  const maxEdge = Math.min(4096, Math.max(64, request.max_edge ?? PREVIEW_MAX_EDGE));
  if (isCanceled()) throw EngineError.canceled();

  const resolved = await resolveThumbsAndParams(app, id, request, cancelBuffer);
  const grid = request.grid ?? 33;
  const strength = clampStrength(request.strength ?? 1);

  const key = tableKey(resolved.taskId, grid, strength);
  const offered = key ? tableCache.get(key) : undefined;
  const { result: previewResult, table } = await runWorker(
    id,
    app,
    {
      kind: "preview",
      src: content,
      style: request.style,
      params: toFloat32(resolved.params),
      grid,
      strength,
      maxEdge,
      quality: PREVIEW_JPEG_QUALITY,
      ...(offered ? { table: offered } : {}),
    },
    cancelBuffer,
  );
  rememberTable(key, table);
  const preview = previewResult as {
    width: number;
    height: number;
    contentJpeg: Uint8Array;
    resultJpeg: Uint8Array;
    styleJpeg?: Uint8Array;
    styleWidth?: number;
    styleHeight?: number;
  };

  // Previews belong to the parameter-cache task when there is one; otherwise
  // they go to the job-scoped cache. Pixels never travel in the HTTP body.
  const entry = resolved.taskId ? app.store.findById(resolved.taskId) : undefined;
  const contentPath = app.store.savePreview(entry, id, `content-${maxEdge}.jpg`, preview.contentJpeg);
  const resultPath = app.store.savePreview(entry, id, `result-${maxEdge}.jpg`, preview.resultJpeg);
  const stylePath =
    preview.styleJpeg === undefined
      ? undefined
      : app.store.savePreview(entry, id, `style-${maxEdge}.jpg`, preview.styleJpeg);

  return {
    width: preview.width,
    height: preview.height,
    content_path: contentPath,
    style_path: stylePath ?? null,
    result_path: resultPath,
    style_width: preview.styleWidth ?? null,
    style_height: preview.styleHeight ?? null,
    grid,
    strength,
    cached: resolved.cached,
    task_id: resolved.taskId,
  };
}

interface ResolvedParams {
  params: Params;
  cached: boolean;
  taskId?: string;
}

/**
 * Thumbnails both images, then resolves the parameters: from a file when the
 * request names one, otherwise from the cache or the model.
 */
async function resolveThumbsAndParams(
  app: App,
  jobId: string,
  request: CreateJob,
  cancelBuffer: SharedArrayBuffer,
): Promise<ResolvedParams> {
  const content = request.content;
  if (!content) throw EngineError.badRequest("content is required");

  if (request.params) {
    const params = readParamsFile(request.params);
    return { params, cached: true, taskId: undefined };
  }

  const style = request.style;
  if (!style) throw EngineError.badRequest("style or params is required");

  stage(app, jobId, "thumbnail", 5);
  const thumbsResult = (
    await runWorker(jobId, app, { kind: "thumbs", content, style, side: INPUT_SIZE }, cancelBuffer)
  ).result as {
    content: { width: number; height: number; pixels: Float32Array };
    style?: { width: number; height: number; pixels: Float32Array };
  };
  const contentThumb: Thumb = thumbsResult.content;
  const styleThumb = thumbsResult.style;
  if (!styleThumb) throw EngineError.internal("style thumbnail missing");

  stage(app, jobId, "params", request.kind === "preview" ? 15 : 20);

  const contentKey = thumbKey(contentThumb);
  const styleKey = thumbKey(styleThumb);
  const model = app.model;

  // An existing entry with a missing params.bin (deleted by hand, or a crash
  // between the index write and the file write) is rewritten in place rather
  // than duplicated.
  const existing = app.store.find(contentKey, styleKey, model);
  if (existing) {
    const cached = app.store.loadParams(existing);
    if (cached) return { params: cached, cached: true, taskId: existing.id };
  }

  const params = await app.predict(contentThumb, styleThumb);
  const entry = existing ?? app.store.create(contentKey, styleKey, model);
  app.store.saveParams(entry, params);
  await app.store.saveThumb(entry, "content", contentThumb);
  await app.store.saveThumb(entry, "style", styleThumb);
  app.store.writeTaskJson(entry, {
    model_version: model,
    source: request.content,
    style: request.style,
  });

  return { params, cached: false, taskId: entry.id };
}

function readParamsFile(path: string): Params {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw EngineError.io((error as Error).message, error);
  }
  const values: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    const value = Number(token);
    if (!Number.isFinite(value)) throw EngineError.badRequest(`invalid float: ${token}`);
    values.push(value);
  }
  try {
    return paramsFromSlice(values);
  } catch (error) {
    throw EngineError.fromCore(error);
  }
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Rounded to f32 because that is what the session stores and what the blend
  // consumes: keeping the double 0.8 here would shift every blend weight by
  // ~1e-8, which is enough to move samples sitting on a quantisation boundary.
  return Math.fround(Math.min(MAX_STRENGTH, Math.max(0, value)));
}

function toFloat32(params: Params): Float32Array {
  return paramsIntoBuffer(params, new Float32Array(1248));
}

function stage(app: App, id: string, name: string, pct: number): void {
  update(app, id, (job) => {
    job.stage = name;
    job.pct = pct;
  });
}

function noop(): void {}

/** Task id for the reply that belongs to the job currently in flight. */
let nextTaskId = 1;

/**
 * One job worker kept between tasks.
 *
 * What is actually being kept warm is its band pool: those workers load the
 * library once and then serve render after render. A task that arrives while
 * this one is busy gets its own worker, so two jobs never share a thread — and
 * a worker that failed or was cancelled is retired rather than reused, since it
 * may be midway through a strip.
 */
let idleJobWorker: Worker | undefined;

/** Runs one task on a worker thread and resolves with its result. */
function runWorker(
  jobId: string,
  app: App,
  task: WorkerTask,
  cancelBuffer: SharedArrayBuffer,
): Promise<{ result: unknown; table?: FlatTable }> {
  const entry = workerEntry("worker");
  const reused = idleJobWorker;
  idleJobWorker = undefined;
  const worker = reused ?? new Worker(entry.url, { ...(entry.execArgv ? { execArgv: entry.execArgv } : {}) });
  const id = nextTaskId++;

  return new Promise((resolve, reject) => {
    let settled = false;

    const detach = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    // `keep` is false whenever the thread may hold half-transformed state.
    const finish = (keep: boolean, action: () => void): void => {
      if (settled) return;
      settled = true;
      detach();
      if (keep && !idleJobWorker) {
        worker.unref();
        idleJobWorker = worker;
      } else {
        void worker.terminate().then(noop, noop);
      }
      action();
    };

    const onMessage = (message: WorkerMessage): void => {
      if (message.id !== id) return;
      if (message.type === "stage") {
        stage(app, jobId, message.stage, message.pct);
      } else if (message.type === "done") {
        finish(true, () => resolve({ result: message.result, table: message.table }));
      } else {
        finish(false, () => reject(new EngineError(message.code as never, message.message)));
      }
    };
    const onError = (error: Error): void => {
      finish(false, () => reject(EngineError.io(error.message, error)));
    };
    const onExit = (code: number): void => {
      // Settled covers the worker we terminated ourselves after its message.
      // Anything else means the job never reported an outcome, which must not
      // leave the record stuck in `running`.
      if (settled) return;
      settled = true;
      if (idleJobWorker === worker) idleJobWorker = undefined;
      reject(EngineError.internal(`job worker exited with ${code} before reporting`));
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage({ id, task, cancel: cancelBuffer } satisfies JobRequest);
  });
}
