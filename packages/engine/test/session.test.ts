/**
 * Session state machine and persistence.
 *
 * These cases mirror the reference suite one for one: the transition table is
 * the part of the engine the plug-in and the UI both depend on, so the states
 * it refuses matter as much as the ones it allows.
 */

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allowed,
  civilFromDays,
  defaultOutput,
  isActive,
  isVisible,
  newId,
  newSession,
  recover,
  SessionStore,
  type Session,
  type SessionState,
} from "../src/session.js";
import type { Job } from "../src/jobs.js";
import { tempApp } from "./helpers.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function store(name: string): SessionStore {
  const temp = tempApp(name);
  cleanups.push(temp.cleanup);
  return SessionStore.open(join(temp.home, "sessions"));
}

function baseSession(): Session {
  return newSession("s_test", "/tmp/base.tif", "base.tif", 0.8, undefined);
}

function job(id: string, state: string, result?: Record<string, unknown>): Job {
  return {
    id,
    kind: "preview",
    state: state as Job["state"],
    stage: state,
    pct: 100,
    ...(result ? { result } : {}),
    cancel: new Int32Array(1),
  };
}

describe("state predicates", () => {
  it("treats unfinished workflows as active", () => {
    for (const state of [
      "created",
      "waiting_for_ui",
      "previewing",
      "rendering",
      "ready_to_import",
    ] as SessionState[]) {
      expect(isActive(state)).toBe(true);
      expect(isVisible(state)).toBe(true);
    }
    expect(isActive("imported")).toBe(false);
    expect(isActive("canceled")).toBe(false);
    expect(isActive("error")).toBe(false);
    // A failed write-back stays on screen so it can be retried.
    expect(isVisible("error")).toBe(true);
  });

  it("cancels from anywhere the workflow is not over", () => {
    for (const state of ["created", "waiting_for_ui", "previewing", "ready", "rendering"] as SessionState[]) {
      expect(allowed(state, "canceled")).toBe(true);
    }
    expect(allowed("imported", "canceled")).toBe(false);
    expect(allowed("canceled", "canceled")).toBe(false);
  });
});

