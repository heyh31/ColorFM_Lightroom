/**
 * Parameter cache and history snapshots: the two places the engine writes
 * files it later has to find again.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { paramsFromSlice, paramsToVec, type Thumb } from "@colorfm/core";

import { History } from "../src/history.js";
import { newSession, type Session } from "../src/session.js";
import { Store, thumbKey, timestampId } from "../src/store.js";
import { tempApp } from "./helpers.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempStore(name: string): { store: Store; home: string; library: string } {
  const temp = tempApp(name);
  cleanups.push(temp.cleanup);
  return { store: temp.app.store, home: temp.home, library: temp.library };
}

function thumb(value: number): Thumb {
  return { width: 2, height: 2, pixels: new Float32Array(12).fill(value) };
}

describe("parameter cache", () => {
  it("round trips parameters and the index", () => {
    const { store } = tempStore("store-roundtrip");
    const entry = store.create("c1", "s1", "m1");
    expect(store.find("c1", "s1", "m1")?.id).toBe(entry.id);
    expect(store.find("c1", "s2", "m1")).toBeUndefined();

    const params = paramsFromSlice(new Array(1248).fill(0.25));
    store.saveParams(entry, params);
    const loaded = store.loadParams(entry);
    expect(loaded).toBeDefined();
    expect(paramsToVec(loaded!)).toEqual(paramsToVec(params));
  });

  it("writes params.bin as little-endian f32", () => {
    const { store } = tempStore("store-params-bytes");
    const entry = store.create("c1", "s1", "m1");
    const params = paramsFromSlice(new Array(1248).fill(0.5));
    store.saveParams(entry, params);
    const bytes = readFileSync(join(store.dirOf(entry), "params.bin"));
    expect(bytes.length).toBe(1248 * 4);
    expect(bytes.readFloatLE(0)).toBe(0.5);
  });

  it("treats a truncated params.bin as missing", () => {
    const { store } = tempStore("store-params-broken");
    const entry = store.create("c1", "s1", "m1");
    writeFileSync(join(store.dirOf(entry), "params.bin"), Buffer.alloc(16));
    expect(store.loadParams(entry)).toBeUndefined();
  });

  it("puts previews beside the task that produced them", () => {
    const { store } = tempStore("store-preview-task");
    const entry = store.create("c1", "s1", "m1");
    const path = store.savePreview(entry, "j_1", "content-1280.jpg", new Uint8Array([1, 2, 3]));
    expect(path).toBe(join(store.dirOf(entry), "content-1280.jpg"));
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("falls back to the job cache when there is no task", () => {
    const { store, library } = tempStore("store-preview-cache");
    const path = store.savePreview(undefined, "j_2", "result-1280.jpg", new Uint8Array([4]));
    expect(path).toBe(join(library, "cache/previews/j_2/result-1280.jpg"));
    expect(existsSync(path)).toBe(true);
  });

  it("survives a reopen", () => {
    const { store, home, library } = tempStore("store-reopen");
    const entry = store.create("c1", "s1", "m1");
    const reopened = Store.open(library, join(home, "tasks.json"));
    expect(reopened.find("c1", "s1", "m1")?.id).toBe(entry.id);
  });

  it("ignores an index from another schema", () => {
    const { store, home, library } = tempStore("store-schema");
    store.create("c1", "s1", "m1");
    const indexPath = join(home, "tasks.json");
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { schema_version: number };
    parsed.schema_version = 99;
    writeFileSync(indexPath, JSON.stringify(parsed));
    expect(Store.open(library, indexPath).find("c1", "s1", "m1")).toBeUndefined();
  });

  it("keys thumbnails by their pixels", () => {
    expect(thumbKey(thumb(0.1))).toBe(thumbKey(thumb(0.1)));
    expect(thumbKey(thumb(0.1))).not.toBe(thumbKey(thumb(0.2)));
    expect(thumbKey(thumb(0.1))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("names tasks so they sort chronologically", () => {
    const early = timestampId(1_700_000_000, "aaa");
    const late = timestampId(1_700_000_100, "bbb");
    expect(early < late).toBe(true);
    expect(early).toHaveLength("20231114-221320_aaa".length);
  });
});

function sessionWithThumbs(dir: string): Session {
  const result = join(dir, "result-1280.jpg");
  const reference = join(dir, "style-1280.jpg");
  writeFileSync(result, "graded");
  writeFileSync(reference, "reference");

  const session = newSession("s_hist", "/tmp/base.tif", "IMG_0001.tif", 0.8, undefined);
  session.state = "imported";
  session.result_path = "/tmp/IMG_0001_ColorFM.tif";
  session.preview_after_path = result;
  session.preview_style_path = reference;
  return session;
}

describe("history", () => {
  it("snapshots imported sessions with stable thumbnails", () => {
    const temp = tempApp("history-record");
    cleanups.push(temp.cleanup);
    const history = History.open(join(temp.library, "history"));
    const session = sessionWithThumbs(temp.root);

    const entry = history.record(session);
    expect(entry.result_thumb).toBeDefined();
    expect(entry.reference_thumb).toBeDefined();

    // The session's preview may be overwritten later; history must not care.
    writeFileSync(session.preview_after_path!, "newer");
    const listed = history.list();
    expect(listed).toHaveLength(1);
    expect(readFileSync(listed[0].result_thumb!)).toEqual(Buffer.from("graded"));
  });

  it("lists newest first and survives a reopen", () => {
    const temp = tempApp("history-list");
    cleanups.push(temp.cleanup);
    const dir = join(temp.library, "history");
    {
      const history = History.open(dir);
      const early = sessionWithThumbs(temp.root);
      early.id = "s_early";
      history.record(early, 1_700_000_000);
      const late = sessionWithThumbs(temp.root);
      late.id = "s_late";
      history.record(late, 1_700_000_100);
    }
    const reopened = History.open(dir);
    const listed = reopened.list();
    expect(listed).toHaveLength(2);
    expect(listed[0].id).toBe("s_late");
  });

  it("keeps an entry even when previews are missing", () => {
    const temp = tempApp("history-no-thumbs");
    cleanups.push(temp.cleanup);
    const history = History.open(join(temp.library, "history"));
    const session = newSession("s_bare", "/tmp/base.tif", "IMG.tif", 1, undefined);
    session.state = "imported";

    const entry = history.record(session);
    expect(entry.result_thumb).toBeUndefined();
    expect(history.list()).toHaveLength(1);
  });

  it("includes rendered-but-unimported sessions", () => {
    const temp = tempApp("history-collect-live");
    cleanups.push(temp.cleanup);
    const history = History.open(join(temp.library, "history"));
    const session = sessionWithThumbs(temp.root);
    session.id = "s_ready";
    session.state = "ready_to_import";

    const listed = history.collect([session]);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("s_ready");
    // Points straight at the session's preview, not at a copy.
    expect(listed[0].result_thumb).toBe(session.preview_after_path);
  });

  it("leaves preview-only sessions out", () => {
    const temp = tempApp("history-collect-preview-only");
    cleanups.push(temp.cleanup);
    const history = History.open(join(temp.library, "history"));
    const session = newSession("s_preview", "/tmp/base.tif", "IMG.tif", 1, undefined);
    session.state = "ready";
    session.preview_after_path = "/tmp/result-1280.jpg";

    expect(history.collect([session])).toHaveLength(0);
  });

  it("prefers the snapshot of an imported session", () => {
    const temp = tempApp("history-collect-snapshot");
    cleanups.push(temp.cleanup);
    const history = History.open(join(temp.library, "history"));
    const session = sessionWithThumbs(temp.root);
    session.state = "imported";
    const snapshot = history.record(session);

    // The task's preview is re-graded afterwards; the strip must not change.
    writeFileSync(session.preview_after_path!, "newer");

    const listed = history.collect([session]);
    expect(listed).toHaveLength(1);
    expect(listed[0].result_thumb).toBe(snapshot.result_thumb);
    expect(readFileSync(listed[0].result_thumb!)).toEqual(Buffer.from("graded"));
  });
});
