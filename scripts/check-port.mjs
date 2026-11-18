/**
 * Fails early when the Vite port is taken.
 *
 * `tauri dev` starts Vite through `beforeDevCommand`, so an orphaned dev server
 * from an earlier run shows up as "Port 1420 is already in use" buried in the
 * build output, and the window never opens. This check runs first and names the
 * process holding the port, which turns a confusing failure into one command.
 *
 * Read-only: it never kills anything.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

const port = Number(process.argv[2] ?? 1420);

/** Resolves true when `port` could be bound on `host`. */
function tryBind(host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      resolve(error.code === "EADDRINUSE" ? false : true);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** The PID holding the port, when `lsof` is available (macOS, most Linux). */
function holder() {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length > 1)
      .map((columns) => `  pid ${columns[1]}  ${columns[0]}`);
  } catch {
    return [];
  }
}

// Vite listens on IPv6 by default; checking both catches every arrangement.
const free = (await tryBind("::")) && (await tryBind("0.0.0.0"));

if (!free) {
  const processes = holder();
  console.error(`\nport ${port} is already in use — the dev window cannot start.\n`);
  if (processes.length > 0) {
    console.error("holding it:");
    console.error(processes.join("\n"));
    console.error(`\nstop it with:  kill ${processes.map((p) => p.match(/pid (\d+)/)?.[1]).join(" ")}`);
  } else {
    console.error("stop whatever is serving it, then run this again.");
  }
  console.error("");
  process.exit(1);
}
