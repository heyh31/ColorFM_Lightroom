/**
 * Typed client for `colorfm-engine` (v0.md §6).
 *
 * The webview talks HTTP directly; Rust only finds the port/token for us (see
 * `src-tauri/src/main.rs`). Every response uses the envelope from the design
 * doc, so unwrapping lives here and callers only see data or a coded error.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Translate } from "./i18n";

export type EngineInfo = { port: number; token: string; pid: number };

export type WireError = { code: string; message: string };

type Envelope<T> = {
  ok: boolean;
  schema_version: number;
  data?: T;
  warnings?: string[];
  error?: WireError;
};

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

export type Session = {
  id: string;
  state: SessionState;
  label: string;
  content_path: string;
  reference_path?: string;
  strength: number;
  preview_job_id?: string;
  render_job_id?: string;
  preview_before_path?: string;
  preview_after_path?: string;
  /** Engine-rendered thumbnail of the reference (the original is out of scope). */
  preview_style_path?: string;
  /** The render job finished, but the user has not returned to Lightroom yet. */
  render_done: boolean;
  result_path?: string;
  output_path?: string;
  notice?: string;
  error?: WireError;
  source?: {
    catalog_path?: string;
    photo_uuid?: string;
    photo_name?: string;
    raw_path?: string;
  };
  created_at: number;
  updated_at: number;
};

/** One imported result, snapshotted by the engine when the plug-in reports it. */
export type HistoryEntry = {
  id: string;
  label: string;
  imported_at: number;
  created_at: number;
  strength: number;
  result_path?: string;
  raw_path?: string;
  reference_name?: string;
  content_thumb?: string;
  result_thumb?: string;
  reference_thumb?: string;
};

export type JobState = "queued" | "running" | "done" | "error" | "canceled";

export type Job = {
  id: string;
  kind: string;
  state: JobState;
  stage: string;
  pct: number;
  error?: WireError;
  result?: PreviewResult & { out?: string };
};

export type PreviewResult = {
  width: number;
  height: number;
  content_path: string;
  style_path: string | null;
  result_path: string;
  style_width?: number | null;
  style_height?: number | null;
  cached?: boolean;
  task_id?: string;
  strength?: number;
};

/** Thrown for any `ok: false` envelope; `code` is what the UI branches on. */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/**
 * Turns an engine error into a sentence the user can act on. The code is the
 * stable part; the text comes from the active dictionary (`err.<CODE>`), so a
 * new code degrades to "something went wrong (CODE)" instead of a blank UI.
 */
export function describeError(error: unknown, t: Translate): string {
  if (error instanceof EngineError) {
    const key = `err.${error.code}`;
    const text = t(key);
    return text === key ? t("err.unknown", { code: error.code }) : text;
  }
  return String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Engine {
  readonly port: number;
  private readonly token: string;

  constructor(info: EngineInfo) {
    this.port = info.port;
    this.token = info.token;
  }

  /** Reuse a live engine, otherwise start one. */
  static async connect(): Promise<Engine> {
    let info: EngineInfo;
    try {
      info = await invoke<EngineInfo>("engine_info");
    } catch {
      info = await invoke<EngineInfo>("start_engine");
    }
    return new Engine(info);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new EngineError("E_OFFLINE", `无法连接引擎：${String(err)}`);
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new EngineError("E_INTERNAL", `引擎返回了非 JSON 响应（HTTP ${response.status}）`);
    }

    if (!envelope.ok) {
      const error = envelope.error ?? { code: "E_INTERNAL", message: "unknown" };
      throw new EngineError(error.code, error.message);
    }
    return envelope.data as T;
  }

  // --- generic jobs -------------------------------------------------------

  async createJob(body: Record<string, unknown>): Promise<string> {
    const data = await this.request<{ job_id: string }>("POST", "/v1/jobs", body);
    return data.job_id;
  }

  async job(id: string): Promise<Job> {
    return this.request<Job>("GET", `/v1/jobs/${id}`);
  }

  async cancelJob(id: string): Promise<void> {
    await this.request("POST", `/v1/jobs/${id}/cancel`);
  }

  async waitJob(id: string, onProgress?: (job: Job) => void): Promise<Job> {
    for (;;) {
      const job = await this.job(id);
      onProgress?.(job);
      if (job.state !== "queued" && job.state !== "running") {
        if (job.state === "error") {
          throw new EngineError(job.error?.code ?? "E_JOB_FAILED", job.error?.message ?? "job failed");
        }
        if (job.state === "canceled") {
          throw new EngineError("E_CANCELED", "job canceled");
        }
        return job;
      }
      await sleep(250);
    }
  }

  // --- Lightroom sessions -------------------------------------------------

  async listSessions(activeOnly: boolean): Promise<{ sessions: Session[]; active: number }> {
    const query = activeOnly ? "?active=1" : "";
    return this.request("GET", `/v1/lightroom/sessions${query}`);
  }

  /** Imported results only; abandoned renders are not history. */
  async history(): Promise<HistoryEntry[]> {
    const data = await this.request<{ entries: HistoryEntry[] }>("GET", "/v1/lightroom/history");
    return data.entries;
  }

  async getSession(id: string): Promise<Session> {
    const data = await this.request<{ session: Session }>("GET", `/v1/lightroom/sessions/${id}`);
    return data.session;
  }

  /** Tells the engine that this window owns the session; idempotent. */
  async claimSession(id: string): Promise<Session> {
    const data = await this.request<{ session: Session }>("POST", `/v1/lightroom/sessions/${id}/claim`);
    return data.session;
  }

  async previewSession(id: string, referencePath: string, strength: number): Promise<Session> {
    const data = await this.request<{ session: Session }>("POST", `/v1/lightroom/sessions/${id}/preview`, {
      reference_path: referencePath,
      strength,
    });
    return data.session;
  }

  async confirmSession(id: string, strength: number, out?: string): Promise<Session> {
    const data = await this.request<{ session: Session }>("POST", `/v1/lightroom/sessions/${id}/confirm`, {
      strength,
      ...(out ? { out } : {}),
    });
    return data.session;
  }

  async sessionReadyToImport(id: string): Promise<Session> {
    const data = await this.request<{ session: Session }>(
      "POST",
      `/v1/lightroom/sessions/${id}/ready-to-import`,
    );
    return data.session;
  }

  async sessionImported(id: string): Promise<Session> {
    const data = await this.request<{ session: Session }>("POST", `/v1/lightroom/sessions/${id}/imported`);
    return data.session;
  }

  async cancelSession(id: string): Promise<Session> {
    const data = await this.request<{ session: Session }>("POST", `/v1/lightroom/sessions/${id}/cancel`);
    return data.session;
  }
}
