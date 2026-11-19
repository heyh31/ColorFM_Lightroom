# Performance

Measured on the development machine (Apple Silicon, Node 22) with a 32.3 MP
frame: `6960 x 4640`, 194 MB as uncompressed RGB16 TIFF. Numbers are wall clock,
median of three runs, with the OS cache warm. The machine is not idle, so
individual readings move by about 15 % between runs; the shapes of the tables are
stable even when a cell is not.

## One frame end to end

The library alone — bake a 33³ table from 1248 parameters, transform the frame,
write it back:

| Step | Time | Throughput |
|---|---|---|
| `colorfm --params`, 32.3 MP | **1.02 s** | **32 Mpx/s** |
| of which: bake a 33³ LUT | 67 ms | 36 k grid points |
| of which: lookup + TIFF read/write | ~0.95 s | 194 MB in, 194 MB out |

The bake is a rounding error at this size. What dominates is moving 388 MB
through the lookup, which is why the rest of this document is about the lookup.

## Where a write-back spends its time

Same frame, one thread, split by what the code is doing rather than by wall
clock (`tools/bench/io.mts`):

| Step | Time |
|---|---|
| copy the source into the destination | **1 ms** |
| widen, look up, blend, quantise | 849 ms (38 Mpx/s) |
| `writeSync` the result | 64 ms |
| open, scan the directory, bookkeeping | 36 ms |

Two things follow. The copy is free because the filesystem clones the file — see
below — and the disk is only 7 % of the work, so an optimisation aimed at I/O is
aimed at the wrong 7 %. The 849 ms in the middle is the thing to attack, and that
is what the fused path and the bands do.

### The copy is already a clone

`copyFileSync` on this system returns in about 1 ms for a 194 MB file: the
filesystem clones it and the bytes are not touched. Asking for
`COPYFILE_FICLONE` explicitly is **slower**, not faster:

| Call | Median of six runs |
|---|---|
| `copyFileSync(src, dst)` | 2.4 ms |
| `copyFileSync(src, dst, COPYFILE_FICLONE)` | 178.8 ms |
| `COPYFILE_FICLONE_FORCE` | fails |

So the copy is left alone. The trade-off a clone normally brings — copy-on-write
block splitting when the copy is overwritten — is already priced in: the 849 ms
above is an encode that rewrites every pixel of a cloned file.

## Through the service

Driven over HTTP exactly as the window and the plug-in drive it, one engine per
configuration with a fresh home and library, three sessions each:

| Request | 8 workers | 1 worker |
|---|---|---|
| cold start → healthy | 295 ms | 284 ms |
| create a session from the 32 MP export | 95 ms | 91 ms |
| preview job, parameters not cached | 310 ms | 302 ms |
| preview job, parameters cached | 301 ms | 306 ms |
| render job → 16-bit TIFF | 393 ms | 921 ms |
| **whole session** | **1.42 s** | **1.90 s** |

Stage split inside a render job, 32.3 MP:

| Stage | 8 workers | 1 worker |
|---|---|---|
| thumbnail | 80 ms | 80 ms |
| parameters (cached) | 13 ms | 12 ms |
| LUT apply + TIFF I/O | 370 ms | 865 ms |

## Workers that stay alive

Every task runs on a worker thread, and a worker has to load the library and warm
its own JIT before it can do anything. Eight band workers doing **zero rows** take
250 ms, which is half of a 32 MP apply stage — so the workers are pooled and the
job worker itself is kept between tasks:

| Render | Time |
|---|---|
| first render after the engine starts | 499 ms |
| every render after that | 371–393 ms |

Two rules keep the reuse safe. A task is posted with an id and the reply must
carry it, so a late message can never be mistaken for the current job's result.
And a worker that failed or was cancelled is retired instead of reused: a
cancelled band stops mid-strip, and that state does not belong to the next job.
Idle workers are `unref`ed, so a pool nobody uses again cannot hold the process
open.

Renders are also serialised behind one gate. Each render wants every core, so
overlapping two of them would only add context switches.

## Banding across cores

A render splits the frame into one contiguous range of rows per worker and they
interpolate at the same time. 32.3 MP, same table and strength:

| Workers | Render job |
|---|---|
| 1 | 921 ms |
| 2 | 635 ms |
| 4 | 505 ms |
| 6 | 490 ms |
| 8 | 380 ms |

About 2.4×, then flat: eight cores saturate memory bandwidth, and the thumbnail
plus the parameter decode stay serialised in front of the apply.
`COLORFM_WORKERS` overrides the count; the default is `cores - 1` (one core left
for the HTTP thread), capped at 8.

Banding is only used when the source can be edited in place. A compressed or
tiled source is re-encoded by a sequential writer, so it stays on one thread.

### Small frames stay on one thread

A band costs a worker's start-up before it does any work, so bands are only
planned when there is enough work to hide it: below **250k pixels per band** the
frame gets fewer bands, down to one. A 1280×853 preview gets four; a thumbnail
gets one. Without the floor, `planBands` would hand a 400×300 render eight
workers and lose to the serial path.

## The Lightroom export: one strip

