# @colorfm/engine

[简体中文](README-zh.md) | English

Local HTTP service for the whole system: it owns the ONNX session, the job queue,
the parameter cache, the Lightroom sessions and the history. The desktop window
and the Lightroom plug-in only ever talk to this process; they never talk to each
other.

## Start

```bash
node packages/engine/dist/main.js serve \
    [--port N] [--model PATH] [--home DIR] [--idle-exit SECS]
```

| Flag | Meaning |
|---|---|
| `--port 0` | Default; the system assigns a port and the real one goes into `engine.json` |
| `--model` | `.onnx` path. Defaults to `COLORFM_MODEL`, then `../Resources/models`, then `models/` |
| `--home` | Discovery file and settings directory, default `~/Library/Application Support/ColorFM-LR` (`COLORFM_HOME` overrides) |
| `--idle-exit SECS` | Exit after that many idle seconds; `0` disables it. Default 300 |

The library path comes from `COLORFM_LIBRARY`, default `~/Documents/ColorFM-LR`.

On startup it writes `engine.json`: `{"schema_version":1,"pid":…,"http_port":…,"token":…}`.
**Every** request (including `/v1/health`) needs `Authorization: Bearer <token>`;
endpoints loaded by an `<img>` tag also accept `?token=`, since that element
cannot set headers.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Liveness, token check, capability list |
| GET | `/v1/diagnostics` | Version, model state, job counts, active sessions, idle seconds |
| POST | `/v1/jobs` | Create a job (`kind: preview \| render \| bake-lut`) |
| GET | `/v1/jobs/{id}` | State, progress, result, error |
| POST | `/v1/jobs/{id}/cancel` | Set the cancel flag, polled per strip |
| GET | `/v1/lightroom/history` | Filmstrip entries, pointing at persisted 1280 px previews |
| GET/POST | `/v1/lightroom/sessions` | List (`?active=1`) / create |
| GET | `/v1/lightroom/sessions/{id}` | One session |
| POST | `…/claim` | A window takes ownership |
| POST | `…/preview` | New reference or strength, re-preview |
| POST | `…/confirm` | Write back: render 16-bit output to the target path |
| POST | `…/ready-to-import` | The plug-in may touch the catalog |
| POST | `…/imported` | Import finished; snapshot the history entry |
| POST | `…/cancel` | Cancel and stop the job |

Every response is the same envelope:

```json
{ "ok": true, "schema_version": 1, "data": { }, "warnings": [], "error": { "code": "E_IO", "message": "" } }
```

`data`, `warnings` and `error` are omitted when empty. Clients branch on
`error.code`, never on the message.

## Storage layout

```
~/Library/Application Support/ColorFM-LR/     # --home
  engine.json          # port + token, so tools can find the engine
  engine.lock          # single-instance guard
  tasks.json           # parameter cache index
  lightroom/sessions/  # one JSON file per session, restored on restart

~/Documents/ColorFM-LR/                       # COLORFM_LIBRARY
  tasks/<id>/          # params.bin (1248 f32), content-256.png, *-1280.jpg, task.json
  cache/previews/<id>/ # previews for jobs without a parameter-cache task
  history/<id>/        # thumbnail snapshot taken at import time
```

## Session state machine

```
created → waiting_for_ui → waiting_for_reference → previewing → ready
        → rendering → ready_to_import → imported
```

`canceled` is terminal, and reachable from any active state. `error` can go back
to `previewing` or `rendering` (a failed write-back can be retried in place).
An illegal move returns `E_STATE_CONFLICT` with `from → to` in the message.

Sessions that were mid-job when the process stopped are repaired on load:
`previewing` drops back to `waiting_for_reference`, `rendering` back to `ready`,
both with a notice explaining the restart.

## Error codes

`E_BAD_REQUEST` `E_UNAUTHORIZED` `E_NOT_FOUND` `E_STATE_CONFLICT` `E_FILE_MOVED`
`E_IO` `E_UNSUPPORTED` `E_CANCELED` `E_JOB_FAILED` `E_MODEL_MISSING` `E_ONNX`
`E_INTERNAL` `E_UNAVAILABLE` `E_BACKEND_UNAVAILABLE`

## What belongs here rather than in the library

Core hands out batches; the engine decides how many run at once. Concretely:

| Decision | Where | Why |
|---|---|---|
| How many workers a render may use | `bands.ts: renderWorkerCount()` | reads the environment and the core count |
| Where the cuts go | `bands.ts: planBands()` | scheduling; core only reports the row count |
| Whether a file can be split at all | `bands.ts: planRenderBands()` | asks core's `editableLayout`, falls back to one thread |
| Which table to reuse | `jobs.ts: tableCache` | a cache keyed by task, grid and strength |
| How a failed band stops its siblings | `worker.ts: runBands()` | lifecycle, not arithmetic |

The plan is computed on the **main thread** and passed down in the task, so a
worker only executes the rows it was given — it never looks at the file to decide
what to do.

## Concurrency

The HTTP surface is single-threaded, so anything measured in seconds has to stay
off it. Each job hands its pixel work to a worker thread, and a render fans that
further out over the strips:

```
HTTP thread                 job worker            band workers
  thumbnails, model run  →      —                     —
  parameter cache I/O    →      —                     —
                         →   bake the LUT              —
                         →   copy the source           —
                         →   one band per worker   →   interpolate their own strips
  write previews, settle ←   progress + result    ←
```

Bands are **row ranges**, not strips: Lightroom exports the whole frame as one
strip, and a strip-keyed split would leave that case single-threaded. Each band
reads only its own rows (a contiguous byte range in an uncompressed strip) and
no band reads what another writes, so the split is `floor(rows / workers)` rows
each, with the remainder on the last band. The
pixels come out identical to a single-threaded pass, which
`packages/engine/test/parallel.test.ts` checks byte for byte.

`COLORFM_WORKERS` caps the fan-out (default `cores - 1`, at most 8). A source
that needs a re-encode is streamed by a sequential writer instead, so it stays on
the job worker alone.

Cancellation is a `SharedArrayBuffer` flag the workers poll once per strip, which
also means a cancelled job leaves a partially written destination that the caller
deletes. A band that fails stops its siblings.

## Commands

```bash
npm test                              # full suite
npm run dev:serve                     # run from sources (needs a build first)
node packages/engine/dist/main.js serve --port 0 --idle-exit 0
```

## Related

- [`../core`](../core/README.md): the library that does the pixel maths.
