/**
 * Task persistence: the parameter cache that keeps a repeated content+reference
 * pair from running the model twice.
 *
 * ```text
 * <home>/tasks.json                     index only
 * <library>/tasks/<id>/
 *     task.json
 *     params.bin        1248 f32, little-endian
 *     content-256.png   16-bit, the exact model input
 *     style-256.png
 *     content-<edge>.jpg  aspect-preserving UI preview
 *     style-<edge>.jpg
 *     result-<edge>.jpg
 * ```
 *
 * The index is a small JSON file rather than a database: at a few thousand
 * tasks it stays well under a megabyte. The public surface is
 * storage-agnostic, so swapping the index for something else only touches this
 * file. TIFFs are deliberately not persisted — a 24 MP working file is 142 MB.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { savePng16 } from "@colorfm/core";
import { PARAMS_VALUES, paramsFromSlice, paramsToVec, type Params, type Thumb } from "@colorfm/core";

import { EngineError } from "./errors.js";
import { civilFromDays, nowSecs } from "./session.js";

const INDEX_SCHEMA = 1;

/** One cached parameter set, keyed by the thumbnails that produced it. */
export interface Entry {
  id: string;
  content: string;
  style: string;
  model: string;
  created: number;
  state: string;
}

interface Index {
  schema_version: number;
  tasks: Entry[];
}

export class Store {
  readonly root: string;
  private readonly indexPath: string;
  private index: Index;

  private constructor(root: string, indexPath: string, index: Index) {
    this.root = root;
    this.indexPath = indexPath;
    this.index = index;
  }

  static open(root: string, indexPath: string): Store {
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(join(indexPath, ".."), { recursive: true });
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }

    let index: Index = { schema_version: INDEX_SCHEMA, tasks: [] };
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as Index;
      if (parsed.schema_version === INDEX_SCHEMA) index = parsed;
    } catch {
      // A missing or stale index simply starts empty; the parameter files it
      // referenced are regenerated on demand.
    }
    return new Store(root, indexPath, index);
  }

  find(content: string, style: string, model: string): Entry | undefined {
    const found = this.index.tasks.find(
      (entry) => entry.content === content && entry.style === style && entry.model === model,
    );
    return found ? { ...found } : undefined;
  }

  findById(id: string): Entry | undefined {
    const found = this.index.tasks.find((entry) => entry.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Creates the task directory and records it. The caller then writes
   * `params.bin` and the thumbnails into {@link dirOf}.
   */
  create(content: string, style: string, model: string): Entry {
    const created = nowSecs();
    const id = timestampId(created, shortHash(`${content}${style}${model}${created}`));

    try {
      mkdirSync(join(this.root, "tasks", id), { recursive: true });
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }

    const entry: Entry = { id, content, style, model, created, state: "previewed" };
    this.index.tasks.push(entry);
    this.persist();
    return { ...entry };
  }

  dirOf(entry: Entry): string {
    return join(this.root, "tasks", entry.id);
  }

  saveParams(entry: Entry, params: Params): void {
    const values = paramsToVec(params);
    const bytes = Buffer.allocUnsafe(PARAMS_VALUES * 4);
    for (let i = 0; i < values.length; i += 1) bytes.writeFloatLE(values[i], i * 4);
    try {
      writeFileSync(join(this.dirOf(entry), "params.bin"), bytes);
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }

  loadParams(entry: Entry): Params | undefined {
    const path = join(this.dirOf(entry), "params.bin");
    if (!existsSync(path)) return undefined;
    try {
      const bytes = readFileSync(path);
      if (bytes.length !== PARAMS_VALUES * 4) return undefined;
      const values = new Float32Array(PARAMS_VALUES);
      for (let i = 0; i < PARAMS_VALUES; i += 1) values[i] = bytes.readFloatLE(i * 4);
      return paramsFromSlice(values);
    } catch {
      return undefined;
    }
  }

  /**
   * Writes a preview JPEG and returns its absolute path.
   *
   * Previews normally live beside the task that produced them. A request that
   * supplies parameters directly has no task entry, so it falls back to the
   * job-scoped preview cache instead of losing its images.
   */
  savePreview(entry: Entry | undefined, jobId: string, name: string, bytes: Uint8Array): string {
    const dir = entry ? this.dirOf(entry) : join(this.root, "cache", "previews", jobId);
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }

  /** Saves a 16-bit PNG so the model input can be reproduced exactly. */
  async saveThumb(entry: Entry, name: string, thumb: Thumb): Promise<void> {
    try {
      await savePng16(thumb, join(this.dirOf(entry), `${name}-256.png`));
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }

  writeTaskJson(entry: Entry, extra: Record<string, unknown>): void {
    const value: Record<string, unknown> = { ...entry, ...extra };
    try {
      writeFileSync(join(this.dirOf(entry), "task.json"), JSON.stringify(value, null, 2));
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }

  /** Records a new lifecycle state for an entry. */
  mark(entry: Entry, state: string): void {
    const slot = this.index.tasks.find((task) => task.id === entry.id);
    if (slot) slot.state = state;
    this.persist();
  }

  private persist(): void {
    const tmp = this.indexPath.replace(/\.json$/, ".json.tmp");
    try {
      writeFileSync(tmp, JSON.stringify(this.index, null, 2));
      renameSync(tmp, this.indexPath);
    } catch (error) {
      throw EngineError.io((error as Error).message, error);
    }
  }
}

/**
 * Stable key for a thumbnail: the model only ever sees these pixels, so hashing
 * them captures every edit without watching develop settings.
 */
export function thumbKey(thumb: Thumb): string {
  const hash = createHash("sha256");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(thumb.width, 0);
  header.writeUInt32LE(thumb.height, 4);
  hash.update(header);
  const sample = Buffer.allocUnsafe(4);
  for (let i = 0; i < thumb.pixels.length; i += 1) {
    sample.writeFloatLE(thumb.pixels[i], 0);
    hash.update(sample);
  }
  return hash.digest("hex").slice(0, 16);
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 6);
}

/** `YYYYMMDD-HHMMSS_xxxxxx` in UTC: sorts chronologically in Finder. */
export function timestampId(epoch: number, short: string): string {
  const days = Math.floor(epoch / 86_400);
  const secs = epoch % 86_400;
  const [year, month, day] = civilFromDays(days);
  const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}-${hh}${mm}${ss}_${short}`;
}
