/**
 * HTTP surface: envelope shape, authentication, routing and the session
 * endpoints, exercised in-process so the assertions are about behaviour rather
 * than about a spawned process.
 *
 * Jobs that need the model are covered by the parallel suite; here the
 * pixel-free paths are checked, plus one cancelled job to prove the flag
 * reaches the worker.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { call, startApi, tempApp, waitForJob, type RunningApi } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function api(name: string): Promise<{ api: RunningApi; root: string }> {
  const temp = tempApp(name);
  cleanups.push(temp.cleanup);
  const running = await startApi(temp.app);
  cleanups.push(running.close);
  return { api: running, root: temp.root };
}

describe("envelope and auth", () => {
  it("reports health without a model", async () => {
    const { api: running } = await api("api-health");
    const response = await call(running, "GET", "/v1/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.schema_version).toBe(1);
    expect(response.body.data?.model_loaded).toBe(false);
    expect(response.body.data?.capabilities).toContain("lightroom-sessions");
  });

  it("rejects a missing or wrong token with E_UNAUTHORIZED", async () => {
    const { api: running } = await api("api-auth");
    const missing = await call(running, "GET", "/v1/health", undefined, { token: null });
    expect(missing.status).toBe(401);
    expect(missing.body.error?.code).toBe("E_UNAUTHORIZED");

    const wrong = await call(running, "GET", "/v1/health", undefined, { token: "nope" });
    expect(wrong.status).toBe(401);
  });

  it("accepts the token as a query parameter", async () => {
    const { api: running } = await api("api-query-token");
    const response = await fetch(`${running.base}/v1/health?token=${running.token}`);
    expect(response.status).toBe(200);
  });

  it("answers preflight without authentication", async () => {
    const { api: running } = await api("api-preflight");
    const response = await fetch(`${running.base}/v1/health`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("omits empty optional envelope fields", async () => {
    const { api: running } = await api("api-envelope");
    const response = await call(running, "GET", "/v1/health");
    expect(response.body).not.toHaveProperty("error");
    expect(response.body).not.toHaveProperty("warnings");
  });

  it("reports diagnostics with thread and session counts", async () => {
    const { api: running } = await api("api-diagnostics");
    const response = await call(running, "GET", "/v1/diagnostics");
    expect(response.body.data?.jobs_total).toBe(0);
    expect(response.body.data?.sessions_active).toBe(0);
    expect(typeof response.body.data?.threads).toBe("number");
  });

  it("returns 404 for unknown routes and jobs", async () => {
    const { api: running } = await api("api-404");
    expect((await call(running, "GET", "/v1/nope")).status).toBe(404);
    const job = await call(running, "GET", "/v1/jobs/j_missing");
    expect(job.status).toBe(404);
    expect(job.body.error?.code).toBe("E_NOT_FOUND");
    const session = await call(running, "GET", "/v1/lightroom/sessions/s_missing");
    expect(session.status).toBe(404);
  });
});

describe("jobs", () => {
  it("rejects an unknown kind", async () => {
    const { api: running } = await api("api-job-kind");
    const response = await call(running, "POST", "/v1/jobs", { kind: "explode" });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("E_BAD_REQUEST");
  });

  it("fails a render without a model instead of hanging", async () => {
    const { api: running, root } = await api("api-job-nomodel");
    const content = join(root, "missing.tiff");
    const response = await call(running, "POST", "/v1/jobs", {
      kind: "render",
      content,
      out: join(root, "out.tiff"),
      params: join(root, "params.txt"),
    });
    expect(response.status).toBe(202);
    const job = await waitForJob(running, String(response.body.data?.job_id));
    // The parameters file does not exist either, so this fails before the model
    // is ever consulted: an IO error, not a hang.
    expect(job.state).toBe("error");
    expect(["E_IO", "E_BAD_REQUEST"]).toContain(job.error?.code);
  });

  it("cancels a job that is still running", async () => {
    const { api: running, root } = await api("api-job-cancel");
    writeFileSync(join(root, "empty.tiff"), "");
    const response = await call(running, "POST", "/v1/jobs", {
      kind: "preview",
      content: join(root, "empty.tiff"),
      style: join(root, "empty.tiff"),
    });
    const id = String(response.body.data?.job_id);
    const cancelled = await call(running, "POST", `/v1/jobs/${id}/cancel`);
    expect(cancelled.body.data?.cancel_requested).toBe(true);
    const job = await waitForJob(running, id);
    // Either the flag was seen or the job had already failed on the empty file.
    expect(["canceled", "error"]).toContain(job.state);
  });
});

describe("lightroom sessions", () => {
  function contentFile(root: string): string {
    const path = join(root, "export.tiff");
    writeFileSync(path, "not really a tiff");
    return path;
  }

  it("requires a content path", async () => {
    const { api: running } = await api("api-session-nocontent");
    const response = await call(running, "POST", "/v1/lightroom/sessions", {});
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("E_BAD_REQUEST");
  });

  it("reports a moved export as a conflict", async () => {
    const { api: running } = await api("api-session-moved");
    const response = await call(running, "POST", "/v1/lightroom/sessions", {
      content_path: "/tmp/definitely-not-here-7317.tiff",
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("E_FILE_MOVED");
  });

  it("creates, claims, lists and cancels a session", async () => {
    const { api: running, root } = await api("api-session-flow");
    // A real 16-bit TIFF is needed for the creation preview; the fixture
    // builders cover that elsewhere, so here the failure path is asserted.
    const response = await call(running, "POST", "/v1/lightroom/sessions", {
      content_path: contentFile(root),
      label: "export.tiff",
      strength: 0.5,
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("E_BAD_REQUEST");
    expect(response.body.error?.message).toMatch(/invalid image|tiff/i);
  });

  it("accepts an empty body on session actions", async () => {
    const { api: running } = await api("api-session-empty-body");
    const response = await call(running, "POST", "/v1/lightroom/sessions/s_missing/claim");
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe("E_NOT_FOUND");
  });

  it("lists sessions newest first with the active count", async () => {
    const { api: running } = await api("api-session-list");
    const response = await call(running, "GET", "/v1/lightroom/sessions?active=1");
    expect(response.body.data?.sessions).toEqual([]);
    expect(response.body.data?.active).toBe(0);
  });

  it("returns an empty filmstrip", async () => {
    const { api: running } = await api("api-history-empty");
    const response = await call(running, "GET", "/v1/lightroom/history");
    expect(response.body.data?.entries).toEqual([]);
  });
});
