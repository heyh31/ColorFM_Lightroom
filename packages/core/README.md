# @colorfm/core

[简体中文](README-zh.md) | English

The maths layer: turns "one content image + one reference image" into 1248
grading parameters, then applies those parameters to 16-bit TIFFs efficiently.

It makes **no I/O decisions** — no environment lookups, no logging, no opinion
about where files live. Callers pass buffers, paths and writers in and get values
back. Everything is synchronous and cancellable, so the engine can run it inside a
job worker.

## Layout

| Path | Responsibility |
|---|---|
| `src/samples.ts` | 16-bit code ↔ unit conversion, clamping, quantisation |
| `src/params.ts` | Parse/serialise `PARAMS_VALUES = 1248` (content k1..k4 + style k1..k4) |
| `src/mlp.ts` | Per-pixel MLP kernels: the model re-implemented in TypeScript |
| `src/lut/` | 3D LUT: `table.ts` (type and blending), `bake.ts`, `apply.ts`, `cube.ts` |
| `src/io/` | Streaming TIFF transform, thumbnails, previews; `codec/` holds the file formats |
| `src/infer/` | 256×256 model input (`types.ts`) and the ONNX Runtime backend (`onnx.ts`) |
| `src/color.ts` | Color management placeholder (not ICC-aware) |
| `src/pipeline.ts` | `applyLut*` / `applyDirect*` — the entry points that wire the rest together |
| `src/index.ts` | The package surface: re-exports only |
| `src/bin/colorfm.ts` | CLI: two images in, one graded TIFF out |
| `src/bin/bake-lut.ts` | Bakes a `.cube` only |

## Invariants

- Input must be a **16-bit RGB TIFF**. Compressed, tiled or planar sources cannot
  be edited in place and fall back to a re-encode, in which case
  `ImageInfo.metadataPreserved = false`.
- Memory is independent of image size: strips are streamed, so at most one strip
  plus one input chunk is resident.
- Writing prefers "byte-copy the source, then replace only the pixel ranges",
  which keeps EXIF / IPTC / XMP / ICC / thumbnails intact (Lightroom sorts on
  `DateTimeOriginal`). If the copy is refused by the OS, the render re-encodes
  instead of failing outright.
- `strength` is blended into the LUT at bake time (towards the identity matrix),
  so what the user judges on screen is the same maths that gets written back.
- Every arithmetic step on pixel data is rounded to f32. The single-precision
  contract is what makes results reproducible across runs and machines.

## Usage

```ts
import { paramsFromSlice, bake, applyLut, thumbnailAny, INPUT_SIZE } from "@colorfm/core";

const params = paramsFromSlice(values);          // 1248 floats from inference or params.bin
const table = bake(params, 33);                   // 33^3 LUT at full strength
applyLut("photo.tiff", "graded.tiff", table);     // metadata-preserving write
const thumb = await thumbnailAny("reference.jpg", INPUT_SIZE);  // decoding is async
```

## Throughput

A 32.3 MP frame (`6960 x 4640`) renders in 0.38 s with its rows banded across
cores, and in 0.92 s on a single worker. A 33³ table bakes in 67 ms and one core
looks up around 51 Mpx/s. See [`docs/performance.md`](../../docs/performance.md)
for the per-stage breakdown and how the hot loop is written.

## What this package is, and is not

`src/index.ts` is the contract. It exports color maths and **batch** primitives:

| Batch | Shape |
|---|---|
| `bake(params, grid, strength?)` | every grid node of the LUT, with the Amount folded in |
| `applyInPlace(table, pixels)` | one block of pixels |
| `runRows(src, dst, blockRows, rows, cancel, fn)` | one band of rows of a file |
| `applyLutToRows(src, dst, rows, table, cancel)` | the same, LUT already baked |
| `transform` / `transformWithCancel` | the whole file, sequentially |
| `preview` / `thumbnailAny` / `encodeJpeg` | one image, one size |

Everything returns when its own work is done. In particular there is **no
threading here**: no worker pool, no `threads` argument, no core count. Deciding
how many batches run at once, where the cuts go, which result to cache, and how
a failure cancels its siblings all live in `packages/engine`.

The rest stays internal — `samples`, `mlp`, `params` plumbing, the codecs and the
TIFF reader/writer. The tests import those by path; if a name has to travel
through `index.ts` for a test to reach it, it is not part of the contract.

## Codec support

| Format | Read | Write | Notes |
|---|---|---|---|
| TIFF | strips: none, LZW, Deflate, PackBits, horizontal predictor (16-bit); tiles rejected | uncompressed RGB16 strips | own reader: the graded output is a byte copy with only the pixel bytes replaced, so it needs strip offsets and per-block reads — neither of which a decode-to-pixels library exposes |
| PNG | 8/16-bit, greyscale/RGB/palette/alpha, interlace | 16-bit RGB (own writer) | 16→8 rounding is `(c + 128) / 257`; sharp cannot ingest 16-bit raw, so the 256×256 model input is written here |
| JPEG | baseline, progressive, CMYK | baseline, 4:4:4 | platform decoder (libjpeg-turbo) |
| WebP, AVIF, HEIF | via libvips | — | reference images only; the graded output stays TIFF |

PNG/JPEG/WebP/AVIF/HEIF go through [sharp](https://sharp.pixelplumbing.com)
(libvips); TIFF does not. Nothing declares a format: the decoder sniffs the
bytes, so an extension is never consulted and a mislabelled file still decodes. The library is imported lazily, so the band workers —
which only walk TIFF strips — never load libvips.

## Commands

```bash
npm test                                     # full suite

# predict parameters, then render
npm run colorfm -- --content photo.tiff --style reference.tiff --out graded.tiff

# reuse parameters: LUT path by default, --direct evaluates the MLP per pixel
npm run colorfm -- --content photo.tiff --params params.txt --out graded.tiff [--direct]

npm run bake-lut -- params.txt out.cube 33 [--report 200]
```
