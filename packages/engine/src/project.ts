/**
 * Durable project model boundary.
 *
 * Placeholder for the design-document Project representation: source identity,
 * reference, model version, options, outputs and actions.
 *
 * The existing {@link import("./store.js").Entry} is a parameter-cache key, not
 * a Project. In particular, whether a full-resolution working copy is persisted
 * is unresolved because of disk usage — a 24 MP TIFF is 142 MB.
 */

/** Fields a durable project would need to carry. */
export interface ProjectShape {
  id: string;
  content: { path: string; fingerprint: string };
  reference: { path: string; fingerprint: string };
  modelVersion: string;
  options: { grid: number; strength: number; direct: boolean };
  outputs: { resultPath?: string; renderedAt?: number }[];
}

/** True while projects are represented by the parameter cache instead. */
export const PROJECT_STORE_AVAILABLE = false;
