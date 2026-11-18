# Performance

Measured on the development machine (Apple Silicon, Node 22) with a 32.3 MP
frame: `6960 x 4640`, 194 MB as uncompressed RGB16 TIFF. Numbers are wall clock,
median of three runs, with the OS cache warm. Comparisons are against the native
implementation on the same machine and the same frame.

## Where the time goes

| Stage | Time | Throughput |
|---|---|---|
| bake a 33³ LUT | 140 ms | 36 k grid points |
| trilinear lookup over 32.3 MP | 1.05 s | 31 Mpx/s |
| read + decode + quantise + write the TIFF | 0.65 s | 194 MB in, 194 MB out |
| **`colorfm --params` end to end** | **1.88 s** | **18 Mpx/s** |
| model thumbnail to 256×256 | 63 ms | |
| preview fit to 1280 + resample | 66 ms | |
| JPEG encode 1280×853 at q95 | 84 ms | |

The interactive path is the bottom three rows: a preview change costs about
215 ms of pixel work, which is why the UI stays responsive even though a full
render takes seconds.

## Through the service

Both engines driven over HTTP, exactly as the window and the plug-in drive them,
each with a fresh home and library: median of three runs, spread about ±10 %.

| Request | TypeScript (all cores) | TypeScript (1 worker) | native |
|---|---|---|---|
| cold start → healthy | 321 ms | 326 ms | 218 ms |
| create a session from the 32 MP export | 192 ms | 188 ms | 43 ms |
| preview job, parameters not cached | 869 ms | 852 ms | 234 ms |
| preview job, parameters cached | 696 ms | 692 ms | 117 ms |
| render job → 16-bit TIFF | 1.03 s | 2.55 s | 0.58 s |
| **whole session** | **3.13 s** | 4.63 s | **1.19 s** |

Both sides write byte-identical files (`sha256 2fa0ced8…` for this 194-strip
fixture, `9cf670a1…` for the single-strip export below), so this compares the
same work rather than two approximations of it.

## Raster codecs behind sharp

PNG, JPEG, WebP, AVIF and HEIF now go through sharp (libvips); TIFF keeps its own
reader. On the same 32 MP session:

| Step | jpeg-js / hand-written | sharp |
|---|---|---|
| create a session (1280 preview JPEG) | 177 ms | 160 ms |
| preview job, encode stage | 146 ms | 44 ms |
| preview job, cold | 880 ms | 770 ms |
| preview job, cached parameters | 701 ms | 585 ms |
| whole session | 3.17 s | 2.88 s |

Encoding 1280×853 at quality 95 takes **11 ms** instead of 145 ms, which is most
of the preview job's remaining fixed cost. Decoding is also closer to the native
build: the JPEG thumbnail is now at most **0.52/255** away from the reference
(it was 1.8/255 with the pure-JavaScript decoder), so the differential bound
tightened from two steps to one.

Two things made this a subtraction rather than an addition:

- **The library is imported lazily.** Loading libvips eagerly in every module
  that touches `io/` delayed each band worker by enough to push a 32 MP render
  from 1.08 s to 1.34 s. The band workers only walk TIFF strips, so they should
  never load a codec at all.
- **The decoders are more than a swap.** WebP, AVIF and HEIF now work as
  reference images for free, and both the 16→8 narrowing and the sRGB conversion
  are pinned by tests (`io.test.ts` checks a lossless WebP against the same PNG).

Two sharp limitations are worth knowing, because both were found the hard way:

- **Naming the colourspace matters.** `toColourspace("srgb")` means the 8-bit
  interpretation to libvips, so a 16-bit source is rounded down and back up
  before it is read. The decoder asks for `rgb16` when the metadata says the
  source is 16-bit; with that, a 16-bit PNG decodes bit-identically to the
  native build (0/1248 parameters differ on the CLI's reference image).
- **It cannot take 16-bit raw samples.** `raw: { depth }` exists only on output,
  and the prebuilt libvips has no PNM loader, so there is no way to hand sharp a
  ushort buffer. PNG *output* is 16-bit when the pipeline is, but the pipeline
  can never become 16-bit from our data. The 256×256 model input therefore keeps
  a 40-line PNG writer of its own (`io/codec/png16.ts`).

## The Lightroom export: one strip

Lightroom writes the whole frame as a **single** uncompressed strip, so a band
scheme keyed on strips hands the entire image to one thread. Bands are row
ranges now — a strip is one contiguous byte range per band, so a single-strip
file splits exactly like a tiled one.

32.3 MP frame, render job, same table and strength:

| Workers | Render with row bands | Render when bands were strips |
|---|---|---|
| 1 | 2.44 s | 2.44 s (only one band existed) |
| 2 | 1.57 s | 2.44 s |
| 4 | 1.15 s | 2.44 s |
| 6 | 1.06 s | 2.44 s |
| 8 | 1.15 s | 2.44 s |

Two other changes landed with it:

- **Baked tables are cached** between jobs, keyed by parameters, grid and
  strength. A 33³ table is 431 KB and a session reuses a handful of strengths,
  so the render that follows a preview no longer rebakes: the `bake` stage
  disappears from the render job and the whole render drops by ~150 ms.
- **The block buffer is reused per band.** Allocating it per block zeroed about
  390 MB over a frame; reuse is worth 1–2 % and keeps the allocation out of the
  hot loop.

Both leave the pixels untouched: the engine writes byte-identical files to the
native build (`sha256 9cf670a1…`).

### What did not work: fusing the u16 path

Reading 16-bit samples, looking them up and writing 16-bit samples in one pass
sounds like it should remove two of three traversals. Measured on 8 MP:

| Path | Time | Throughput |
|---|---|---|
| convert → lookup → quantise (three loops) | 431 ms | 18.6 Mpx/s |
| one fused loop | 636 ms | 12.6 Mpx/s |
| lookup alone, buffer already float | 242 ms | 33.0 Mpx/s |

The fused loop is 1.5× **slower**: it adds a table load and a quantisation to
every iteration, and V8 no longer keeps the loop as tight. Three simple passes
over a buffer stay memory-bound and compile well; one heavy pass does not. The
attempt was reverted rather than shipped behind a flag.

## Where the difference comes from

Stage timings from the same runs. A stage ends when the next one begins, and the
jobs report them at 10 ms polling resolution — anything faster than that (the
native bake, at 3.5 ms) shows up as "—".

| Stage | TypeScript | native | Ratio |
|---|---|---|---|
| thumbnail 32 MP → 256 (preview job) | 281 ms | 25 ms | 11× |
| ONNX predict (cold) | 52 ms | 125 ms | 0.4× |
| bake 33³ | 152 ms | < 10 ms | > 15× |
| preview resample 32 MP → 1280 | 253 ms | 63 ms | 4× |
| JPEG encode 1280×853 q95 | 145 ms | 38 ms | 3.8× |
| LUT apply + TIFF I/O (render) | 871 ms | 559 ms | 1.6× |

Three things follow from that table:

- **The colour maths is no longer the bottleneck.** With the lookup banded over
  seven cores it takes about 370 ms of the 871 ms render stage; the rest is
  decoding and quantising 194 MB in and out. Single-threaded it is 2.1 s, which
  is the 4.2× per-core gap below.
- **The interactive path is dominated by portable image code.** Thumbnailing,
  resampling and JPEG encoding are 679 ms of the 880 ms preview, and all three
  are pure JavaScript against the native build's vectorised C. A preview refresh
  is still under a second, but that is where any future optimisation would pay.
- **ONNX is not slower here.** Both sides call the same runtime; the native
  number is larger because it loads the session lazily inside the first
  prediction, while this service loads it at startup and reports `model_loaded`
  only once it is ready.

## Core kernels in isolation

Same process, 8 MP of RGB triples, best of five, one core each:

| Operation | TypeScript | native | Ratio |
|---|---|---|---|
| bake a 33³ table | 140 ms | 14 ms | 9.9× |
| LUT apply, 8 MP | 258 ms (31 Mpx/s) | 62 ms (129 Mpx/s) | 4.2× |

The native build compiles the same arithmetic to vectorised machine code over
stack arrays. JavaScript has no portable SIMD, every intermediate result goes
through `Math.fround` to stay in single precision, and each lookup indexes a
typed array with bounds checks. The bake gap is larger than the lookup gap
because the native bake also spreads over all cores (3.5 ms with eight threads);
its single-core number is the 14 ms above.

Reproduce both tables with:

```bash
npx tsx tools/bench/core.mts
npx tsx tools/bench/engine.mts --reps 3
tools/reference/target/release/colorfm-reference bench request.json   # needs the f32 params
```

## Spreading the lookup over cores

A render splits the image into one contiguous run of strips per worker and they
interpolate at the same time. The lookup alone scales like this (32.3 MP, same
table):

| workers | lookup only | whole render job |
|---|---|---|
| 1 | 1038 ms (31 Mpx/s) | 2.43 s |
| 2 | 570 ms (57 Mpx/s) | 1.51 s |
| 4 | 375 ms (86 Mpx/s) | 1.14 s |
| 6 | 365 ms (88 Mpx/s) | 1.04 s |
| 8 | 370 ms (87 Mpx/s) | 1.06 s |

About 2.8× on the lookup, then flat: eight cores saturate memory bandwidth. The
render tops out at 2.3× because baking, the copy and the thumbnail stay
serialised. `COLORFM_WORKERS` overrides the count; the default is
`cores - 1` (one core left for the HTTP thread), capped at 8.

With bands the lookup is **faster than the native build** (86 vs 56 Mpx/s), and
the whole render lands within 1.7× of it. The native build streams
single-threaded, so this is a deliberate improvement rather than a match.

Banding is only used when the source can be edited in place. A compressed or
tiled source is re-encoded by a sequential writer, so it stays on one thread.

## What the port does to stay fast

Each of these was measured, not assumed:

- **One range loop, not a per-pixel helper.** Calling a `sample()` function with
  eight arguments per pixel costs about a third of the throughput: 20 vs
  30 Mpx/s. All entry points funnel into `lut/apply.ts::transformRange`.
- **No allocation in the inner loop.** The first version built a cell object, two
  arrays and a result tuple per pixel — 96 million allocations for this frame.
- **`Uint16Array` view instead of `writeUInt16LE`.** One method call per channel
  cost 1.5 s of the 4.2 s total before it was replaced by a typed-array store
  (little-endian files only; big-endian keeps the byte-by-byte path).
- **Zero-copy sample conversion.** A little-endian file on a little-endian host
  is reinterpreted as `Uint16Array` rather than rebuilt sample by sample.
- **Table for `u16 → f32`.** `TO_UNIT[sample]` replaces a division per channel;
  the table is filled once with values rounded exactly like the division.
- **`| 0` for the cell index.** Truncation equals flooring for the non-negative
  scaled values, and it is a machine instruction rather than a call.

Order of operations and every `Math.fround` are unchanged by these edits: the
differential suite compares the optimised code against the reference bit for bit,
including a 1200×800 frame compared byte for byte, so a "fast" change that moved
a single sample would fail.

## The diagnostic path

`--direct` evaluates both MLPs per pixel instead of using a LUT. It is the
accuracy baseline, not a shipping path: 0.32 Mpx/s, so about 100 s for this
frame. It allocates intermediate planes per strip, which is the first thing to
fix if it ever becomes a user-facing option.
