/**
 * End-to-end benchmark of the engine, driven over HTTP exactly as the desktop
 * window and the Lightroom plug-in drive it.
 *
 * It builds its own 32 MP single-strip source — the shape Lightroom exports —
 * so it needs no fixtures on disk. Each run gets a fresh home and library, and
 * the reported value is the median over `--reps` runs.
 *
 *   npx tsx tools/bench/engine.mts [--reps 3] [--width 6960] [--height 4640]
 *                                        [--workers 1,2,4,6,8]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Rgb16TiffWriter } from "../../packages/core/src/io/codec/tiff.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "models/colorfm_l.onnx");

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const REPS = Number(arg("reps", "3"));
const WIDTH = Number(arg("width", "6960"));
const HEIGHT = Number(arg("height", "4640"));
const WORKERS = arg("workers", "8,1")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Engine {
  child: ChildProcess;
  boot: number;
  call(method: string, path: string, body?: unknown): Promise<any>;
  stop(): Promise<void>;
}

interface Sample {
  boot: number;
  create: number;
  previewCold: number;
  previewWarm: number;
  render: number;
  total: number;
  renderStages: Map<string, number>;
  bytes: number;
}

/** A deterministic 16-bit frame with enough structure to resist compression. */
function writeSource(path: string): void {
  // One strip for the whole frame, which is what a Lightroom export looks like.
  const writer = new Rgb16TiffWriter(path, WIDTH, HEIGHT, HEIGHT);
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 3;
      samples[at] = (x * 65535) / (WIDTH - 1);
      samples[at + 1] = (y * 65535) / (HEIGHT - 1);
      samples[at + 2] = (x * 131 + y * 977) % 65536;
    }
  }
  writer.writeStrip(samples);
  writer.finish();
}

