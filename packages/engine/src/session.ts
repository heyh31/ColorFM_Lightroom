/**
 * Lightroom-to-desktop session boundary.
 *
 * The serial workflow is: Lightroom exports a TIFF and creates a session, the
 * desktop window claims it, the user picks a reference and confirms, and the
 * plug-in imports the finished TIFF. The engine owns that state; neither the
 * plug-in nor the UI keeps an authoritative copy. Both sides only ask "what
 * state is session X in?" and act on the answer.
 *
 * Persistence is one JSON file per session under
 * `<home>/lightroom/sessions/`, which keeps the layout small enough to migrate
 * entry by entry into a real project store later.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { EngineError, type WireError } from "./errors.js";
import type { Job } from "./jobs.js";

export const SCHEMA_VERSION = 1;

/** Every state a session can be in. */
export type SessionState =
  | "created"
  | "waiting_for_ui"
  | "waiting_for_reference"
  | "previewing"
  | "ready"
  | "rendering"
  | "ready_to_import"
  | "imported"
  | "canceled"
  | "error";

/**
 * States where an unfinished workflow still exists. The engine must stay alive
 * while any of these are present.
 */
export function isActive(state: SessionState): boolean {
  return state !== "imported" && state !== "canceled" && state !== "error";
}

/**
 * Whether a window should still show this session.
 *
 * Looser than {@link isActive}: a write-back that died stays on screen so the
 * user can retry it, even after the window is reopened. The idle watchdog
 * keeps using `isActive`, so a failed session nobody is working on cannot hold
 * the engine open forever.
 */
export function isVisible(state: SessionState): boolean {
  return state !== "imported" && state !== "canceled";
}

/** Photo identity from the catalogue; only used for display and plug-in metadata. */
export interface SourceInfo {
  catalog_path?: string;
  photo_uuid?: string;
  photo_name?: string;
  raw_path?: string;
}

export interface Session {
  schema_version: number;
  id: string;
  state: SessionState;
  /** Display name, normally the exported file name. */
  label: string;
  content_path: string;
  reference_path?: string;
  strength: number;
  preview_job_id?: string;
  render_job_id?: string;
  preview_before_path?: string;
  preview_after_path?: string;
  /** Engine-rendered thumbnail of the reference, for the window to display. */
  preview_style_path?: string;
  /**
   * True once the render job finished; `state` stays `rendering` until the user
   * explicitly returns to Lightroom.
   */
  render_done: boolean;
  result_path?: string;
  output_path?: string;
  /** Human-readable remark that is not an error, e.g. a recovery notice. */
  notice?: string;
  error?: WireError;
  source?: SourceInfo;
  created_at: number;
  updated_at: number;
}

/** Upper end of the strength slider, mirrored from the job layer. */
const MAX_STRENGTH = 2;

/** Creates a session in `waiting_for_ui`, the state the plug-in leaves it in. */
export function newSession(
  id: string,
  contentPath: string,
  label: string,
  strength: number,
  source: SourceInfo | undefined,
): Session {
  const now = nowSecs();
  return {
    schema_version: SCHEMA_VERSION,
    id,
    state: "waiting_for_ui",
    label,
    content_path: contentPath,
    strength: clamp(strength, MAX_STRENGTH),
    render_done: false,
    ...(source ? { source } : {}),
    created_at: now,
    updated_at: now,
  };
}

function clamp(value: number, high: number): number {
  const v = Math.max(0, Math.min(high, value));
  return Number.isFinite(v) ? v : 0;
}

/** Legal moves out of each state; anything else is a conflict. */
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  created: ["waiting_for_ui", "waiting_for_reference"],
  waiting_for_ui: ["waiting_for_reference"],
  waiting_for_reference: ["previewing"],
  previewing: ["ready", "error"],
  // A render that died on I/O leaves the session in `error` with its preview
  // and parameters intact, so the same write-back may run again.
  ready: ["previewing", "rendering"],
  error: ["previewing", "rendering"],
  // Rendering → rendering covers a retry after a failed write-back.
  rendering: ["rendering", "ready", "error", "ready_to_import"],
  ready_to_import: ["imported", "error"],
  imported: [],
  canceled: [],
};

/**
 * States have a fixed set of legal transitions; nothing in the UI or the plug-in
 * writes `state` directly.
 */
export function allowed(from: SessionState, to: SessionState): boolean {
  // Cancelling is always possible until the workflow is over.
  if (to === "canceled") return isActive(from);
  return TRANSITIONS[from].includes(to);
}