describe("session store", () => {
  it("walks the happy path", () => {
    const sessions = store("happy");
    sessions.create(baseSession());

    expect(sessions.transition("s_test", "waiting_for_reference").state).toBe("waiting_for_reference");

    const previewing = sessions.transition("s_test", "previewing", (session) => {
      session.reference_path = "/tmp/ref.jpg";
      session.preview_job_id = "j_1";
    });
    expect(previewing.state).toBe("previewing");

    expect(sessions.transition("s_test", "ready").state).toBe("ready");
    const rendering = sessions.transition("s_test", "rendering", (session) => {
      session.render_job_id = "j_2";
      session.output_path = "/tmp/base_ColorFM_80.tif";
    });
    expect(rendering.state).toBe("rendering");

    const importing = sessions.transition("s_test", "rendering", (session) => {
      session.render_done = true;
    });
    expect(importing.render_done).toBe(true);
    expect(sessions.activeCount()).toBe(1);

    expect(sessions.transition("s_test", "ready_to_import").state).toBe("ready_to_import");
    expect(sessions.transition("s_test", "imported").state).toBe("imported");
    expect(sessions.activeCount()).toBe(0);
    expect(sessions.list(true)).toHaveLength(0);
    expect(sessions.list(false)).toHaveLength(1);
  });

  it("refuses out-of-order transitions", () => {
    const sessions = store("order");
    sessions.create(baseSession());

    expect(() => sessions.transition("s_test", "rendering")).toThrow(/E_STATE_CONFLICT|is waiting_for_ui/);
    expect(sessions.get("s_test")?.state).toBe("waiting_for_ui");
  });

  it("lets a failed render be retried", () => {
    const sessions = store("retry");
    sessions.create(baseSession());
    sessions.transition("s_test", "waiting_for_reference");
    sessions.transition("s_test", "previewing", (session) => {
      session.reference_path = "/tmp/ref.jpg";
    });
    sessions.transition("s_test", "ready");
    sessions.transition("s_test", "rendering");
    sessions.transition("s_test", "error", (session) => {
      session.error = { code: "E_IO", message: "io error" };
    });

    const retried = sessions.transition("s_test", "rendering", (session) => {
      delete session.error;
      session.render_done = false;
    });
    expect(retried.state).toBe("rendering");
    expect(retried.error).toBeUndefined();
  });

  it("survives a reopen and recovers interrupted jobs", () => {
    const temp = tempApp("recover");
    cleanups.push(temp.cleanup);
    const dir = join(temp.home, "sessions");
    {
      const sessions = SessionStore.open(dir);
      sessions.create(baseSession());
      sessions.transition("s_test", "waiting_for_reference");
      sessions.transition("s_test", "previewing", (session) => {
        session.preview_job_id = "j_9";
      });
    }

    const reopened = SessionStore.open(dir);
    const recovered = reopened.get("s_test");
    expect(recovered?.state).toBe("waiting_for_reference");
    expect(recovered?.preview_job_id).toBeUndefined();
    expect(recovered?.notice).toBe("引擎重启，预览需要重做");
  });

  it("downgrades an interrupted render to ready", () => {
    const session = baseSession();
    session.state = "rendering";
    session.render_job_id = "j_9";
    recover(session);
    expect(session.state).toBe("ready");
    expect(session.render_job_id).toBeUndefined();
  });

  it("settles a finished preview job", () => {
    const sessions = store("settle");
    sessions.create(baseSession());
    sessions.transition("s_test", "waiting_for_reference");
    sessions.transition("s_test", "previewing", (session) => {
      session.preview_job_id = "j_1";
    });

    sessions.settleJob(
      job("j_1", "done", { content_path: "/tmp/before.jpg", result_path: "/tmp/after.jpg" }),
    );

    const settled = sessions.get("s_test");
    expect(settled?.state).toBe("ready");
    expect(settled?.preview_after_path).toBe("/tmp/after.jpg");
    expect(settled?.preview_before_path).toBe("/tmp/before.jpg");
  });

  it("ignores a stale job that belongs to another preview", () => {
    const sessions = store("settle-stale");
    sessions.create(baseSession());
    sessions.transition("s_test", "waiting_for_reference");
    sessions.transition("s_test", "previewing", (session) => {
      session.preview_job_id = "j_old";
    });

    sessions.settleJob(
      job("j_new", "done", { content_path: "/tmp/new-before.jpg", result_path: "/tmp/new-after.jpg" }),
    );

    const untouched = sessions.get("s_test");
    expect(untouched?.state).toBe("previewing");
    expect(untouched?.preview_after_path).toBeUndefined();
  });

  it("settles a finished render into rendering-with-render-done", () => {
    const sessions = store("settle-render");
    sessions.create(baseSession());
    sessions.transition("s_test", "waiting_for_reference");
    sessions.transition("s_test", "previewing");
    sessions.transition("s_test", "ready");
    sessions.transition("s_test", "rendering", (session) => {
      session.render_job_id = "j_2";
    });

    sessions.settleJob(job("j_2", "done", { out: "/tmp/out.tif" }));

    const settled = sessions.get("s_test");
    expect(settled?.state).toBe("rendering");
    expect(settled?.render_done).toBe(true);
    expect(settled?.result_path).toBe("/tmp/out.tif");
  });

  it("records a failure with a wire error", () => {
    const sessions = store("settle-error");
    sessions.create(baseSession());
    sessions.transition("s_test", "waiting_for_reference");
    sessions.transition("s_test", "previewing", (session) => {
      session.preview_job_id = "j_3";
    });

    const failure = job("j_3", "error");
    failure.error = { code: "E_IO", message: "disk" };
    sessions.settleJob(failure);

    const settled = sessions.get("s_test");
    expect(settled?.state).toBe("error");
    expect(settled?.error?.code).toBe("E_IO");
  });
});

describe("naming", () => {
  it("tags the default output with the strength", () => {
    expect(defaultOutput("/tmp/export/IMG_7317.tif", 0.8)).toBe("/tmp/export/IMG_7317_ColorFM_80.tif");
    expect(defaultOutput("/tmp/export/IMG_7317.tiff", 1)).toBe("/tmp/export/IMG_7317_ColorFM_100.tif");
    expect(defaultOutput("relative.tif", 0)).toBe("relative_ColorFM_00.tif");
  });

  it("produces sortable ids with a prefix", () => {
    const id = newId();
    expect(id.startsWith("s_")).toBe(true);
    expect(id).toHaveLength("s_20261114-203812_abcdef".length);
    expect(newId(1_700_000_000).slice(0, 17)).toBe("s_20231114-221320");
  });

  it("converts days to calendar dates", () => {
    expect(civilFromDays(0)).toEqual([1970, 1, 1]);
    expect(civilFromDays(19_000)).toEqual([2022, 1, 8]);
    expect(civilFromDays(-1)).toEqual([1969, 12, 31]);
  });
});
