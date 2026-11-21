#!/usr/bin/env node
/**
 * `colorfm-engine serve [--port N] [--model PATH] [--home DIR] [--idle-exit SECS]`
 *
 * Holds the model session, the job table, the parameter cache and the Lightroom
 * sessions. Writes `engine.json` with the bound port and a bearer token so the
 * plug-in and the desktop UI can find it.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiServer } from "./api.js";
import { sweepExports } from "./exports.js";
import { History } from "./history.js";
import { SessionStore } from "./session.js";
import { Store } from "./store.js";
import {
  acquireLock,
  App,
  homeDir,
  libraryDir,
  randomToken,
  removeDiscovery,
  writeDiscovery,
} from "./state.js";

interface Args {
  port: number;
  model: string;
  home?: string;
  /** Seconds of inactivity before the engine retires itself; 0 disables it. */
  idleExit: number;
}

/**
 * Finds the model without relying on the current working directory, which is
 * unpredictable when the process is started from a macOS `.app`.
 */
function defaultModelPath(): string {
  if (process.env.COLORFM_MODEL) return process.env.COLORFM_MODEL;

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "../../..");
  for (const candidate of [
    // Bundled next to the executable, then the repository's own models folder.
    join(here, "../Resources/models/colorfm_l.onnx"),
    join(here, "models/colorfm_l.onnx"),
    join(repoRoot, "models/colorfm_l.onnx"),
    join(process.cwd(), "models/colorfm_l.onnx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "models/colorfm_l.onnx");
}

const USAGE = "usage: colorfm-engine serve [--port N] [--model PATH] [--home DIR] [--idle-exit SECS]";

function parseArgs(argv: string[]): Args {
  let port = 0;
  let model = defaultModelPath();
  let home: string | undefined;
  let idleExit = 300;

  const command = argv[0] ?? "serve";
  if (command !== "serve") throw new Error(`unknown command: ${command}\n${USAGE}`);

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--port": {
        const parsed = Number.parseInt(value(), 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`bad port: ${arg}`);
        }
        port = parsed;
        break;
      }
      case "--model":
        model = value();
        break;
      case "--home":
        home = value();
        break;
      case "--idle-exit": {
        const parsed = Number.parseInt(value(), 10);
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`bad idle-exit: ${arg}`);
        idleExit = parsed;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { port, model, home, idleExit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home ?? homeDir();
  const lock = acquireLock(home);

  const library = libraryDir();
  const store = Store.open(library, join(home, "tasks.json"));
  const sessions = SessionStore.open(join(home, "lightroom/sessions"));
  const history = History.open(join(library, "history"));

  const token = randomToken();
  const app = new App(token, args.model, store, sessions, history);

  // Exports left behind by sessions nobody finished. Cheap (a handful of
  // directories) and it is the only moment we know no session is mid-flight.
  // Startup is the one moment nothing can be mid-flight: anything still open
  // after half an hour was abandoned, and the plug-in has stopped waiting too.
  const swept = sweepExports(app, { staleSecs: 30 * 60 });
  if (swept.removed.length > 0) {
    console.error(
      `swept ${swept.removed.length} stray export(s), cancelled ${swept.cancelled.length}, kept ${swept.kept}`,
    );
  }

  try {
    await app.loadModel();
  } catch (error) {
    // Keep serving so `/v1/health` can report the failure instead of the
    // process dying before anyone can ask.
    console.error(`warning: ${(error as Error).message}`);
  }

  const server = createApiServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;

  writeDiscovery(home, { pid: process.pid, port, token });

  console.log(`colorfm-engine listening on 127.0.0.1:${port} (pid ${process.pid})`);
  console.log(`discovery file: ${join(home, "engine.json")}`);

  // The app may hand the engine to a Lightroom session and then be closed. If
  // nobody comes back, retire — but never while a session is unfinished or a
  // job is running.
  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`colorfm-engine ${reason}`);
    server.close(() => {
      removeDiscovery(home);
      lock.release();
      process.exit(0);
    });
    // Do not wait for idle sockets forever.
    server.closeAllConnections?.();
  };

  if (args.idleExit > 0) {
    const ticker = setInterval(() => {
      if (app.hasActiveSessions() || app.hasRunningJobs()) return;
      if (app.idleSecs() >= args.idleExit) {
        clearInterval(ticker);
        stop(`idle for ${app.idleSecs()}s, shutting down`);
      }
    }, 5000);
    ticker.unref();
  }

  process.on("SIGINT", () => stop("interrupted"));
  process.on("SIGTERM", () => stop("terminated"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
