/**
 * Differential test for the whole service.
 *
 * Both engines are started side by side against the same model, the same
 * export and the same reference, then driven through an identical request
 * sequence. The assertions are on things a client can observe: status codes,
 * error codes, session states, and the pixels of the rendered TIFF.
 *
 * The reference is the shipped Rust binary, so this is what catches a wire
 * format or state-machine drift that unit tests cannot see.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TiffReader } from "../../../core/src/io/codec/tiff.js";
import { encodePng16 as ours } from "../../../core/src/io/codec/png.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const RUST_BINARY = resolve(REPO_ROOT, "../colorfm-lightroom-rs/target/release/colorfm-engine");
const RUST_MODEL = resolve(REPO_ROOT, "../colorfm-lightroom-rs/models/colorfm_l.onnx");
const TS_ENTRY = resolve(REPO_ROOT, "packages/engine/dist/main.js");
const REFERENCE_BUILD = resolve(REPO_ROOT, "tools/reference/target/release/colorfm-reference");

const canRun =
  existsSync(RUST_BINARY) && existsSync(RUST_MODEL) && existsSync(TS_ENTRY) && existsSync(REFERENCE_BUILD);
const SKIP = canRun
  ? false
  : "needs the reference engine binary, the model, the reference harness and a built TypeScript engine";

interface Engine {
  base: string;
  token: string;
  process: ChildProcess;
  root: string;
}

function makeFixture(path: string, width: number, height: number): void {
  const request = join(path, "..", "fixture.json");
  writeFileSync(request, JSON.stringify({ path, width, height, kind: "wide" }));
  execFileSync(REFERENCE_BUILD, ["fixture", request], { encoding: "utf8" });
}

async function launch(
  command: string,
  args: string[],
  env: Record<string, string>,
  root: string,
): Promise<Engine> {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.COLORFM_DEBUG_WORKERS) process.stderr.write(`[${command.split("/").pop()}] ${chunk}`);
  });

  const line = await new Promise<string>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`engine did not start: ${stderr}`)), 20_000);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (text.includes("listening")) {
        clearTimeout(timer);
        resolveLine(text);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`engine exited with ${code}: ${stderr}`));
    });
  });

  const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1]);
  const discovery = JSON.parse(readFileSync(join(root, "home", "engine.json"), "utf8")) as { token: string };
  return { base: `http://127.0.0.1:${port}`, token: discovery.token, process: child, root };
}

interface Reply {
  status: number;
  body: {
    ok: boolean;
    schema_version: number;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

async function request(engine: Engine, method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(engine.base + path, {
    method,
    headers: { authorization: `Bearer ${engine.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply["body"] };
}

async function waitForTerminal(engine: Engine, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const reply = await request(engine, "GET", `/v1/jobs/${jobId}`);
    const job = reply.body.data as Record<string, unknown>;
    if (job.state === "done" || job.state === "error" || job.state === "canceled") return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`job ${jobId} never finished`);
}

function samplesOf(path: string): Uint16Array {
  const reader = TiffReader.open(path);
  try {
    const { width, height, chunkCount } = reader.info;
    const out = new Uint16Array(width * height * 3);
    let at = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = reader.readChunk(index);
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } finally {
    reader.close();
  }
}

describe.skipIf(SKIP)("engine differential", () => {
  const root = mkdtempSync(join(tmpdir(), "colorfm-engine-diff-"));
  let rust: Engine;
  let ts: Engine;
  let content: string;
  let reference: string;

  beforeAll(async () => {
    for (const name of ["rust", "ts"]) {
      mkdirSync(join(root, name, "home"), { recursive: true });
      mkdirSync(join(root, name, "lib"), { recursive: true });
    }
    content = join(root, "export.tiff");
    makeFixture(content, 64, 48);
    reference = join(root, "reference.png");
    const pixels = new Uint16Array(48 * 48 * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = 22000 + (i % 7000);
      pixels[i + 1] = 40000 - (i % 9000);
      pixels[i + 2] = 18000;
    }
    writeFileSync(reference, await ours(48, 48, pixels));

    rust = await launch(
      RUST_BINARY,
      ["serve", "--port", "0", "--model", RUST_MODEL, "--idle-exit", "0"],
      { COLORFM_HOME: join(root, "rust/home"), COLORFM_LIBRARY: join(root, "rust/lib") },
      join(root, "rust"),
    );
    ts = await launch(
      process.execPath,
      [TS_ENTRY, "serve", "--port", "0", "--idle-exit", "0"],
      {
        COLORFM_HOME: join(root, "ts/home"),
        COLORFM_LIBRARY: join(root, "ts/lib"),
        COLORFM_MODEL: RUST_MODEL,
      },
      join(root, "ts"),
    );
  }, 120_000);

  afterAll(async () => {
    for (const engine of [rust, ts]) {
      engine?.process.kill("SIGTERM");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the same capabilities and readiness", async () => {
    const [a, b] = [await request(rust, "GET", "/v1/health"), await request(ts, "GET", "/v1/health")];
    expect(a.status).toBe(b.status);
    expect(b.body.data?.capabilities).toEqual(a.body.data?.capabilities);
    expect(b.body.data?.model_loaded).toBe(true);
    expect(a.body.data?.model_loaded).toBe(true);
  });

  it("rejects a missing token with the same code", async () => {
    const unauth = await fetch(`${rust.base}/v1/health`);
    const oursUnauth = await fetch(`${ts.base}/v1/health`);
    expect(oursUnauth.status).toBe(unauth.status);
    const a = (await unauth.json()) as Reply["body"];
    const b = (await oursUnauth.json()) as Reply["body"];
    expect(b.error?.code).toBe(a.error?.code);
  });

  it("agrees on request validation", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/v1/jobs", { kind: "explode" }],
      ["POST", "/v1/lightroom/sessions", {}],
      ["POST", "/v1/lightroom/sessions", { content_path: "/tmp/nope-1234.tiff" }],
      ["POST", "/v1/lightroom/sessions/s_missing/claim", {}],
      ["GET", "/v1/jobs/j_missing", undefined],
    ];
    for (const [method, path, body] of cases) {
      const a = await request(rust, method, path, body);
      const b = await request(ts, method, path, body);
      expect({ status: b.status, code: b.body.error?.code }).toEqual({
        status: a.status,
        code: a.body.error?.code,
      });
    }
  });

  it("walks the same session states and produces the same pixels", async () => {
    const states: Array<[string[], string[]]> = [];

    const created = [
      await request(rust, "POST", "/v1/lightroom/sessions", { content_path: content, label: "export.tiff" }),
      await request(ts, "POST", "/v1/lightroom/sessions", { content_path: content, label: "export.tiff" }),
    ];
    expect(created[1].status).toBe(created[0].status);
    const sessions = created.map((reply) => reply.body.data?.session as Record<string, unknown>);
    expect(sessions[1].state).toBe(sessions[0].state);
    // The same fields, whatever their values.
    expect(Object.keys(sessions[1]).sort()).toEqual(Object.keys(sessions[0]).sort());

    const ids = sessions.map((session) => String(session.id));
    states.push([ids, [sessions[0].state as string, sessions[1].state as string]]);

    const claimed = await Promise.all(
      ids.map((id, index) => request(index === 0 ? rust : ts, "POST", `/v1/lightroom/sessions/${id}/claim`)),
    );
    const claimedStates = claimed.map((reply) => (reply.body.data?.session as Record<string, unknown>).state);
    expect(claimedStates[1]).toBe(claimedStates[0]);

    const previews = await Promise.all(
      ids.map((id, index) =>
        request(index === 0 ? rust : ts, "POST", `/v1/lightroom/sessions/${id}/preview`, {
          reference_path: reference,
          strength: 0.8,
        }),
      ),
    );
    expect(previews[1].status).toBe(previews[0].status);
    const previewJobs = previews.map((reply) =>
      String((reply.body.data?.session as Record<string, unknown>).preview_job_id),
    );
    const previewOutcome = await Promise.all([
      waitForTerminal(rust, previewJobs[0]),
      waitForTerminal(ts, previewJobs[1]),
    ]);
    expect(previewOutcome[1].state).toBe(previewOutcome[0].state);
    expect(previewOutcome[1].state).toBe("done");
    expect(previewOutcome[1].stage).toBe(previewOutcome[0].stage);

    const afterPreview = await Promise.all(
      ids.map((id, index) => request(index === 0 ? rust : ts, "GET", `/v1/lightroom/sessions/${id}`)),
    );
    const previewStates = afterPreview.map(
      (reply) => (reply.body.data?.session as Record<string, unknown>).state,
    );
    expect(previewStates[1]).toBe(previewStates[0]);
    expect(previewStates[0]).toBe("ready");

    const confirms = await Promise.all(
      ids.map((id, index) =>
        request(index === 0 ? rust : ts, "POST", `/v1/lightroom/sessions/${id}/confirm`, { strength: 0.8 }),
      ),
    );
    expect(confirms[1].status).toBe(confirms[0].status);
    const renderJobs = confirms.map((reply) =>
      String((reply.body.data?.session as Record<string, unknown>).render_job_id),
    );
    const renderOutcome = await Promise.all([
      waitForTerminal(rust, renderJobs[0]),
      waitForTerminal(ts, renderJobs[1]),
    ]);
    expect(renderOutcome[1].state).toBe(renderOutcome[0].state);
    expect(renderOutcome[1].state).toBe("done");

    const a = renderOutcome[0].result as Record<string, unknown>;
    const b = renderOutcome[1].result as Record<string, unknown>;
    expect(b.notice).toBe(a.notice);
    expect(b.metadata_preserved).toBe(a.metadata_preserved);
    expect(b.mode).toBe(a.mode);
    expect(b.grid).toBe(a.grid);
    expect(b.width).toBe(a.width);

    // The rendered pixels must match: same parameters, same LUT, same encoding.
    const theirs = samplesOf(String(a.out));
    const mine = samplesOf(String(b.out));
    expect(mine.length).toBe(theirs.length);
    let worst = 0;
    let differing = 0;
    for (let i = 0; i < mine.length; i += 1) {
      const delta = Math.abs(mine[i] - theirs[i]);
      if (delta !== 0) differing += 1;
      worst = Math.max(worst, delta);
    }
    // Same parameters, same table, same quantisation: the files must agree
    // exactly, not approximately.
    expect({ differing, worst }).toEqual({ differing: 0, worst: 0 });

    const ready = await Promise.all(
      ids.map((id, index) =>
        request(index === 0 ? rust : ts, "POST", `/v1/lightroom/sessions/${id}/ready-to-import`),
      ),
    );
    expect((ready[1].body.data?.session as Record<string, unknown>).state).toBe(
      (ready[0].body.data?.session as Record<string, unknown>).state,
    );

    const imported = await Promise.all(
      ids.map((id, index) =>
        request(index === 0 ? rust : ts, "POST", `/v1/lightroom/sessions/${id}/imported`),
      ),
    );
    expect((imported[1].body.data?.session as Record<string, unknown>).state).toBe(
      (imported[0].body.data?.session as Record<string, unknown>).state,
    );

    const history = await Promise.all([
      request(rust, "GET", "/v1/lightroom/history"),
      request(ts, "GET", "/v1/lightroom/history"),
    ]);
    const entries = history.map(
      (reply) => (reply.body.data?.entries as Array<Record<string, unknown>>).length,
    );
    expect(entries[1]).toBe(entries[0]);
    expect(entries[0]).toBe(1);
  }, 180_000);

  it("persists session files with the same field names", async () => {
    const dirs = [join(root, "rust/home/lightroom/sessions"), join(root, "ts/home/lightroom/sessions")];
    const files = dirs.map((dir) => readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    const shapes = files.map((text) => Object.keys(JSON.parse(text) as Record<string, unknown>).sort());
    expect(shapes[1]).toEqual(shapes[0]);
  });
});
