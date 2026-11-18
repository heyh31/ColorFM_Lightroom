/**
 * Result history for the window's filmstrip.
 *
 * Every session that produced a result shows up, whether or not the plug-in
 * finished importing it. For imported sessions the snapshot under
 * `<library>/history/<session-id>/` wins.
 *
 * Snapshots exist because a session's preview thumbnails live beside the
 * parameter-cache task, and that task is shared by every run of the same
 * content+reference pair — re-grading overwrites them. Copying at import time
 * gives the strip a version that never changes; the rest of the strip simply
 * reads the session's persisted previews.
 *
 * ```text
 * <library>/history/<session-id>/
 *     entry.json        snapshot the UI reads
 *     result.jpg        graded preview (copied from the session)
 *     reference.jpg     reference thumbnail (copied)
 * ```
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { EngineError } from "./errors.js";
import { nowSecs, type Session } from "./session.js";

export interface HistoryEntry {
  id: string;
  label: string;
  imported_at: number;
  created_at: number;
  strength: number;
  result_path?: string;
  raw_path?: string;
  reference_name?: string;
  content_thumb?: string;
  result_thumb?: string;
  reference_thumb?: string;
}

export class History {
  private readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static open(root: string): History {
    try {
      mkdirSync(root, { recursive: true });
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
    return new History(root);
  }

  /**
   * Snapshots a finished session. Best effort: a missing preview must not turn
   * a successful import into an error, so the entry is written regardless.
   *
   * `now` is injectable so ordering can be tested without waiting for a wall
   * clock tick.
   */
  record(session: Session, now = nowSecs()): HistoryEntry {
    const dir = join(this.root, session.id);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }

    const contentThumb = copyThumb(session.preview_before_path, join(dir, "content.jpg"));
    const resultThumb = copyThumb(session.preview_after_path, join(dir, "result.jpg"));
    const referenceThumb = copyThumb(session.preview_style_path, join(dir, "reference.jpg"));

    const entry: HistoryEntry = {
      id: session.id,
      label: session.label,
      imported_at: now,
      created_at: session.created_at,
      strength: session.strength,
      ...(session.result_path ? { result_path: session.result_path } : {}),
      ...(session.source?.raw_path ? { raw_path: session.source.raw_path } : {}),
      ...(fileName(session.reference_path) ? { reference_name: fileName(session.reference_path) } : {}),
      ...(contentThumb ? { content_thumb: contentThumb } : {}),
      ...(resultThumb ? { result_thumb: resultThumb } : {}),
      ...(referenceThumb ? { reference_thumb: referenceThumb } : {}),
    };

    const path = join(dir, "entry.json");
    const tmp = path.replace(/\.json$/, ".json.tmp");
    try {
      writeFileSync(tmp, JSON.stringify(entry, null, 2));
      renameSync(tmp, path);
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
    return entry;
  }

  /** Newest import first. Entries whose file disappeared are skipped. */
  list(): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return entries;
    }
    for (const name of names) {
      const path = join(this.root, name, "entry.json");
      if (!existsSync(path)) continue;
      try {
        entries.push(JSON.parse(readFileSync(path, "utf8")) as HistoryEntry);
      } catch {
        // Unreadable snapshots are skipped rather than reported as broken.
      }
    }
    newestFirst(entries);
    return entries;
  }

  /**
   * Everything that produced a result, newest first.
   *
   * The strip is meant to show "what I have already made", so it must not
   * depend on the plug-in finishing an import: a session that reached
   * `ready_to_import` has a rendered TIFF and previews on disk, which is a
   * finished job from the user's point of view. Imported sessions prefer their
   * snapshot, whose copies never change.
   */
  collect(sessions: readonly Session[]): HistoryEntry[] {
    const snapshots = this.list();
    const entries: HistoryEntry[] = [];

    for (const session of sessions) {
      if (!session.result_path) continue;
      const snapshot = snapshots.find((entry) => entry.id === session.id);
      if (snapshot) {
        entries.push(snapshot);
        continue;
      }
      entries.push({
        id: session.id,
        label: session.label,
        // Not an import time; the strip only needs a stable ordering.
        imported_at: Math.max(session.updated_at, session.created_at),
        created_at: session.created_at,
        strength: session.strength,
        result_path: session.result_path,
        ...(session.source?.raw_path ? { raw_path: session.source.raw_path } : {}),
        ...(fileName(session.reference_path) ? { reference_name: fileName(session.reference_path) } : {}),
        ...(session.preview_before_path ? { content_thumb: session.preview_before_path } : {}),
        ...(session.preview_after_path ? { result_thumb: session.preview_after_path } : {}),
        ...(session.preview_style_path ? { reference_thumb: session.preview_style_path } : {}),
      });
    }

    // Snapshots whose session file was pruned still belong in the strip.
    for (const snapshot of snapshots) {
      if (!entries.some((entry) => entry.id === snapshot.id)) entries.push(snapshot);
    }

    newestFirst(entries);
    return entries;
  }
}

/**
 * Most recent first; ties fall back to creation time so recovered sessions
 * (whose `updated_at` is the recovery moment) keep a stable order.
 */
function newestFirst(entries: HistoryEntry[]): void {
  entries.sort((a, b) => b.imported_at - a.imported_at || b.created_at - a.created_at);
}

function fileName(path: string | undefined): string | undefined {
  return path ? basename(path) : undefined;
}

/** Copies one preview into the history directory, returning its new path. */
function copyThumb(source: string | undefined, target: string): string | undefined {
  if (!source || !existsSync(source)) return undefined;
  try {
    copyFileSync(source, target);
    return target;
  } catch {
    return undefined;
  }
}
