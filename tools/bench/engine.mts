/**
 * Cross-implementation benchmark: the same session run against two engines.
 *
 * Both are driven over HTTP only, exactly as the desktop window and the
 * Lightroom plug-in drive them, so the numbers include the server, the worker
 * threads, the model run and the file I/O — not just the arithmetic.
 *
 *   npx tsx tools/bench/engine.mts [--content path] [--reference path] [--reps 3]
 *
 * Each engine gets a fresh home and library per repetition. The reported value
 * is the median, which is what matters on a machine that is doing other things.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUST = resolve(ROOT, "../colorfm-lightroom-rs/target/release/colorfm-engine");
const MODEL = join(ROOT, "models/colorfm_l.onnx");

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const CONTENT = resolve(arg("content", "/tmp/mp32.tiff"));
const REFERENCE = resolve(arg("reference", "/tmp/bench-ref.tiff"));
const REPS = Number(arg("reps", "3"));

interface Engine {
  child: ChildProcess;
  /** Milliseconds from spawn to the first healthy response. */
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
  /** Wall time inside each stage of the preview job, and of the render job. */
  previewStages: Map<string, number>;
  renderStages: Map<string, number>;
  digest: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(command: string, args: string[], env: Record<string, string>): Promise<Engine> {
  const started = performance.now();
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });

  const discovery = join(env.COLORFM_HOME, "engine.json");
  let info: { http_port: number; token: string } | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(discovery, "utf8");
      const parsed = JSON.parse(text);
      const probe = await fetch(`http://127.0.0.1:${parsed.http_port}/v1/health`, {
        headers: { authorization: `Bearer ${parsed.token}` },
      }).catch(() => undefined);
      if (probe?.ok) {
        info = parsed;
        break;
      }
    } catch {
      // Not written yet, or half-written: retry.
    }
    await sleep(20);
  }
  if (!info) throw new Error(`engine did not start: ${stderr.slice(-400)}`);
  const boot = performance.now() - started;

  const base = `http://127.0.0.1:${info.http_port}`;
  return {
    child,
    boot,
    async call(method, path, body) {
      const response = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${info!.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json: any = await response.json();
      return { ...json, status: response.status };
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
    },
  } as Engine;
}

/** Polls a job at 10 ms, recording when each stage began. */
async function waitJob(
  engine: Engine,
  id: string,
): Promise<{ ms: number; stages: Map<string, number>; state: string; error?: unknown }> {
  const started = performance.now();
  const seen: { stage: string; at: number }[] = [];
  for (;;) {
    const { data } = await engine.call("GET", `/v1/jobs/${id}`);
    if (seen[seen.length - 1]?.stage !== data.stage) {
      seen.push({ stage: data.stage, at: performance.now() - started });
    }
    if (["done", "error", "canceled"].includes(data.state)) {
      const ms = performance.now() - started;
      // A stage lasts until the next one starts; the last runs to completion.
      const stages = new Map<string, number>();
      seen.forEach((entry, index) => {
        const until = index + 1 < seen.length ? seen[index + 1].at : ms;
        stages.set(entry.stage, (stages.get(entry.stage) ?? 0) + (until - entry.at));
      });
      return { ms, stages, state: data.state, error: data.error };
    }
    await sleep(10);
  }
}

