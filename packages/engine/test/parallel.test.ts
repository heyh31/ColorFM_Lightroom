/**
 * The banded render: the same job, split across worker threads.
 *
 * The output has to be byte-identical to a single-threaded render, because the
 * pixels a band produces do not depend on which thread ran it. A regression here
 * would show up as a seam, a duplicated strip or a missing one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Rgb16TiffWriter, TiffReader } from "../../core/src/io/codec/tiff.js";

import { call, startApi, tempApp, waitForJob } from "./helpers.js";

const SKIP = false;

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 240x360 split into 30-row strips: twelve bands, so the fan-out engages. */
function makeFixture(dir: string): { content: string; params: string } {
  const content = join(dir, "export.tiff");
  const width = 240;
  const height = 360;
  const rowsPerStrip = 30;
  const writer = new Rgb16TiffWriter(content, width, height, rowsPerStrip);
  for (let first = 0; first < height; first += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - first);
    const samples = new Uint16Array(rows * width * 3);
    for (let r = 0; r < rows; r += 1) {
      const y = first + r;
      for (let x = 0; x < width; x += 1) {
        const at = (r * width + x) * 3;
        samples[at] = (x * 131 + y * 977) % 65536;
        samples[at + 1] = (x * 4099 + y * 61) % 65536;
        samples[at + 2] = (x * 257 + y * 6553) % 65536;
      }
    }
    writer.writeStrip(samples);
  }
  writer.finish();

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
