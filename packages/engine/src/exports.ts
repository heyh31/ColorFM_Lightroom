/**
 * Removes exported TIFFs that nothing is working on any more.
 *
 * The plug-in exports a 16-bit TIFF and hands the path to the engine as the
 * session's content. Only the plug-in's "delete after write-back" setting ever
 * removes it, and that runs on one path only: a session the user abandons before
 * writing back — closes the window, picks another photo, quits — leaves its
 * export behind for good. At 100 MB a time they pile up quietly.
 *
 * What survives:
 *   * the export of a session that is still in flight, so a retry or a resumed
 *     window keeps working;
 *   * the export of an imported session — that one is the plug-in's business,
 *     governed by its own setting, not ours to second-guess.
 *
 * What goes: exports with no session record at all, exports of cancelled
 * sessions, and — at startup, with `staleSecs` — exports of sessions abandoned
 * long enough that the plug-in has already given up waiting. Those sessions are
 * cancelled here too, otherwise the window would offer to continue a session
 * whose content file no longer exists.
 *
 * Only `<library>/lightroom/export-*` is touched, never a result.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { isVisible, nowSecs, type Session } from "./session.js";
import type { App } from "./state.js";

export interface SweepOptions {
  /**
   * Sessions in a non-final state that were *created* this long ago are treated
   * as abandoned: their export is removed and the session cancelled. Creation
   * time is the right clock — recovery rewrites `updated_at` on every start.
   * `0` disables the rule, which is what a sweep during normal operation wants —
   * a file is never pulled out from under a session somebody is using.
   */
  staleSecs?: number;
}

export interface SweepResult {
  removed: string[];
  cancelled: string[];
  kept: number;
}

/** Scans the export tree once; returns what it deleted. */
export function sweepExports(app: App, options: SweepOptions = {}): SweepResult {
  const staleSecs = options.staleSecs ?? 0;
  const now = nowSecs();
  const sessions = app.sessions.list(false);

  const keep = new Set<string>();
  const abandoned: Session[] = [];
  for (const session of sessions) {
    if (!session.content_path) continue;
    if (session.state === "imported") {
      keep.add(session.content_path);
      continue;
    }
    // `created_at`, not `updated_at`: `recover()` stamps the latter with "now"
    // for every session it loads, so a stale session looks fresh at startup.
    if (isVisible(session.state) && (staleSecs === 0 || now - session.created_at <= staleSecs)) {
      keep.add(session.content_path);
      continue;
    }
    if (isVisible(session.state)) abandoned.push(session);
  }

  const removed: string[] = [];
  const cancelled: string[] = [];
  let kept = 0;

  const root = join(app.store.root, "lightroom");
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // No export tree yet: nothing to delete. Stale sessions may still point at
    // files that are long gone, so the cancel step below must still run.
  }

  for (const name of entries) {
    if (!name.startsWith("export-")) continue;
    const dir = join(root, name);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      const path = join(dir, file);
      if (keep.has(path)) {
        kept += 1;
        continue;
      }
      try {
        // `force` covers a file that vanished between list and unlink, which is
        // the state we want anyway.
        rmSync(path, { force: true, recursive: true });
        removed.push(path);
      } catch {
        // A locked file is not worth failing the sweep over; the next run retries.
      }
    }

    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Same reasoning as above.
    }
  }

  // A cancelled session must not keep pointing at a file that is gone. Decided by
  // what is on disk now, not by what this run happened to delete: an earlier
  // sweep may already have taken the file while leaving the session behind.
  for (const session of abandoned) {
    if (session.content_path && existsSync(session.content_path)) continue;
    try {
      app.sessions.transition(session.id, "canceled", (target) => {
        target.notice = "The export was cleaned up after the session went idle.";
      });
      cancelled.push(session.id);
    } catch {
      // `error` is not allowed to become `canceled`, and with its content gone it
      // can never be retried either — a dead record the window would keep
      // offering. Drop it instead.
      app.sessions.remove(session.id);
      cancelled.push(session.id);
    }
  }

  return { removed, cancelled, kept };
}