async function runOnce(label: string, env: Record<string, string>): Promise<Sample> {
  const engine = await launch(
    label === "rust" ? RUST : process.execPath,
    label === "rust"
      ? ["serve", "--port", "0", "--model", MODEL, "--idle-exit", "0"]
      : [join(ROOT, "packages/engine/dist/main.js"), "serve", "--port", "0", "--idle-exit", "0"],
    env,
  );

  try {
    let t = performance.now();
    const created = await engine.call("POST", "/v1/lightroom/sessions", {
      content_path: CONTENT,
      label: "bench.tif",
      strength: 1,
    });
    if (!created.ok) throw new Error(`create: ${JSON.stringify(created.error)}`);
    const create = performance.now() - t;
    const id = created.data.session.id;

    await engine.call("POST", `/v1/lightroom/sessions/${id}/claim`);

    t = performance.now();
    const preview = await engine.call("POST", `/v1/lightroom/sessions/${id}/preview`, {
      reference_path: REFERENCE,
      strength: 0.8,
    });
    const previewJob = await waitJob(engine, String(preview.data.session.preview_job_id));
    if (previewJob.state !== "done") throw new Error(`preview: ${JSON.stringify(previewJob.error)}`);
    const previewCold = previewJob.ms;

    t = performance.now();
    const again = await engine.call("POST", `/v1/lightroom/sessions/${id}/preview`, {
      reference_path: REFERENCE,
      strength: 0.5,
    });
    const warmJob = await waitJob(engine, String(again.data.session.preview_job_id));
    if (warmJob.state !== "done") throw new Error(`preview 2: ${JSON.stringify(warmJob.error)}`);
    const previewWarm = warmJob.ms;

    t = performance.now();
    const confirm = await engine.call("POST", `/v1/lightroom/sessions/${id}/confirm`, { strength: 0.8 });
    if (!confirm.ok) throw new Error(`confirm: ${JSON.stringify(confirm.error)}`);
    const renderJob = await waitJob(engine, String(confirm.data.session.render_job_id));
    if (renderJob.state !== "done") throw new Error(`render: ${JSON.stringify(renderJob.error)}`);
    const render = renderJob.ms;

    const out = confirm.data.session.output_path as string;
    const digest = createHash("sha256").update(readFileSync(out)).digest("hex").slice(0, 16);

    // The cold run only: folding in the warm one would double-count the stages
    // and make the parts add up to more than the job.
    const previewStages = previewJob.stages;

    return {
      boot: engine.boot,
      create,
      previewCold,
      previewWarm,
      render,
      total: engine.boot + create + previewCold + previewWarm + render,
      previewStages,
      renderStages: renderJob.stages,
      digest,
    };
  } finally {
    await engine.stop();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const engines: { label: string; env: () => Record<string, string>; runs: Sample[] }[] = [
  {
    label: "ts (all cores)",
    env: () => ({
      COLORFM_HOME: mkdtempSync(join(tmpdir(), "cf-b-tsh-")),
      COLORFM_LIBRARY: mkdtempSync(join(tmpdir(), "cf-b-tsl-")),
      COLORFM_MODEL: MODEL,
    }),
    runs: [],
  },
  {
    label: "ts (1 worker)",
    env: () => ({
      COLORFM_HOME: mkdtempSync(join(tmpdir(), "cf-b-ts1h-")),
      COLORFM_LIBRARY: mkdtempSync(join(tmpdir(), "cf-b-ts1l-")),
      COLORFM_MODEL: MODEL,
      COLORFM_WORKERS: "1",
    }),
    runs: [],
  },
  {
    label: "rust",
    env: () => ({
      COLORFM_HOME: mkdtempSync(join(tmpdir(), "cf-b-rsh-")),
      COLORFM_LIBRARY: mkdtempSync(join(tmpdir(), "cf-b-rsl-")),
    }),
    runs: [],
  },
];

if (!statSync(CONTENT).isFile()) throw new Error(`no content at ${CONTENT}`);
if (!statSync(REFERENCE).isFile()) throw new Error(`no reference at ${REFERENCE}`);

for (let rep = 0; rep < REPS; rep += 1) {
  for (const engine of engines) {
    const env = engine.env();
    process.stderr.write(`rep ${rep + 1}/${REPS} ${engine.label} … `);
    const sample = await runOnce(engine.label.startsWith("rust") ? "rust" : "ts", env);
    engine.runs.push(sample);
    for (const dir of [env.COLORFM_HOME, env.COLORFM_LIBRARY]) rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`${Math.round(sample.total)} ms\n`);
  }
}

const steps: [keyof Sample, string][] = [
  ["boot", "cold start → healthy"],
  ["create", "create session (preview JPEG)"],
  ["previewCold", "preview job (cold)"],
  ["previewWarm", "preview job (cached params)"],
  ["render", "render job → 16-bit TIFF"],
  ["total", "sum of the above"],
];

const width = 30;
console.log(`\n${"step".padEnd(width)}${engines.map((e) => e.label.padStart(16)).join("")}`);
for (const [key, label] of steps) {
  const cells = engines.map((e) => `${Math.round(median(e.runs.map((r) => Number(r[key]))))} ms`.padStart(16));
  console.log(`${label.padEnd(width)}${cells.join("")}`);
}
console.log(`\nbaseline: rust = 1.00×; lower TS numbers are faster`);
for (const step of ["previewCold", "render", "total"] as const) {
  const rust = median(engines[2].runs.map((r) => Number(r[step])));
  const cells = engines.map((e) => `${(median(e.runs.map((r) => Number(r[step]))) / rust).toFixed(2)}×`.padStart(16));
  console.log(`${step.padEnd(width)}${cells.join("")}`);
}
function stageTable(title: string, pick: (s: Sample) => Map<string, number>, names: string[]): void {
  console.log(`\n${title}`);
  console.log(`${"stage".padEnd(width)}${engines.map((e) => e.label.padStart(16)).join("")}`);
  for (const name of names) {
    const cells = engines.map((e) => {
      const values = e.runs.map((r) => pick(r).get(name) ?? 0);
      const observed = values.some((v) => v > 0);
      return (observed ? `${Math.round(median(values))} ms` : "—").padStart(16);
    });
    console.log(`${name.padEnd(width)}${cells.join("")}`);
  }
}

stageTable("preview job, stage by stage (cold run)", (s) => s.previewStages, [
  "thumbnail",
  "params",
  "bake",
  "preview",
  "encode",
]);
stageTable("render job, stage by stage", (s) => s.renderStages, ["thumbnail", "params", "bake", "apply"]);

console.log(`\noutput sha256: ${engines.map((e) => `${e.label}=${e.runs[0].digest}`).join("  ")}`);
const same = engines.every((e) => e.runs.every((r) => r.digest === engines[0].runs[0].digest));
console.log(`identical pixels: ${same ? "yes" : "NO — the comparison is measuring different work"}`);
