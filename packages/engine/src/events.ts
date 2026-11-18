/**
 * Event-stream boundary.
 *
 * Placeholder for the WebSocket contract: job progress, logs, completion and
 * errors. Polling `/v1/jobs/{id}` remains the current transport, which is why
 * the job record carries `stage` and `pct`.
 *
 * When the stream lands, every mutation in {@link import("./jobs.js").spawnWithId}
 * is the place to publish from: those are the only points where a job's state
 * changes.
 */

/** One message on the (future) event stream. */
export type EngineEvent =
  | { type: "job"; id: string; state: string; stage: string; pct: number }
  | { type: "session"; id: string; state: string }
  | { type: "log"; level: "info" | "warning" | "error"; message: string };

/** True while the stream is unimplemented; callers poll instead. */
export const EVENTS_AVAILABLE = false;