/** Starts one engine with a throwaway home and library. */
async function startEngine(workers: number): Promise<Engine> {
  const home = mkdtempSync(join(tmpdir(), "cf-bench-home-"));
  const library = mkdtempSync(join(tmpdir(), "cf-bench-lib-"));
  const child = spawn(
    process.execPath,
    [join(ROOT, "packages/engine/dist/main.js"), "serve", "--port", "0", "--idle-exit", "0"],
    {
      env: {
        ...process.env,
        COLORFM_HOME: home,
        COLORFM_LIBRARY: library,
        COLORFM_MODEL: MODEL,
        COLORFM_WORKERS: String(workers),
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  const started = performance.now();
  let port = 0;
  let token = "";
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const info = JSON.parse(readFileSync(join(home, "engine.json"), "utf8")) as {
        http_port: number;
        token: string;
      };
      const probe = await fetch(`http://127.0.0.1:${info.http_port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
      }).catch(() => null);
      if (probe?.ok) {
        port = info.http_port;
        token = info.token;
        break;
      }
    } catch {
      // Discovery file not written yet.
    }
    await sleep(20);
  }
  if (!port) throw new Error("engine never became healthy");

  const boot = performance.now() - started;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json();
  };

  return {
    child,
    boot,
    call,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
      rmSync(home, { recursive: true, force: true });
      rmSync(library, { recursive: true, force: true });
    },
  };
}

/** Polls a job at 10 ms, recording when each stage began. */
async function waitJob(
  engine: Engine,
  id: string,
): Promise<{ ms: number; stages: Map<string, number>; state: string }> {
  const started = performance.now();
  const seen: { stage: string; at: number }[] = [];
  for (;;) {
    const { data } = await engine.call("GET", `/v1/jobs/${id}`);
    if (seen[seen.length - 1]?.stage !== data.stage) {
      seen.push({ stage: data.stage, at: performance.now() - started });
    }
    if (["done", "error", "canceled"].includes(data.state)) {
      const ms = performance.now() - started;
      const stages = new Map<string, number>();
      seen.forEach((entry, index) => {
        const until = index + 1 < seen.length ? seen[index + 1].at : ms;
        stages.set(entry.stage, (stages.get(entry.stage) ?? 0) + (until - entry.at));
      });
      return { ms, stages, state: data.state };
    }
    await sleep(10);
  }
}

async function runOnce(engine: Engine, content: string, reference: string): Promise<Sample> {
  const createStarted = performance.now();
  const created = await engine.call("POST", "/v1/lightroom/sessions", {
    content_path: content,
    label: "bench.tif",
    strength: 1,
  });
  const id = created.data.session.id as string;
  const create = performance.now() - createStarted;

  await engine.call("POST", `/v1/lightroom/sessions/${id}/claim`);

  const previewStarted = performance.now();
  const preview = await engine.call("POST", `/v1/lightroom/sessions/${id}/preview`, {
    reference_path: reference,
    strength: 0.8,
  });
  const previewJob = await waitJob(engine, preview.data.session.preview_job_id);
  const previewCold = performance.now() - previewStarted;

  const warmStarted = performance.now();
  const warm = await engine.call("POST", `/v1/lightroom/sessions/${id}/preview`, { strength: 0.8 });
  await waitJob(engine, warm.data.session.preview_job_id);
  const previewWarm = performance.now() - warmStarted;

  const renderStarted = performance.now();
  const confirmed = await engine.call("POST", `/v1/lightroom/sessions/${id}/confirm`, { strength: 0.8 });
  const renderJob = await waitJob(engine, confirmed.data.session.render_job_id);
  const render = performance.now() - renderStarted;
  if (renderJob.state !== "done") throw new Error(`render ended in ${renderJob.state}`);

  const out = confirmed.data.session.output_path as string;
  if (previewJob.state !== "done") throw new Error(`preview ended in ${previewJob.state}`);

  return {
    boot: engine.boot,
    create,
    previewCold,
    previewWarm,
    render,
    total: engine.boot + create + previewCold + previewWarm + render,
    renderStages: renderJob.stages,
    bytes: statSync(out).size,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "cf-bench-src-"));
  const content = join(scratch, "source.tiff");
  const reference = join(scratch, "reference.tiff");
  writeSource(content);
  writeSource(reference);
  console.log(`${WIDTH}x${HEIGHT}, ${(statSync(content).size / 1e6).toFixed(0)} MB, ${REPS} runs each\n`);

  const configs = WORKERS.map((workers) => ({
    label: workers === 1 ? "1 worker" : `${workers} workers`,
    workers,
  }));
  const results = new Map<string, Sample[]>();

  const rounds = new Map<string, number[]>();
  for (const config of configs) {
    const runs: Sample[] = [];
    // One engine for every rep: that is what makes the second render cheaper —
    // the band pool and its JIT are already warm.
    const engine = await startEngine(config.workers);
    try {
      for (let rep = 0; rep < REPS; rep += 1) {
        runs.push(await runOnce(engine, content, reference));
      }
    } finally {
      await engine.stop();
    }
    results.set(config.label, runs);
    rounds.set(
      config.label,
      runs.map((run) => Math.round(run.render)),
    );
  }

  const width = 30;
  const steps: { key: keyof Sample; label: string }[] = [
    { key: "boot", label: "cold start → healthy" },
    { key: "create", label: "create session (preview JPEG)" },
    { key: "previewCold", label: "preview job (cold)" },
    { key: "previewWarm", label: "preview job (cached params)" },
    { key: "render", label: "render job → 16-bit TIFF" },
    { key: "total", label: "whole session" },
  ];

  console.log(`${"step".padEnd(width)}${configs.map((c) => c.label.padStart(16)).join("")}`);
  for (const step of steps) {
    const cells = configs.map((c) => {
      const values = (results.get(c.label) ?? []).map((r) => Number(r[step.key]));
      return `${Math.round(median(values))} ms`.padStart(16);
    });
    console.log(`${step.label.padEnd(width)}${cells.join("")}`);
  }

  console.log("");
  for (const config of configs) {
    console.log(`render by round, ${config.label}: ${(rounds.get(config.label) ?? []).join(" ms, ")} ms`);
  }
  for (const config of configs) {
    const runs = results.get(config.label) ?? [];
    const stages = runs[0]?.renderStages ?? new Map<string, number>();
    const cells = [...stages.entries()].map(([stage, ms]) => `${stage} ${Math.round(ms)} ms`);
    console.log(`\nrender stages, ${config.label}: ${cells.join("   ")}`);
    console.log(`output: ${(runs[0].bytes / 1e6).toFixed(0)} MB`);
  }

  rmSync(scratch, { recursive: true, force: true });
}

await main();
