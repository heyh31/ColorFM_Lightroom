/**
 * ONNX Runtime backend.
 *
 * Builds two NCHW tensors, runs the session and concatenates the eight kernels
 * in the order {@link paramsFromSlice} expects. Everything else — tiling,
 * queueing, caching — belongs to the engine.
 *
 * The runtime is loaded on demand, so a checkout without `onnxruntime-node`
 * can still run the maths, the LUT tools and the TIFF pipeline.
 */

import { ColorfmError } from "../error.js";
import { PARAMS_VALUES, paramsFromSlice, type Params } from "../params.js";
import { INPUT_SIZE, requireModelSize, type BackendInfo, type ParamPredictor, type Thumb } from "./types.js";

/** Output names in concatenation order, with their element counts. */
const OUTPUTS: ReadonlyArray<readonly [string, number]> = [
  ["k1_c", 4 * 16],
  ["k2_c", 16 * 16],
  ["k3_c", 16 * 16],
  ["k4_c", 16 * 3],
  ["k1_s", 4 * 16],
  ["k2_s", 16 * 16],
  ["k3_s", 16 * 16],
  ["k4_s", 16 * 3],
];

/** Minimal shape of the pieces of `onnxruntime-node` this module uses. */
interface OrtTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

interface OrtModule {
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
}

let runtime: Promise<OrtModule> | undefined;

/** Loads the runtime once per process. */
async function loadRuntime(): Promise<OrtModule> {
  if (!runtime) {
    runtime = (async () => {
      try {
        const module = (await import("onnxruntime-node")) as unknown as { default?: OrtModule } & OrtModule;
        return (module.default ?? module) as OrtModule;
      } catch (error) {
        throw ColorfmError.onnx(
          `onnxruntime-node is not installed (${(error as Error).message}); install it or pass parameters instead`,
        );
      }
    })();
  }
  return runtime;
}

/** A session pinned to the CPU provider. */
export class OnnxPredictor implements ParamPredictor {
  private readonly session: OrtSession;
  private readonly runtime: OrtModule;
  private readonly name: string;

  private constructor(session: OrtSession, runtimeModule: OrtModule, name: string) {
    this.session = session;
    this.runtime = runtimeModule;
    this.name = name;
  }

  /** Loads a `.onnx` graph. `threads = 0` leaves the runtime default. */
  static async load(path: string, threads: number): Promise<OnnxPredictor> {
    const ort = await loadRuntime();
    const options: Record<string, unknown> = {
      graphOptimizationLevel: "all",
      // A model this small is faster on the plain CPU provider than behind a
      // device-partitioning layer, which costs more than it saves.
      executionProviders: ["cpu"],
    };
    if (threads > 0) {
      options.intraOpNumThreads = threads;
      options.interOpNumThreads = 1;
    }
    try {
      const session = await ort.InferenceSession.create(path, options);
      return new OnnxPredictor(session, ort, `colorfm_l/${path}`);
    } catch (error) {
      throw ColorfmError.onnx((error as Error).message);
    }
  }

  private tensor(thumb: Thumb): unknown {
    requireModelSize(thumb);
    const plane = INPUT_SIZE * INPUT_SIZE;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i += 1) {
      data[i] = thumb.pixels[i * 3];
      data[plane + i] = thumb.pixels[i * 3 + 1];
      data[2 * plane + i] = thumb.pixels[i * 3 + 2];
    }
    return new this.runtime.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  }

  async predict(content: Thumb, reference: Thumb): Promise<Params> {
    const feeds = { content: this.tensor(content), style: this.tensor(reference) };
    let outputs: Record<string, OrtTensor>;
    try {
      outputs = await this.session.run(feeds);
    } catch (error) {
      throw ColorfmError.onnx((error as Error).message);
    }

    const values = new Float32Array(PARAMS_VALUES);
    let at = 0;
    for (const [name, expected] of OUTPUTS) {
      const tensor = outputs[name];
      if (!tensor) throw ColorfmError.onnx(`missing output ${name}`);
      if (tensor.data.length !== expected) {
        throw ColorfmError.onnx(`output ${name} has ${tensor.data.length} values, expected ${expected}`);
      }
      values.set(tensor.data, at);
      at += expected;
    }
    return paramsFromSlice(values);
  }

  backendInfo(): BackendInfo {
    return { name: this.name, inputSize: INPUT_SIZE };
  }

  /** Releases the native session. */
  async close(): Promise<void> {
    await this.session.release?.();
  }
}
