#!/usr/bin/env node
/**
 * `colorfm --content photo.tiff --out graded.tiff --style reference.tiff`
 *
 * One-command pipeline: two images in, one graded TIFF out.
 *
 * ```text
 * # predict the parameters from a reference image
 * colorfm --content photo.tiff --style reference.tiff --out graded.tiff
 *
 * # reuse parameters produced earlier
 * colorfm --content photo.tiff --params params.txt --out graded.tiff
 *
 * # accuracy baseline: skip the LUT and evaluate the MLPs per pixel
 * colorfm --content photo.tiff --params params.txt --out exact.tiff --direct
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ColorfmError } from "../error.js";
import { OnnxPredictor } from "../infer/onnx.js";
import { INPUT_SIZE, type Thumb } from "../infer/index.js";
import { thumbnailAny } from "../io/thumb.js";
import { bake, type Lut3D } from "../lut/index.js";
import { paramsFromSlice, paramsToVec, type Params } from "../params.js";
import { applyDirect, applyLut } from "../pipeline.js";

interface Args {
  content: string;
  style?: string;
  out: string;
  model: string;
  params?: string;
  dumpParams?: string;
  grid: number;
  direct: boolean;
}

const USAGE =
  "usage: colorfm --content <photo.tiff> --out <graded.tiff> " +
  "[--style <reference.tiff>] [--params <params.txt>] [--model <model.onnx>] " +
  "[--grid 33] [--direct] [--dump-params <out.txt>]";

/**
 * Finds the model without relying on the current working directory, which is
 * unpredictable when the tool is launched from a macOS `.app`. Order:
 *
 * 1. `$COLORFM_MODEL`
 * 2. `../Resources/models/colorfm_l.onnx` next to the script (bundle)
 * 3. `models/colorfm_l.onnx` next to the script
 * 4. `models/colorfm_l.onnx` at the repository root
 * 5. `models/colorfm_l.onnx` relative to the current directory
 */
function defaultModelPath(): string {
  if (process.env.COLORFM_MODEL) return process.env.COLORFM_MODEL;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "../../../..");
  for (const candidate of [
    join(here, "../../../../Resources/models/colorfm_l.onnx"),
    join(here, "../../../models/colorfm_l.onnx"),
    join(repoRoot, "models/colorfm_l.onnx"),
    join(process.cwd(), "models/colorfm_l.onnx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "models/colorfm_l.onnx");
}

function parseArgs(argv: string[]): Args {
  let content: string | undefined;
  let style: string | undefined;
  let out: string | undefined;
  let model = defaultModelPath();
  let params: string | undefined;
  let dumpParams: string | undefined;
  let grid = 33;
  let direct = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--content":
        content = value();
        break;
      case "--style":
        style = value();
        break;
      case "--out":
        out = value();
        break;
      case "--model":
        model = value();
        break;
      case "--params":
        params = value();
        break;
      case "--dump-params":
        dumpParams = value();
        break;
      case "--grid":
        grid = Number.parseInt(value(), 10);
        break;
      case "--direct":
        direct = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (!content) throw new Error(`--content is required\n${USAGE}`);
  if (!out) throw new Error(`--out is required\n${USAGE}`);
  if (!params && !style) throw new Error(`--style (to predict) or --params (to reuse) is required\n${USAGE}`);
  return { content, style, out, model, params, dumpParams, grid, direct };
}

function readParams(path: string): Params {
  const text = readFileSync(path, "utf8");
  const values = text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const value = Number(token);
      if (!Number.isFinite(value)) throw ColorfmError.paramLength(0, Number.NaN);
      return value;
    });
  return paramsFromSlice(values);
}

function writeParams(path: string, params: Params): void {
  // One value per line, shortest round-tripping representation: a fixed number
  // of decimals would lose precision on the small kernels.
  writeFileSync(
    path,
    `${paramsToVec(params)
      .map((value) => String(value))
      .join("\n")}\n`,
  );
}

async function predict(
  model: string,
  content: Thumb,
  style: Thumb,
): Promise<{ params: Params; loadMs: number; inferMs: number }> {
  const started = performance.now();
  const predictor = await OnnxPredictor.load(model, 4);
  const loadMs = performance.now() - started;

  await predictor.predict(content, style); // warm up

  const inferStart = performance.now();
  const params = await predictor.predict(content, style);
  const inferMs = performance.now() - inferStart;
  await predictor.close();
  return { params, loadMs, inferMs };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const started = performance.now();
  let stage = performance.now();
  // Only touch the TIFF for a thumbnail when a prediction is actually needed;
  // with --params the content file is read once, by the renderer.
  const predictFromReference = args.params === undefined;
  const content = predictFromReference ? await thumbnailAny(args.content, INPUT_SIZE) : undefined;
  const style = args.style && content ? await thumbnailAny(args.style, INPUT_SIZE) : undefined;
  const thumbMs = performance.now() - stage;

  stage = performance.now();
  let loadMs = 0;
  let inferMs = 0;
  let params: Params;
  if (args.params) {
    params = readParams(args.params);
  } else if (content && style) {
    const result = await predict(args.model, content, style);
    params = result.params;
    loadMs = result.loadMs;
    inferMs = result.inferMs;
  } else {
    throw new Error("unreachable: argument parsing guarantees a reference or params");
  }
  const paramsMs = performance.now() - stage;

  if (args.dumpParams) writeParams(args.dumpParams, params);

  stage = performance.now();
  let info;
  let bakeMs = 0;
  let table: Lut3D | undefined;
  if (args.direct) {
    info = applyDirect(args.content, args.out, params);
  } else {
    const bakeStart = performance.now();
    table = bake(params, args.grid);
    bakeMs = performance.now() - bakeStart;
    info = applyLut(args.content, args.out, table);
  }
  const applyMs = Math.max(0, performance.now() - stage - bakeMs);

  const px = info.width * info.height;
  console.log(`content   ${args.content} (${info.width}x${info.height} TIFF)`);
  console.log(`thumbnail ${thumbMs.toFixed(1).padStart(8)} ms`);
  if (loadMs > 0) {
    console.log(`model     ${args.model}`);
    console.log(`model load${loadMs.toFixed(1).padStart(8)} ms   (one-shot; the engine keeps it alive)`);
    console.log(`predict   ${inferMs.toFixed(1).padStart(8)} ms`);
  } else {
    console.log(`params    ${paramsMs.toFixed(1).padStart(8)} ms   (read from file)`);
  }
  if (!args.direct) {
    console.log(`bake      ${bakeMs.toFixed(1).padStart(8)} ms   LUT ${args.grid}^3`);
  }
  const mode = args.direct ? "direct MLP" : `LUT ${args.grid}^3`;
  console.log(
    `apply     ${applyMs.toFixed(1).padStart(8)} ms   ${mode}  (${(px / 1e6).toFixed(1)} MP, ` +
      `${(px / (applyMs / 1e3) / 1e6).toFixed(0)} Mpx/s)`,
  );
  console.log(`total     ${(performance.now() - started).toFixed(1).padStart(8)} ms -> ${args.out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
