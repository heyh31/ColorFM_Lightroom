/**
 * HTTP surface.
 *
 * Two families live here: the generic job API (`/v1/jobs`) and the Lightroom
 * session API (`/v1/lightroom/sessions`). The session endpoints are thin on
 * purpose — they validate input, ask {@link SessionStore} for a state
 * transition, and hand the actual pixel work to the job queue.
 *
 * Every response is an envelope with `ok` / `schema_version` / `data` /
 * `warnings` / `error`; clients branch on `error.code`, never on the message.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";

import { preview as previewImage, encodeJpeg } from "@colorfm/core";

import { EngineError, statusFor, asEngineError } from "./errors.js";
import { sweepExports } from "./exports.js";
import {
  PREVIEW_JPEG_QUALITY,
  PREVIEW_MAX_EDGE,
  MAX_STRENGTH,
  spawn,
  spawnWithId,
  type CreateJob,
} from "./jobs.js";
import { defaultOutput, newId, newSession, reconcile, type Session, type SourceInfo } from "./session.js";
import type { App } from "./state.js";

const SCHEMA_VERSION = 1;

interface Envelope {
  ok: boolean;
  schema_version: number;
  data?: unknown;
  warnings?: string[];
  error?: { code: string; message: string };
}

function send(response: ServerResponse, status: number, body: Envelope): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function ok(response: ServerResponse, data: unknown, status = 200): void {
  send(response, status, { ok: true, schema_version: SCHEMA_VERSION, data });
}

function created(response: ServerResponse, data: unknown): void {
  ok(response, data, 201);
}

function accepted(response: ServerResponse, data: unknown): void {
  ok(response, data, 202);
}

function fail(response: ServerResponse, error: EngineError, status = statusFor(error)): void {
  send(response, status, { ok: false, schema_version: SCHEMA_VERSION, error: error.toWire() });
}

/** Builds the HTTP server. CORS is outermost so preflights skip auth. */
export function createApiServer(app: App): Server {
  return createServer((request, response) => {
    handle(app, request, response).catch((error: unknown) => {
      const failure = asEngineError(error);
      if (!response.headersSent) fail(response, failure);
      else response.end();
    });
  });
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Browsers do not send Authorization on a preflight, so answer it first.
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  for (const [name, value] of Object.entries(corsHeaders())) response.setHeader(name, value);

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!authorized(app, request, url)) {
    fail(response, new EngineError("E_UNAUTHORIZED", "missing or invalid bearer token"), 401);
    return;
  }
  app.touch();

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method ?? "GET";
  const segments = path.split("/").filter((part) => part.length > 0);

  try {
    if (method === "GET" && path === "/v1/health") {
      health(app, response);
      return;
    }
    if (method === "GET" && path === "/v1/diagnostics") {
      diagnostics(app, response);
      return;
    }
    if (method === "POST" && path === "/v1/jobs") {
      const body = await readJson<CreateJob>(request);
      createJob(app, response, body);
      return;
    }
    if (segments[0] === "v1" && segments[1] === "jobs" && segments[2]) {
      const id = decodeURIComponent(segments[2]);
      if (method === "GET" && segments.length === 3) {
        getJob(app, response, id);
        return;
      }
      if (method === "POST" && segments[3] === "cancel") {
        cancelJob(app, response, id);
        return;
      }
    }
    if (method === "GET" && path === "/v1/lightroom/history") {
      history(app, response);
      return;
    }
    if (segments[0] === "v1" && segments[1] === "lightroom" && segments[2] === "history" && segments[3]) {
      if (method === "DELETE" && segments.length === 4) {
        deleteHistory(app, response, decodeURIComponent(segments[3]));
        return;
      }
    }
    if (path === "/v1/lightroom/sessions") {
      if (method === "GET") {
        listSessions(app, response, url.searchParams.get("active"));
        return;
      }
      if (method === "POST") {
        await createSession(app, response, await readBytes(request));
        return;
      }
    }
    if (segments[0] === "v1" && segments[1] === "lightroom" && segments[2] === "sessions" && segments[3]) {
      const id = decodeURIComponent(segments[3]);
      const action = segments[4];
      if (method === "GET" && !action) {
        getSession(app, response, id);
        return;
      }
      if (method === "POST" && action) {
        const bytes = await readBytes(request);
        switch (action) {
          case "claim":
            claimSession(app, response, id);
            return;
          case "preview":
            await sessionPreview(app, response, id, bytes);
            return;
          case "confirm":
            await sessionConfirm(app, response, id, bytes);
            return;
          case "ready-to-import":
            sessionReadyToImport(app, response, id);
            return;
          case "imported":
            sessionImported(app, response, id);
            return;
          case "cancel":
            sessionCancel(app, response, id);
            return;
          default:
            break;
        }
      }
    }

    fail(response, new EngineError("E_NOT_FOUND", `no route for ${method} ${path}`), 404);
  } catch (error) {
    const failure = asEngineError(error);
    fail(response, failure);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
  };
}

