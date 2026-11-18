/**
 * Locating worker entry points.
 *
 * The compiled layout is `dist/*.js`; running from sources under `tsx` leaves
 * only `.ts` files next to it, so both the job worker and the band workers ask
 * here rather than duplicating the lookup.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface WorkerEntry {
  url: URL;
  /** Extra Node flags, needed when the entry is TypeScript. */
  execArgv?: string[];
}

/** Resolves `name` (without extension) next to the calling module. */
export function workerEntry(name: string): WorkerEntry {
  const compiled = new URL(`./${name}.js`, import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled };
  return {
    url: new URL(`./${name}.ts`, import.meta.url),
    execArgv: ["--import", "tsx"],
  };
}
