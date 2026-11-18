/**
 * Shared application state: the bearer token, the model, the job table, the
 * parameter cache and the session/history stores.
 *
 * Everything a request needs is reachable from here, which is why the HTTP
 * layer takes one object instead of a growing argument list.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { INPUT_SIZE, OnnxPredictor, type ParamPredictor, type Params, type Thumb } from "@colorfm/core";

import { EngineError } from "./errors.js";
import type { History } from "./history.js";
import type { Job } from "./jobs.js";
import type { SessionContext, SessionStore } from "./session.js";
import { nowSecs } from "./session.js";
import type { Store } from "./store.js";

export class App implements SessionContext {
  readonly token: string;
  /** Absolute path of the `.onnx` graph, or the path that was asked for. */
  readonly model: string;
  readonly jobs = new Map<string, Job>();
  readonly store: Store;
  readonly sessions: SessionStore;
  readonly history: History;
  readonly started = Date.now();

  private predictor: ParamPredictor | undefined;
  /** Serialises inference: one session run at a time, like a mutex. */
  private predictorQueue: Promise<unknown> = Promise.resolve();
  private counter = 1;
  private readonly jobNamespace: string;
  private activity = nowSecs();

  constructor(
    token: string,
    model: string,
    store: Store,
    sessions: SessionStore,
    history: History,
    jobNamespace?: string,
  ) {
    this.token = token;
    this.model = model;
    this.store = store;
    this.sessions = sessions;
    this.history = history;
    // Jobs are memory-only while sessions persist across restarts. A random
    // per-engine namespace keeps a new job from matching a stale job id left
    // on an older session.
    this.jobNamespace = jobNamespace ?? randomToken().slice(0, 12);
  }

  nextJobId(): string {
    const sequence = this.counter;
    this.counter += 1;
    return `j_${this.jobNamespace}_${sequence.toString(16)}`;
  }

  /** Records that someone is still using the engine. */
  touch(): void {
    this.activity = nowSecs();
  }

  /** Seconds since the last request or state change. */
  idleSecs(): number {
    return Math.max(0, nowSecs() - this.activity);
  }

  isReady(): boolean {
    return this.predictor !== undefined;
  }

  /**
   * Loads the model once, at startup. Keeping the session alive means a
   * per-image run does not pay the session creation cost again.
   */
  async loadModel(): Promise<void> {
    if (!existsSync(this.model)) {
      throw EngineError.model(`model not found: ${this.model}`);
    }
    const predictor = await OnnxPredictor.load(this.model, 4);
    this.predictor = predictor;
  }

  /**
   * Runs the model, serialised behind a queue so concurrent previews do not
   * fight over one session.
   */
  async predict(content: Thumb, style: Thumb): Promise<Params> {
    const run = async (): Promise<Params> => {
      const predictor = this.predictor;
      if (!predictor) throw EngineError.model("model is not loaded");
      return predictor.predict(content, style);
    };
    const result = this.predictorQueue.then(run, run);
    // Keep the chain alive even when this call rejects.
    this.predictorQueue = result.catch(() => undefined);
    return result;
  }

  /** No unfinished Lightroom session may outlive the engine. */
  hasActiveSessions(): boolean {
    return this.sessions.activeCount() > 0;
  }

  hasRunningJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.state === "queued" || job.state === "running") return true;
    }
    return false;
  }

  /** Model input size, reported by `/v1/health`. */
  get inputSize(): number {
    return INPUT_SIZE;
  }
}

/**
 * `~/Library/Application Support/ColorFM-LR`; override with `COLORFM_HOME` for
 * tests and non-macOS runs.
 */
export function homeDir(): string {
  if (process.env.COLORFM_HOME) return process.env.COLORFM_HOME;
  const home = process.env.HOME ?? homedir();
  if (home) return join(home, "Library/Application Support/ColorFM-LR");
  return join(tmpdir(), "ColorFM");
}

/** Where the working library lives: task cache, previews and history. */
export function libraryDir(): string {
  if (process.env.COLORFM_LIBRARY) return process.env.COLORFM_LIBRARY;
  const home = process.env.HOME ?? homedir();
  return join(home || tmpdir(), "Documents/ColorFM-LR");
}

/** Contents of `engine.json`, the file tools use to find the engine. */
export interface Discovery {
  pid: number;
  port: number;
  token: string;
}

/**
 * Writes `engine.json` with 0600 permissions. The token only guards against
 * accidental local calls; it is not a security boundary.
 */
export function writeDiscovery(home: string, discovery: Discovery): void {
  mkdirSync(home, { recursive: true });
  const path = join(home, "engine.json");
  const body = `{"schema_version":1,"pid":${discovery.pid},"http_port":${discovery.port},"token":"${discovery.token}"}`;
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without POSIX modes simply keeps the default.
  }
}

/** Reads the discovery file back, or `undefined` when there is none. */
export function readDiscovery(home: string): Discovery | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "engine.json"), "utf8")) as {
      pid: number;
      http_port: number;
      token: string;
    };
    return { pid: parsed.pid, port: parsed.http_port, token: parsed.token };
  } catch {
    return undefined;
  }
}

export function removeDiscovery(home: string): void {
  try {
    rmSync(join(home, "engine.json"), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/** Holds the single-instance lock for as long as the process lives. */
export class LockGuard {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  release(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Takes the single-instance lock. Throws when another live process holds it; a
 * stale lock (dead pid) is removed automatically.
 */
export function acquireLock(home: string): LockGuard {
  mkdirSync(home, { recursive: true });
  const path = join(home, "engine.lock");
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return new LockGuard(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw EngineError.io(`cannot create lock: ${(error as Error).message}`, error);
    }
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
    if (pid !== 0 && processAlive(pid)) {
      throw EngineError.internal(`another engine is running (pid ${pid}); remove ${path} if it is stale`);
    }
    rmSync(path, { force: true });
    return acquireLock(home);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 32 hex characters of process-unique randomness. */
export function randomToken(): string {
  return randomBytes(16).toString("hex");
}