Lightroom writes the whole frame as a **single** uncompressed strip, so a band
scheme keyed on strips would hand the entire image to one thread. Bands are row
ranges: a strip is one contiguous byte range per band, so a single-strip file
splits exactly like a tiled one. That change is what makes the table above
reachable — before it, every column was the 1-worker number.

## Core kernels in isolation

Same process, 8 MP of RGB triples, best of five, one core:

| Operation | Time | Throughput |
|---|---|---|
| bake a 33³ table | 67 ms | 36 k grid points |
| LUT apply, 8 MP | 155 ms | 51.5 Mpx/s |

The kernels are nested rows (`number[][]`, 4×16 and 16×16) rather than one flat
buffer, and that costs nothing: the weight is hoisted out of the inner loop, so
the layout only decides how one number is fetched per row and column. Measured
against a flat `Float32Array` version in the same process, the nested form bakes
a 33³ table in 0.93–0.97× the time and produces a bit-identical table.

Reproduce every table here with:

```bash
npx tsx tools/bench/core.mts
npx tsx tools/bench/io.mts --reps 3
npx tsx tools/bench/engine.mts --reps 3 --workers 1,2,4,6,8
```

## What the lookup does to stay fast

Each of these was measured, not assumed:

- **One range loop, not a per-pixel helper.** Calling a `sample()` function with
  eight arguments per pixel costs about a third of the throughput. All entry
  points funnel into `lut/apply.ts::transformRange`.
- **No allocation in the inner loop.** An earlier version built a cell object,
  two arrays and a result tuple per pixel — 96 million allocations for this
  frame.
- **`Uint16Array` view instead of `writeUInt16LE`.** One method call per channel
  cost 1.5 s of the total before it was replaced by a typed-array store
  (little-endian files only; big-endian keeps the byte-by-byte path).
- **Zero-copy sample conversion.** A little-endian file on a little-endian host
  is reinterpreted as `Uint16Array` rather than rebuilt sample by sample.
- **One multiply instead of a 65536-entry table.** `code * (1 / 65535)` replaces
  `TO_UNIT[code]`: the table saved a division, and a multiply is cheaper than a
  cache-resident lookup at this size.
- **`| 0` for the cell index.** Truncation equals flooring for the non-negative
  scaled values, and it is a machine instruction rather than a call.
- **The write buffer is reused per band.** Allocating it per block zeroed about
  390 MB over a frame.

## The fused 16-bit path

The TIFF writer can hand a transform its 16-bit samples directly. When it does,
`applyInPlaceU16` widens each code with one multiply, looks it up, blends toward
the source and quantises — one traversal instead of three passes over a 5 MB
block. The float path stays for callers that already hold a float buffer (the
test I/O, the direct evaluator).

Both are exercised by the suite: a banded render through the fused path is
compared byte for byte against a sequential render through the float path, so a
"fast" change that moves a single sample fails.

## Baked tables are cached

Between jobs, keyed by parameters, grid and strength. A 33³ table is 431 KB and
a session reuses a handful of strengths, so the render that follows a preview
does not rebake: the `bake` stage disappears from the render job, which is why
the stage table above reads 13 ms for parameters and 0 ms for bake.

## Raster codecs behind sharp

PNG, JPEG, WebP, AVIF and HEIF go through sharp (libvips); TIFF keeps its own
reader. Two things made this a subtraction rather than an addition:

- **The library is imported lazily.** Loading libvips eagerly in every module
  that touches `io/` delayed each band worker enough to cost a fifth of a 32 MP
  render. The band workers only walk TIFF strips, so they never load a codec.
- **The decoders are more than a swap.** WebP, AVIF and HEIF work as reference
  images for free, and both the 16→8 narrowing and the sRGB conversion are
  pinned by tests (`io.test.ts` checks a lossless WebP against the same PNG).

Two sharp limitations shape the code around it:

- **Naming the colourspace matters.** `toColourspace("srgb")` means the 8-bit
  interpretation to libvips, so a 16-bit source is rounded down and back up
  before it is read. The decoder asks for `rgb16` when the metadata says the
  source is 16-bit.
- **It cannot take 16-bit raw samples.** `raw: { depth }` exists only on output,
  and the prebuilt libvips has no PNM loader, so there is no way to hand sharp a
  ushort buffer. PNG *output* is 16-bit when the pipeline is, but the pipeline
  can never become 16-bit from our data. The 256×256 model input therefore keeps
  a 40-line PNG writer of its own (`io/codec/png16.ts`).

## Determinism

Every stage is defined in double precision, with `Float32Array` storage only
where a table is genuinely a table (the baked LUT, the kernel buffers). The suite
pins the properties that make results reproducible: batch evaluation equals
per-pixel evaluation on the same inputs, a banded render equals a sequential one
byte for byte, the fused 16-bit path equals the float path, and a `.cube` file
round-trips through the text format within its printed precision.

## The diagnostic path

`--direct` evaluates both MLPs per pixel instead of using a LUT. It is the
accuracy baseline, not a shipping path: 0.41 Mpx/s (a 1 MP frame takes 2.4 s),
so about 80 s for the frame above. It allocates intermediate planes per strip,
which is the first thing to fix if it ever becomes a user-facing option.