/** Applies a transition, refusing moves the design does not allow. */
export function transition(session: Session, to: SessionState): void {
  const from = session.state;
  if (from === to) {
    session.updated_at = nowSecs();
    return;
  }
  if (!allowed(from, to)) {
    throw new EngineError("E_STATE_CONFLICT", `session ${session.id} is ${from}, cannot become ${to}`);
  }
  session.state = to;
  session.updated_at = nowSecs();
}

/** Directory holding one JSON file per session. */
export class SessionStore {
  private readonly dir: string;
  private sessions: Session[] = [];

  private constructor(dir: string) {
    this.dir = dir;
  }

  static open(dir: string): SessionStore {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
    const store = new SessionStore(dir);
    const sessions: Session[] = [];
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const session = JSON.parse(readFileSync(join(dir, name), "utf8")) as Session;
          recover(session);
          sessions.push(session);
        } catch {
          // A file we cannot parse is skipped: one broken session must not stop
          // the engine from starting.
        }
      }
    } catch {
      // An unreadable directory simply starts empty.
    }
    sessions.sort((a, b) => a.created_at - b.created_at);
    store.sessions = sessions;
    return store;
  }

  create(session: Session): Session {
    this.persist(session);
    this.sessions.push({ ...session });
    return session;
  }

  get(id: string): Session | undefined {
    const found = this.sessions.find((session) => session.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Newest first. `activeOnly` hides imported, cancelled and errored sessions,
   * which is what the desktop app asks for on launch.
   */
  list(activeOnly: boolean): Session[] {
    const out = this.sessions
      .filter((session) => !activeOnly || isVisible(session.state))
      .map((session) => ({ ...session }));
    out.sort((a, b) => b.created_at - a.created_at);
    return out;
  }

  activeCount(): number {
    return this.sessions.filter((session) => isActive(session.state)).length;
  }

  /**
   * The single place that mutates a session: the closure runs on a copy, then
   * the file is rewritten. A closure error leaves the stored state untouched.
   */
  update(id: string, mutate: (session: Session) => void): Session {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index < 0) throw EngineError.notFound(`no such session: ${id}`);
    const candidate: Session = { ...this.sessions[index] };
    mutate(candidate);
    candidate.updated_at = nowSecs();
    this.persist(candidate);
    this.sessions[index] = candidate;
    return { ...candidate };
  }

  /** Moves a session to `to`, then applies any extra changes. */
  transition(id: string, to: SessionState, mutate: (session: Session) => void = () => {}): Session {
    return this.update(id, (session) => {
      transition(session, to);
      mutate(session);
    });
  }

  /**
   * Applies the outcome of a finished job to whichever session is waiting on
   * it. Called from the job worker, after the job record is final.
   */
  settleJob(job: Job): void {
    const index = this.sessions.findIndex(
      (session) => session.preview_job_id === job.id || session.render_job_id === job.id,
    );
    if (index < 0) return;

    const current = this.sessions[index];
    const isPreview = current.preview_job_id === job.id;
    const candidate: Session = { ...current };

    if (job.state === "done" && isPreview) {
      // Content is generated when the session is created; keep it stable across
      // strength changes so the left panel never blanks out while a new preview
      // is baking.
      if (candidate.preview_before_path === undefined) {
        candidate.preview_before_path = stringField(job, "content_path");
      }
      candidate.preview_after_path = stringField(job, "result_path");
      const stylePath = stringField(job, "style_path");
      if (stylePath !== undefined) candidate.preview_style_path = stylePath;
      delete candidate.error;
      delete candidate.notice;
      transition(candidate, "ready");
    } else if (job.state === "done") {
      candidate.result_path = stringField(job, "out");
      candidate.render_done = true;
      delete candidate.error;
      const notice = stringField(job, "notice");
      if (notice === undefined) delete candidate.notice;
      else candidate.notice = notice;
      // Stays `rendering`: the user still has to return to Lightroom.
      candidate.state = "rendering";
      candidate.updated_at = nowSecs();
    } else if (job.state === "canceled") {
      tryTransition(candidate, "canceled");
      if (job.error) candidate.error = job.error;
    } else {
      tryTransition(candidate, "error");
      candidate.error = job.error ?? {
        code: "E_JOB_FAILED",
        message: "job finished without a result",
      };
    }

    this.persist(candidate);
    this.sessions[index] = candidate;
  }

  /**
   * Completes a preview from a terminal job record: the same operation as
   * {@link settleJob}, exposed as an idempotent read-side repair.
   */
  finishPreview(sessionId: string, job: Job): Session {
    const index = this.sessions.findIndex(
      (session) => session.id === sessionId && session.preview_job_id === job.id,
    );
    if (index < 0) throw EngineError.internal("preview session disappeared");

    const current = this.sessions[index];
    if (current.state !== "previewing") return { ...current };

    const candidate: Session = { ...current };
    if (candidate.preview_before_path === undefined) {
      candidate.preview_before_path = stringField(job, "content_path");
    }
    candidate.preview_after_path = stringField(job, "result_path");
    const stylePath = stringField(job, "style_path");
    if (stylePath !== undefined) candidate.preview_style_path = stylePath;
    candidate.state = "ready";
    delete candidate.error;
    delete candidate.notice;
    candidate.updated_at = nowSecs();

    this.persist(candidate);
    this.sessions[index] = candidate;
    return { ...candidate };
  }

  private persist(session: Session): void {
    const path = join(this.dir, `${session.id}.json`);
    const tmp = path.replace(/\.json$/, ".json.tmp");
    try {
      writeFileSync(tmp, `${JSON.stringify(session, null, 2)}`);
      renameSync(tmp, path);
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }
}

function tryTransition(session: Session, to: SessionState): void {
  try {
    transition(session, to);
  } catch {
    // Settling is best effort: a session that already moved on stays as it is.
  }
}

function stringField(job: Job, field: string): string | undefined {
  const result = job.result as Record<string, unknown> | undefined;
  const value = result?.[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Jobs live in memory only, so a session that was mid-job when the engine
 * stopped can never finish. Downgrade it to a state the user can act on.
 */
export function recover(session: Session): void {
  if (session.state === "previewing") {
    session.state = "waiting_for_reference";
    delete session.preview_job_id;
    session.notice = "引擎重启，预览需要重做";
  } else if (session.state === "rendering" && !session.render_done) {
    session.state = "ready";
    delete session.render_job_id;
    session.notice = "引擎重启，渲染被中断，请重新确认";
  }
  session.updated_at = nowSecs();
}

/** What {@link settle} and {@link reconcile} need from the application. */
export interface SessionContext {
  readonly sessions: SessionStore;
  readonly jobs: Map<string, Job>;
  touch(): void;
}

/** Called once a job record is final: moves the session waiting on it, if any. */
export function settle(context: SessionContext, jobId: string): void {
  const job = context.jobs.get(jobId);
  if (job) {
    try {
      context.sessions.settleJob(job);
    } catch (error) {
      console.error(`warning: cannot settle session for ${jobId}: ${(error as Error).message}`);
    }
  }
  context.touch();
}

/**
 * Repairs a session whose job already reached a terminal state but whose settle
 * callback was superseded by a newer preview request. Reads must be safe to
 * repeat; this keeps the UI from remaining stuck in `previewing`.
 */
export function reconcile(context: SessionContext, id: string): Session | undefined {
  const session = context.sessions.get(id);
  if (!session || session.state !== "previewing") return session;

  const jobId = session.preview_job_id;
  const job = jobId ? context.jobs.get(jobId) : undefined;
  if (job) {
    try {
      if (job.state === "done") context.sessions.finishPreview(session.id, job);
      else if (job.state === "error" || job.state === "canceled") context.sessions.settleJob(job);
    } catch (error) {
      console.error(`warning: cannot reconcile session ${session.id}: ${(error as Error).message}`);
    }
  }
  return context.sessions.get(id);
}

/** Default result path: next to the exported TIFF, tagged with the strength. */
export function defaultOutput(content: string, strength: number): string {
  const name = basename(content);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const dir = dirname(content) || ".";
  const pct = Math.round(Math.min(1, Math.max(0, strength)) * 100);
  return join(dir, `${stem}_ColorFM_${String(pct).padStart(2, "0")}.tif`);
}

/** `s_YYYYMMDD-HHMMSS_xxxxxx`, sortable in Finder and unique per second. */
export function newId(now = nowSecs()): string {
  const suffix = randomBytes(3).toString("hex");
  const days = Math.floor(now / 86_400);
  const secs = now % 86_400;
  const [year, month, day] = civilFromDays(days);
  const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `s_${year}${pad2(month)}${pad2(day)}-${hh}${mm}${ss}_${suffix}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Unix seconds. */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Howard Hinnant's `civil_from_days`: days since the epoch to a calendar date. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [month <= 2 ? year + 1 : year, month, day];
}

/** Removes a session file, used by the tests and by explicit cleanup. */
export function removeSession(dir: string, id: string): void {
  const path = join(dir, `${id}.json`);
  if (existsSync(path)) rmSync(path);
}
