# Differential testing

Every file in this repository that touches numbers was checked against the
implementation that already ships, and the check is in the test suite rather than
in a one-off script.

## How it works

`tools/reference` is a small command-line harness over the existing native
library. It takes a JSON request on stdin, runs the original code, and prints the
answer as **raw f32 bit patterns** (`"3f800000"` instead of `1.0`). Comparing
integers removes any question of tolerance, rounding of decimal output, or
`-0` versus `0`.

`packages/core/test/differential/helpers.ts` wraps it:

```ts
const expected = reference("bake", { params, size: 33, threads: 3 });
expect(bitsOfAll(bakeParallel(paramsFromSlice(params), 33, 3).data)).toEqual(expected.parallel_bits);
```

The second half of the engine suite is black box: it starts the reference service
and this service side by side against the same model, drives both through the
same HTTP sequence, and compares status codes, error codes, session states, JSON
field sets and the pixels of the written TIFF.

```bash
npm run reference:build      # cargo build --release for the harness
npm test                     # unit + differential
npm run test:differential     # only the comparisons
```

The suite skips itself, with a message, when the reference binaries or the model
file are absent — so a fresh clone can still run `npm test` without them.

## What is compared

| Port | Comparison | Result |
|---|---|---|
| `float32.ts` | `expf` and `swishf` over 8k inputs spanning -24..24 | bit-identical |
| `params.ts` | 1248-float round trip, kernel ordering, length rejection | bit-identical |
| `mlp/index.ts` | single-point and batched transfer on a 7³ colour grid | bit-identical |
| `lut/bake.ts` | grids 2, 5, 17, 33; scalar and chunked paths | bit-identical |
| `lut/apply.ts` | trilinear lookup in range and out, strength blending, chunked path | bit-identical |
| `lut/cube.ts` | written `.cube` text, parsing a written file back | bit-identical |
| `io/thumb.ts` | 256-square thumbnails, aspect-preserving previews, `align_corners=False` sampling | bit-identical |
| `io/tiff.ts` | copy path, re-encode path, direct MLP path, 1200×800 frame compared byte for byte | bit-identical |
| `io/codec/tiff.ts` | strips: none, LZW, Deflate; 8- and 16-bit; both byte orders | bit-identical |
| `io/codec/png.ts` | 16-bit PNG read (16→8 rounding) and write (read back by the reference) | bit-identical |
| `io/codec/jpeg.ts` | 8-bit JPEG write, decode of the same file by both sides | up to 1/255 (measured 0.52) |
| `infer/onnx.ts` | 1248 predicted kernels from the same thumbnails | bit-identical |
| `pipeline.ts` | LUT path and direct path on a real TIFF | bit-identical |
| `engine` | full session lifecycle, error codes, status codes, rendered TIFF | bit-identical |
| banded render | 1 worker vs 4 workers, 12-strip frame, byte for byte | identical |

The engine run that matters most: create a session from a 64×48 RGB16 export,
claim it, preview against a PNG reference, confirm, then compare the two written
TIFFs sample by sample — `0 / 9216` samples differ.

Two larger checks were run by hand and are easy to repeat:

```bash
# 6 MP: 3000x2000 does the transform through 32 blocks of 64 rows
tools/reference/target/release/colorfm-reference fixture req.json   # {"path":"big.tiff","width":3000,"height":2000,"kind":"wide"}
node packages/core/dist/bin/colorfm.js --content big.tiff --params params.txt --out mine.tiff --grid 33
# then transform the same source with the harness and diff the two files

cmp mine.tiff reference.tiff   # 36 000 498 bytes, 0 differences
```

Throughput on that frame was 6.0 MP in 0.96 s (0.13 s of it baking the 33³
table), with memory staying at one strip plus one chunk.

## One deliberate difference: row order

Reading a thumbnail walks the source rows in output order. When an image with
more than one strip per 256 output rows is *upscaled*, that order can step back —
row 5 is requested after row 6 — and the reference implementation's streaming
reader assumes it never does: it panics with an index underflow
(`thumb.rs:305`, reproduced by a 64×48 eight-strip file and `side: 256`).

The reader here keeps the first row of every chunk it has read and re-reads the
chunk when a request steps back, so any order works. `io.test.ts` checks that an
eight-strip file and a one-strip file of the same pixels give bit-identical
thumbnails, and that both match a hand-written whole-image resample. Real exports
are large enough that the reference path never hits this.

## Strength is f32, not a JavaScript double

A 32 MP comparison first showed 101 of 96.8 million samples differing by one
16-bit step at `strength = 0.8`, while `strength = 1` was exact. The cause was
not the blend: the request carries `0.8`, JavaScript keeps that as a double, and
the native engine stores it in an `f32` field — `0.800000011920929`. The blend
weight therefore differed by about 1e-8, which is enough to flip a few table
entries by one ULP.

`clampStrength` now rounds to `f32` before the value is stored or used, on the
create, preview and render paths, so the wire form matches the native engine and
the outputs are identical again (`sha256 2fa0ced8…`, 0 differing samples).
`host-contract.test.ts` pins the stored value so this cannot regress silently.

## The one known difference: JPEG decoding

Two JPEG decoders disagree in the last bit of the inverse DCT. On a 40×30
gradient encoded at quality 95, 738 of 768 thumbnail samples differ, never by more
than 1.8/255.

This only affects *reference* images supplied as JPEG:

- the content image is a 16-bit TIFF and is decoded exactly;
- a PNG reference is decoded exactly;
- a JPEG reference shifts the 256×256 model input by at most two 8-bit steps,
  which shifts the predicted kernels slightly, which shifts the grade slightly.

Matching it would mean reimplementing the reference decoder's integer IDCT and
chroma upsampling rather than libjpeg-turbo. The test asserts the
two-step bound and documents the cause, so a regression that widened it would
fail.

## Why `expf` is reimplemented

Swish is `x / (1 + e^-x)`, evaluated 96 times per grid point during a bake. The
platform C library's `expf` is not correctly rounded, and a naive
`Math.fround(Math.exp(x))` disagrees with it on 0.85 % of inputs — always by one
ULP, but that ULP propagates into every LUT entry and then into the 16-bit
output.

`packages/core/src/float32.ts` instead evaluates

```
e^x = 2^(t/128) * (1 + r * (c0 + c1 * r)),  t = round(128 log2(e) x), r = 128 log2(e) x - t
```

with the `2^(k/128)` table stored as 128 exact doubles. That reproduces the
library's output bit for bit over 201 000 sampled inputs, which is what lets the
MLP comparisons above be exact instead of "within one ULP".

## Keeping the comparison honest

- The harness links the original library; it does not re-implement anything.
  If the two implementations disagree, the test fails on a bit pattern.
- Inputs are deterministic: fixed parameter vectors, fixed colour grids, fixed
  fixtures generated by the reference harness itself, and a seeded PRNG in the
  CLI report.
- Nothing is compared with a relative tolerance except the JPEG case above, where
  the bound is stated in 8-bit steps and justified by the codec difference.