/**
 * Bearer header, or a `token` query parameter for the endpoints an `<img>` tag
 * loads — that element cannot set headers. Loopback only either way.
 */
function authorized(app: App, request: IncomingMessage, url: URL): boolean {
  const header = request.headers.authorization;
  const fromHeader = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const fromQuery = url.searchParams.get("token") || undefined;
  const provided = fromHeader || fromQuery || "";
  return provided.length > 0 && provided === app.token;
}

async function readBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const joined = Buffer.concat(chunks);
  // Copy out of the shared pool so the returned view is exactly the body.
  return new Uint8Array(joined);
}

/**
 * A body is optional on the session endpoints: the plug-in posts a bare object
 * and the UI sometimes posts `{}`. Reading raw bytes keeps an empty body from
 * turning into a 415 before the handler runs.
 */
async function readJson<T>(request: IncomingMessage, fallback: T = {} as T): Promise<T> {
  const bytes = await readBytes(request);
  if (bytes.length === 0) return fallback;
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (text.length === 0) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null) return fallback;
    return parsed as T;
  } catch {
    throw EngineError.badRequest(`invalid JSON body`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function health(app: App, response: ServerResponse): void {
  ok(response, {
    version: VERSION,
    model: app.model,
    model_loaded: app.isReady(),
    uptime_s: Math.floor((Date.now() - app.started) / 1000),
    // Feature handshake: the desktop app refuses to reuse an engine that
    // predates a capability it needs.
    capabilities: ["preview", "strength", "cors", "lightroom-sessions", "session-recovery", "history"],
  });
}

function diagnostics(app: App, response: ServerResponse): void {
  let running = 0;
  for (const job of app.jobs.values()) if (job.state === "running") running += 1;
  ok(response, {
    version: VERSION,
    schema_version: SCHEMA_VERSION,
    model: app.model,
    model_loaded: app.isReady(),
    jobs_total: app.jobs.size,
    jobs_running: running,
    threads: Math.max(1, availableParallelism()),
    sessions_active: app.sessions.activeCount(),
    idle_s: app.idleSecs(),
  });
}

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function createJob(app: App, response: ServerResponse, request: CreateJob): void {
  if (!["render", "bake-lut", "preview"].includes(request.kind)) {
    fail(response, EngineError.badRequest(`unsupported kind: ${request.kind}`), 400);
    return;
  }
  const id = spawn(app, request);
  accepted(response, { job_id: id });
}

function getJob(app: App, response: ServerResponse, id: string): void {
  const job = app.jobs.get(id);
  if (!job) {
    fail(response, new EngineError("E_NOT_FOUND", `no such job: ${id}`), 404);
    return;
  }
  ok(response, serializeJob(job));
}

function cancelJob(app: App, response: ServerResponse, id: string): void {
  const job = app.jobs.get(id);
  if (!job) {
    fail(response, new EngineError("E_NOT_FOUND", `no such job: ${id}`), 404);
    return;
  }
  Atomics.store(job.cancel, 0, 1);
  ok(response, { job_id: id, cancel_requested: true });
}

function serializeJob(job: {
  id: string;
  kind: string;
  state: string;
  stage: string;
  pct: number;
  error?: { code: string; message: string };
  result?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    pct: job.pct,
  };
  if (job.error) out.error = job.error;
  if (job.result !== undefined) out.result = job.result;
  return out;
}

// ---------------------------------------------------------------------------
// Lightroom sessions
// ---------------------------------------------------------------------------

interface NewSessionRequest {
  content_path?: string;
  /** Where the result should be written; normally next to the original photo. */
  output_path?: string;
  label?: string;
  strength?: number;
  catalog_path?: string;
  photo_uuid?: string;
  photo_name?: string;
  raw_path?: string;
}

interface PreviewRequest {
  reference_path?: string;
  strength?: number;
}

interface ConfirmRequest {
  strength?: number;
  out?: string;
  grid?: number;
}

function sessionValue(session: Session): Record<string, unknown> {
  return session as unknown as Record<string, unknown>;
}

function loadSession(app: App, id: string): Session {
  const session = app.sessions.get(id);
  if (!session) throw new EngineError("E_NOT_FOUND", `no such session: ${id}`);
  return session;
}

async function createSession(app: App, response: ServerResponse, bytes: Uint8Array): Promise<void> {
  const body = await parseBody<NewSessionRequest>(bytes);

  const rawContent = (body.content_path ?? "").trim();
  if (rawContent.length === 0) {
    fail(response, EngineError.badRequest("content_path is required"), 400);
    return;
  }
  if (!isFile(rawContent)) {
    fail(response, new EngineError("E_FILE_MOVED", `exported TIFF is not readable: ${rawContent}`), 409);
    return;
  }

  const label = body.label ?? basename(rawContent) ?? "ColorFM export";
  const source: SourceInfo = {
    ...(body.catalog_path ? { catalog_path: body.catalog_path } : {}),
    ...(body.photo_uuid ? { photo_uuid: body.photo_uuid } : {}),
    ...(body.photo_name ? { photo_name: body.photo_name } : {}),
    ...(body.raw_path ? { raw_path: body.raw_path } : {}),
  };
  const hasSource = Object.keys(source).length > 0;

  const sessionId = newId();
  const session = newSession(
    sessionId,
    rawContent,
    label,
    clampStrength(body.strength ?? 1),
    hasSource ? source : undefined,
  );
  const outputPath = (body.output_path ?? "").trim();
  if (outputPath.length > 0) session.output_path = outputPath;

  // The content panel must be useful before the user picks a reference, so its
  // preview is generated at creation instead of waiting for the first preview.
  let jpeg: Uint8Array;
  try {
    const view = await previewImage(rawContent, PREVIEW_MAX_EDGE);
    jpeg = await encodeJpeg(view.pixels, view.width, view.height, PREVIEW_JPEG_QUALITY);
  } catch (error) {
    fail(response, EngineError.fromCore(error));
    return;
  }

  const previewPath = app.store.savePreview(undefined, sessionId, "content-1280.jpg", jpeg);
  session.preview_before_path = previewPath;

  const stored = app.sessions.create(session);
  created(response, { session: sessionValue(stored) });
}

async function parseBody<T extends object>(bytes: Uint8Array): Promise<T> {
  if (bytes.length === 0) return {} as T;
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (text.length === 0) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw EngineError.badRequest("invalid JSON body");
  }
  if (parsed === null) return {} as T;
  if (typeof parsed !== "object") throw EngineError.badRequest("invalid request body: expected an object");
  return parsed as T;
}

function listSessions(app: App, response: ServerResponse, active: string | null): void {
  const activeOnly = active === "1" || active === "true";
  ok(response, {
    sessions: app.sessions.list(activeOnly).map(sessionValue),
    active: app.sessions.activeCount(),
  });
}

function getSession(app: App, response: ServerResponse, id: string): void {
  const session = reconcile(app, id);
  if (!session) {
    fail(response, new EngineError("E_NOT_FOUND", `no such session: ${id}`), 404);
    return;
  }
  ok(response, { session: sessionValue(session) });
}

/**
 * The desktop window claims a session on load; claiming twice is harmless so a
 * window that was closed and reopened can pick the workflow back up. A session
 * that has already moved past this point is returned untouched.
 */
function claimSession(app: App, response: ServerResponse, id: string): void {
  const session = loadSession(app, id);
  if (session.state !== "created" && session.state !== "waiting_for_ui") {
    ok(response, { session: sessionValue(session) });
    return;
  }
  const updated = app.sessions.transition(id, "waiting_for_reference");
  ok(response, { session: sessionValue(updated) });
}

async function sessionPreview(
  app: App,
  response: ServerResponse,
  id: string,
  bytes: Uint8Array,
): Promise<void> {
  const body = await parseBody<PreviewRequest>(bytes);
  const session = loadSession(app, id);

  const reference = body.reference_path ?? session.reference_path ?? "";
  if (reference.length === 0) {
    fail(response, EngineError.badRequest("reference_path is required"), 400);
    return;
  }
  if (!isFile(reference)) {
    fail(response, new EngineError("E_FILE_MOVED", `reference image is not readable: ${reference}`), 409);
    return;
  }

  const strength = clampStrength(body.strength ?? session.strength);
  // Reserve the id first: the job must never finish before the session knows
  // which job it is waiting on.
  const jobId = app.nextJobId();

  const updated = app.sessions.transition(id, "previewing", (target) => {
    target.reference_path = reference;
    target.strength = strength;
    target.preview_job_id = jobId;
    delete target.error;
    delete target.notice;
  });

  spawnWithId(app, jobId, {
    kind: "preview",
    content: updated.content_path,
    style: reference,
    strength,
    max_edge: 1280,
  });

  accepted(response, { session: sessionValue(updated) });
}

async function sessionConfirm(
  app: App,
  response: ServerResponse,
  id: string,
  bytes: Uint8Array,
): Promise<void> {
  const body = await parseBody<ConfirmRequest>(bytes);
  const session = loadSession(app, id);

  const reference = session.reference_path;
  if (!reference) {
    fail(response, EngineError.badRequest("session has no reference image yet"), 400);
    return;
  }
  const strength = clampStrength(body.strength ?? session.strength);
  const out = body.out ?? session.output_path ?? defaultOutput(session.content_path, strength);

  const jobId = app.nextJobId();
  const updated = app.sessions.transition(id, "rendering", (target) => {
    target.strength = strength;
    target.output_path = out;
    delete target.result_path;
    target.render_done = false;
    target.render_job_id = jobId;
    delete target.error;
    delete target.notice;
  });

  spawnWithId(app, jobId, {
    kind: "render",
    content: updated.content_path,
    style: reference,
    out,
    strength,
    grid: body.grid,
  });

  accepted(response, { session: sessionValue(updated) });
}

/**
 * Called when the user clicks "back to Lightroom and import". Only then may the
 * plug-in touch the catalogue, so the window is never pulled out from under a
 * user who is still comparing.
 */
function sessionReadyToImport(app: App, response: ServerResponse, id: string): void {
  const session = loadSession(app, id);
  if (!session.render_done) {
    fail(response, new EngineError("E_STATE_CONFLICT", "render has not finished yet"), 409);
    return;
  }
  const updated = app.sessions.transition(id, "ready_to_import", (target) => {
    delete target.notice;
  });
  // Snapshot as soon as a result exists, not only once the plug-in reports the
  // import: the filmstrip should be stable even when a session is never imported,
  // and the previews it would otherwise borrow are shared with the parameter
  // cache, which a later run of the same content+reference pair overwrites.
  try {
    app.history.record(updated);
  } catch (error) {
    console.error(`warning: cannot record history for ${updated.id}: ${(error as Error).message}`);
  }
  ok(response, { session: sessionValue(updated) });
}

function sessionImported(app: App, response: ServerResponse, id: string): void {
  loadSession(app, id);
  const session = app.sessions.transition(id, "imported");
  // History is a snapshot, not the authority: a failure to copy a thumbnail
  // must not tell the plug-in that the import failed.
  try {
    app.history.record(session);
  } catch (error) {
    console.error(`warning: cannot record history for ${session.id}: ${(error as Error).message}`);
  }
  ok(response, { session: sessionValue(session) });
}

/** Only sessions that produced a result appear here; a previewed-only session is not history. */
function history(app: App, response: ServerResponse): void {
  // The filmstrip is refreshed whenever the window opens or an import lands, so
  // this is also the natural moment to clear exports that lost their session.
  sweepExports(app);
  const sessions = app.sessions.list(false);
  ok(response, { entries: app.history.collect(sessions) });
}

/**
 * Forgets one history entry: its snapshot, its session record, and the scratch
 * TIFF Lightroom exported for the engine.
 *
 * The rendered result is deliberately kept. By the time a user deletes a
 * history entry the file is usually already in the Lightroom catalogue, and
 * removing it would leave a missing photo behind — the catalogue is not ours to
 * edit, so the file it points at stays.
 */
function deleteHistory(app: App, response: ServerResponse, id: string): void {
  const entry = app.history.collect(app.sessions.list(false)).find((candidate) => candidate.id === id);
  if (!entry) throw EngineError.notFound(`no such history entry: ${id}`);

  const removed: string[] = [];
  if (app.history.remove(id)) removed.push(`history/${id}`);

  const session = app.sessions.get(id);
  if (session) {
    // The 16-bit export is scratch the engine asked for; once the session is
    // gone nothing reads it again. It only ever lives inside the library.
    const scratch = session.content_path;
    if (scratch && insideLibrary(app, scratch)) {
      rmSync(scratch, { force: true });
      removed.push(scratch);
    }
    app.sessions.remove(id);
    removed.push(`sessions/${id}.json`);
  }

  ok(response, {
    id,
    removed,
    ...(entry.result_path ? { kept: [entry.result_path] } : {}),
  });
}

/** True when `path` sits under `<library>/lightroom`, the only tree we delete from. */
function insideLibrary(app: App, path: string): boolean {
  const root = join(app.store.root, "lightroom");
  const relative = path.startsWith(root) ? path.slice(root.length) : undefined;
  return relative !== undefined && !relative.startsWith("..");
}

function sessionCancel(app: App, response: ServerResponse, id: string): void {
  const session = loadSession(app, id);

  // Stop the pixels first, then record the state change.
  for (const jobId of [session.preview_job_id, session.render_job_id]) {
    if (!jobId) continue;
    const job = app.jobs.get(jobId);
    if (job) Atomics.store(job.cancel, 0, 1);
  }

  const updated = app.sessions.transition(id, "canceled");
  ok(response, { session: sessionValue(updated) });
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Rounded to f32 because that is what the session stores and what the blend
  // consumes: keeping the double 0.8 here would shift every blend weight by
  // ~1e-8, which is enough to move samples sitting on a quantisation boundary.
  return Math.fround(Math.min(MAX_STRENGTH, Math.max(0, value)));
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
