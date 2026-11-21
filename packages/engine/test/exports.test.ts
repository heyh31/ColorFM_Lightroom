/**
 * Stray export cleanup.
 *
 * The cases that are easy to get wrong: a file whose session is still on screen
 * must survive (a retry re-reads it), an imported one belongs to the plug-in's
 * own setting, and an abandoned one has to take its session with it — otherwise
 * the window offers to continue a session whose content file is gone.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sweepExports } from "../src/exports.js";
import { newSession, nowSecs } from "../src/session.js";

import { tempApp } from "./helpers.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Writes `<library>/lightroom/<dir>/<file>` and returns its path. */
function exportFile(library: string, dir: string, file: string): string {
  const path = join(library, "lightroom", dir, file);
  mkdirSync(join(library, "lightroom", dir), { recursive: true });
  writeFileSync(path, "tiff");
  return path;
}

describe("sweepExports", () => {
  it("removes the export of a cancelled session", () => {
    const temp = tempApp("sweep-cancelled");
    cleanups.push(temp.cleanup);

    const path = exportFile(temp.library, "export-1", "IMG_0001.tif");
    const session = newSession("s_cancelled", path, "IMG_0001", 1, undefined);
    session.state = "canceled";
    temp.app.sessions.create(session);

    const swept = sweepExports(temp.app);
    expect(swept.removed).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(temp.library, "lightroom/export-1"))).toBe(false);
  });

  it("removes an export with no session record at all", () => {
    const temp = tempApp("sweep-orphan");
    cleanups.push(temp.cleanup);

    const orphan = exportFile(temp.library, "export-4", "IMG_0004.tif");
    const swept = sweepExports(temp.app);
    expect(swept.removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("keeps what a live session still needs", () => {
    const temp = tempApp("sweep-live");
    cleanups.push(temp.cleanup);

    const active = exportFile(temp.library, "export-2", "IMG_0002.tif");
    const failed = exportFile(temp.library, "export-3", "IMG_0003.tif");
    const imported = exportFile(temp.library, "export-5", "IMG_0005.tif");

    temp.app.sessions.create(newSession("s_active", active, "IMG_0002", 1, undefined));
    const retryable = newSession("s_error", failed, "IMG_0003", 1, undefined);
    retryable.state = "error";
    temp.app.sessions.create(retryable);
    const done = newSession("s_imported", imported, "IMG_0005", 1, undefined);
    done.state = "imported";
    temp.app.sessions.create(done);

    const swept = sweepExports(temp.app);
    expect(swept.removed).toEqual([]);
    expect(swept.kept).toBe(3);
    // A failed session is retryable, and the retry re-reads the export.
    expect(existsSync(failed)).toBe(true);
    // An imported export is the plug-in's call, not ours.
    expect(existsSync(imported)).toBe(true);
  });

  it("cancels an abandoned session and takes its export", () => {
    const temp = tempApp("sweep-stale");
    cleanups.push(temp.cleanup);

    const path = exportFile(temp.library, "export-6", "IMG_0006.tif");
    const session = newSession("s_stale", path, "IMG_0006", 1, undefined);
    // Older than the rule, and freshly "touched" — recovery does exactly this
    // to every session it loads, so the sweep must not trust `updated_at`.
    session.created_at = nowSecs() - 3600;
    session.updated_at = nowSecs();
    temp.app.sessions.create(session);

    const swept = sweepExports(temp.app, { staleSecs: 30 * 60 });
    expect(swept.removed).toEqual([path]);
    expect(swept.cancelled).toEqual(["s_stale"]);
    // The session must not keep pointing at a file that is gone.
    expect(temp.app.sessions.get("s_stale")?.state).toBe("canceled");
  });

  it("cancels a stale session whose export is already gone", () => {
    const temp = tempApp("sweep-stale-gone");
    cleanups.push(temp.cleanup);

    const path = join(temp.library, "lightroom", "export-8", "IMG_0008.tif");
    const session = newSession("s_zombie", path, "IMG_0008", 1, undefined);
    session.created_at = nowSecs() - 3600;
    session.updated_at = nowSecs();
    temp.app.sessions.create(session);

    const swept = sweepExports(temp.app, { staleSecs: 30 * 60 });
    expect(swept.cancelled).toEqual(["s_zombie"]);
    expect(swept.removed).toEqual([]);
    expect(temp.app.sessions.get("s_zombie")?.state).toBe("canceled");
  });

  it("drops a stale errored session, which cannot be cancelled or retried", () => {
    const temp = tempApp("sweep-stale-error");
    cleanups.push(temp.cleanup);

    const session = newSession(
      "s_dead",
      join(temp.library, "lightroom/export-9/x.tif"),
      "IMG_0009",
      1,
      undefined,
    );
    session.state = "error";
    session.created_at = nowSecs() - 3600;
    temp.app.sessions.create(session);

    const swept = sweepExports(temp.app, { staleSecs: 30 * 60 });
    expect(swept.cancelled).toEqual(["s_dead"]);
    expect(temp.app.sessions.get("s_dead")).toBeUndefined();
  });

  it("leaves a recent session alone even with a staleness rule", () => {
    const temp = tempApp("sweep-fresh");
    cleanups.push(temp.cleanup);

    const path = exportFile(temp.library, "export-7", "IMG_0007.tif");
    temp.app.sessions.create(newSession("s_fresh", path, "IMG_0007", 1, undefined));

    const swept = sweepExports(temp.app, { staleSecs: 30 * 60 });
    expect(swept.removed).toEqual([]);
    expect(temp.app.sessions.get("s_fresh")?.state).not.toBe("canceled");
  });

  it("leaves the rest of the library alone", () => {
    const temp = tempApp("sweep-scope");
    cleanups.push(temp.cleanup);

    const result = join(temp.library, "IMG_0008_ColorFM.tif");
    writeFileSync(result, "rendered");
    const historyFile = join(temp.library, "history", "s_x", "entry.json");
    mkdirSync(join(temp.library, "history", "s_x"), { recursive: true });
    writeFileSync(historyFile, "{}");

    sweepExports(temp.app);
    expect(existsSync(result)).toBe(true);
    expect(existsSync(historyFile)).toBe(true);
  });
});
