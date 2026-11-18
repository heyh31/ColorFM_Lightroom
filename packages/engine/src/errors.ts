/**
 * Engine-level errors: a stable code plus a message that is fit to show.
 *
 * Clients branch on `code` and never on `message`, and the code also decides
 * the HTTP status, so both live here instead of being sprinkled through the
 * handlers.
 */

import { ColorfmError } from "@colorfm/core";

/** The codes the wire protocol defines. */
export type ErrorCode =
  | "E_BAD_REQUEST"
  | "E_UNAUTHORIZED"
  | "E_NOT_FOUND"
  | "E_STATE_CONFLICT"
  | "E_FILE_MOVED"
  | "E_IO"
  | "E_UNSUPPORTED"
  | "E_CANCELED"
  | "E_JOB_FAILED"
  | "E_MODEL_MISSING"
  | "E_ONNX"
  | "E_INTERNAL"
  | "E_UNAVAILABLE"
  | "E_BACKEND_UNAVAILABLE";

/** What a client sees in the `error` field of an envelope. */
export interface WireError {
  code: string;
  message: string;
}

export class EngineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
    this.code = code;
  }

  static badRequest(message: string): EngineError {
    return new EngineError("E_BAD_REQUEST", message);
  }

  static io(message: string, cause?: unknown): EngineError {
    return new EngineError("E_IO", message, { cause });
  }

  static model(message: string): EngineError {
    return new EngineError("E_MODEL_MISSING", message);
  }

  static notFound(message: string): EngineError {
    return new EngineError("E_NOT_FOUND", message);
  }

  static internal(message: string): EngineError {
    return new EngineError("E_INTERNAL", message);
  }

  static stateConflict(message: string): EngineError {
    return new EngineError("E_STATE_CONFLICT", message);
  }

  static canceled(message = "canceled by request"): EngineError {
    return new EngineError("E_CANCELED", message);
  }

  /** Maps a maths-layer failure onto the wire vocabulary. */
  static fromCore(error: unknown): EngineError {
    if (!(error instanceof ColorfmError)) {
      return EngineError.internal(error instanceof Error ? error.message : String(error));
    }
    const code: ErrorCode = (() => {
      switch (error.kind) {
        case "canceled":
          return "E_CANCELED";
        case "paramLength":
        case "badCube":
        case "badImage":
          return "E_BAD_REQUEST";
        case "unsupported":
          return "E_UNSUPPORTED";
        case "onnx":
          return "E_ONNX";
        case "tiff":
        case "io":
          return "E_IO";
        default:
          return "E_INTERNAL";
      }
    })();
    return new EngineError(code, error.message, { cause: error });
  }

  toWire(): WireError {
    return { code: this.code, message: this.message };
  }

  override toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** HTTP status a client should see for a code. */
export function statusFor(error: EngineError): number {
  switch (error.code) {
    case "E_NOT_FOUND":
      return 404;
    case "E_BAD_REQUEST":
      return 400;
    case "E_STATE_CONFLICT":
    case "E_FILE_MOVED":
      return 409;
    case "E_MODEL_MISSING":
    case "E_BACKEND_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

/** Wraps anything thrown into an `EngineError`. */
export function asEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof ColorfmError) return EngineError.fromCore(error);
  return EngineError.internal(error instanceof Error ? error.message : String(error));
}
