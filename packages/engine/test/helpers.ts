/**
 * Test scaffolding for the engine: temporary stores plus a throwaway HTTP
 * server, so each test gets a clean home and library directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApiServer } from "../src/api.js";
import { History } from "../src/history.js";
import { SessionStore } from "../src/session.js";
import { App } from "../src/state.js";
import { Store } from "../src/store.js";

export interface TempApp {
  app: App;
  root: string;
  home: string;
  library: string;
  cleanup(): void;
}

/** Builds an App on fresh directories. */
export function tempApp(name: string, options: { model?: string } = {}): TempApp {
  const root = mkdtempSync(join(tmpdir(), `colorfm-${name}-`));
  const home = join(root, "home");
  const library = join(root, "lib");
  const store = Store.open(library, join(home, "tasks.json"));
  const sessions = SessionStore.open(join(home, "lightroom/sessions"));
  const history = History.open(join(library, "history"));
  const app = new App("test-token", options.model ?? join(root, "model.onnx"), store, sessions, history);
  return {
    app,
    root,
    home,
    library,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RunningApi {
  port: number;
  base: string;
  token: string;
  close(): Promise<void>;
}

/** Starts the API on an ephemeral loopback port. */
export async function startApi(app: App): Promise<RunningApi> {
  const server: Server = createApiServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    token: app.token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface ApiResponse {
  status: number;
  body: {
    ok: boolean;
    schema_version: number;
    data?: Record<string, unknown>;
    warnings?: string[];
    error?: { code: string; message: string };
  };
}

/** Calls the API with the bearer token, returning the parsed envelope. */
export async function call(
  api: RunningApi,
  method: string,
  path: string,
  body?: unknown,
  options: { token?: string | null } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = options.token === undefined ? api.token : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(api.base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ApiResponse["body"] };
}

/** Polls a job until it leaves the running states. */
export async function waitForJob(
  api: RunningApi,
  jobId: string,
  timeoutMs = 60_000,
): Promise<{ state: string; stage: string; result?: Record<string, unknown>; error?: { code: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(api, "GET", `/v1/jobs/${jobId}`);
    const job = response.body.data as unknown as {
      state: string;
      stage: string;
      result?: Record<string, unknown>;
      error?: { code: string };
    };
    if (job.state === "done" || job.state === "error" || job.state === "canceled") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish: ${job.state}/${job.stage}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
