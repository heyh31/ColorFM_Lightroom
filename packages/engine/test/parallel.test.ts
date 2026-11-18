/**
 * The banded render: the same job, split across worker threads.
 *
 * The output has to be byte-identical to a single-threaded render, because the
 * pixels a band produces do not depend on which thread ran it. A regression here
 * would show up as a seam, a duplicated strip or a missing one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { TiffReader } from "../../core/src/io/codec/tiff.js";

import { call, startApi, tempApp, waitForJob } from "./helpers.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const REFERENCE = resolve(REPO_ROOT, "tools/reference/target/release/colorfm-reference");

function fixtureAvailable(): boolean {
  try {
    readFileSync(REFERENCE);
    return true;
  } catch {
    return false;
  }
}

const SKIP = fixtureAvailable() ? false : "reference harness missing: run `npm run reference:build`";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 240x360 split into 30-row strips: twelve bands, so the fan-out engages. */
function makeFixture(dir: string): { content: string; params: string } {
  const content = join(dir, "export.tiff");
  const request = join(dir, "fixture.json");
  writeFileSync(
    request,
    JSON.stringify({ path: content, width: 240, height: 360, kind: "wide", rows_per_strip: 30 }),
  );
  // The harness writes the fixture: the only way to get a multi-strip file
  // without duplicating the encoder in the test.
  execFileSync(REFERENCE, ["fixture", request], { encoding: "utf8" });

  const params = join(dir, "params.txt");
  const values: string[] = [];
  for (let i = 0; i < 1248; i += 1) values.push(String(Math.fround(((i * 37) % 101) / 101 - 0.5)));
  writeFileSync(params, `${values.join("\n")}\n`);
  return { content, params };
}

async function render(paramsFile: string, content: string, out: string, workers: number): Promise<string> {
  const temp = tempApp(`parallel-${workers}`);
  roots.push(temp.root);
  const api = await startApi(temp.app);
  closers.push(api.close);
  process.env.COLORFM_WORKERS = String(workers);
  try {
    const created = await call(api, "POST", "/v1/jobs", {
      kind: "render",
      content,
      out,
      params: paramsFile,
      grid: 17,
      strength: 0.8,
    });
    const job = await waitForJob(api, String(created.body.data?.job_id));
    expect({ state: job.state, error: job.error }).toEqual({ state: "done", error: undefined });
    return out;
  } finally {
    delete process.env.COLORFM_WORKERS;
    await api.close();
  }
}

describe.skipIf(SKIP)("banded render", () => {
  it("produces the same bytes with four workers as with one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colorfm-bands-"));
    roots.push(dir);
    const { content, params } = makeFixture(dir);

    const reader = TiffReader.open(content);
    const strips = reader.info.chunkCount;
    reader.close();
    expect(strips).toBeGreaterThan(4);

    const single = join(dir, "single.tiff");
    const banded = join(dir, "banded.tiff");
    await render(params, content, single, 1);
    await render(params, content, banded, 4);

    const a = readFileSync(single);
    const b = readFileSync(banded);
    expect(b.length).toBe(a.length);
    let firstDifference = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        firstDifference = i;
        break;
      }
    }
    expect(firstDifference).toBe(-1);
  }, 60_000);
});
