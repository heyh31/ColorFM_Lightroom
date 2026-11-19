# Performance

Measured on the development machine (Apple Silicon, Node 22) with a 32.3 MP
frame: `6960 x 4640`, 194 MB as uncompressed RGB16 TIFF. Numbers are wall clock,
median of three runs, with the OS cache warm.

## One frame end to end

The library alone — bake a 33³ table from 1248 parameters, transform the frame,
write it back:

| Step | Time | Throughput |
|---|---|---|
| `colorfm --params`, 32.3 MP | **1.46 s** | **22 Mpx/s** |
| of which: bake a 33³ LUT | 76 ms | 36 k grid points |
| of which: lookup + TIFF read/write | ~1.35 s | 194 MB in, 194 MB out |

The bake is a rounding error at this size. What dominates is moving 388 MB
through the lookup, which is why the rest of this document is about the lookup.

## Through the service

Driven over HTTP exactly as the window and the plug-in drive it, each run with a
fresh home and library; median of three, spread about ±10 %.

| Request | All cores | 1 worker |
|---|---|---|
| cold start → healthy | 461 ms | 387 ms |
| create a session from the 32 MP export | 176 ms | 210 ms |
| preview job, parameters not cached | 1003 ms | 995 ms |
| preview job, parameters cached | 627 ms | 577 ms |
| render job → 16-bit TIFF | 725 ms | 1293 ms |
| **whole session** | **3.12 s** | **3.65 s** |

The preview is nearly worker-count independent because most of it is not the
lookup: thumbnail, resample and JPEG encode stay serial. The render is the part
that bands.

Stage split inside a render job, 32.3 MP:

| Stage | All cores | 1 worker |
|---|---|---|
| thumbnail | 129 ms | 157 ms |
| parameters (cached) | 63 ms | 61 ms |
| LUT apply + TIFF I/O | 540 ms | 1070 ms |

## Banding across cores

A render splits the frame into one contiguous range of rows per worker and they
interpolate at the same time. 32.3 MP, same table and strength:

| Workers | LUT apply | Render job |
|---|---|---|
| 1 | 1070 ms | 1293 ms |
| 2 | 759 ms | 1065 ms |
| 4 | 608 ms | 829 ms |
| 6 | 587 ms | 729 ms |
| 8 | 540 ms | 725 ms |

About 1.9× on the apply stage, then flat: eight cores saturate memory bandwidth,
and the thumbnail plus the parameter decode stay serialised in front of it.
`COLORFM_WORKERS` overrides the count; the default is `cores - 1` (one core left
for the HTTP thread), capped at 8.

Banding is only used when the source can be edited in place. A compressed or
tiled source is re-encoded by a sequential writer, so it stays on one thread.

## The Lightroom export: one strip

Lightroom writes the whole frame as a **single** uncompressed strip, so a band
scheme keyed on strips hands the entire image to one thread. Bands are row
ranges: a strip is one contiguous byte range per band, so a single-strip file
splits exactly like a tiled one. That change alone is what makes the table above
reachable — before it, columns 2–8 were all the 1-worker number.

## Core kernels in isolation

Same process, 8 MP of RGB triples, best of five, one core:

| Operation | Time | Throughput |
|---|---|---|
| bake a 33³ table | 76 ms | 36 k grid points |
| LUT apply, 8 MP | 168 ms | 47.6 Mpx/s |

Reproduce both tables with:

```bash
npx tsx tools/bench/core.mts
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
the stage table above reads 63 ms for parameters and 0 ms for bake.

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
