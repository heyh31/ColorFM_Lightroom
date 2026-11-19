/**
 * Error type for the color maths layer.
 *
 * Callers get a `kind` they can branch on and a message that is already fit to
 * show a user; nothing here knows about HTTP status codes or UI copy.
 */

export type ColorfmErrorKind =
  "paramLength" | "badCube" | "badImage" | "unsupported" | "onnx" | "canceled" | "tiff" | "io";

export class ColorfmError extends Error {
  readonly kind: ColorfmErrorKind;

  constructor(kind: ColorfmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ColorfmError";
    this.kind = kind;
  }

  static paramLength(expected: number, got: number): ColorfmError {
    return new ColorfmError("paramLength", `expected ${expected} param values, got ${got}`);
  }

  static badCube(message: string): ColorfmError {
    return new ColorfmError("badCube", `invalid cube: ${message}`);
  }

  static badImage(message: string): ColorfmError {
    return new ColorfmError("badImage", `invalid image: ${message}`);
  }

  static unsupported(message: string): ColorfmError {
    return new ColorfmError("unsupported", `unsupported input: ${message}`);
  }

  static onnx(message: string): ColorfmError {
    return new ColorfmError("onnx", `onnx error: ${message}`);
  }

  static canceled(): ColorfmError {
    return new ColorfmError("canceled", "canceled");
  }

  static tiff(message: string): ColorfmError {
    return new ColorfmError("tiff", `tiff error: ${message}`);
  }

  static io(message: string, cause?: unknown): ColorfmError {
    return new ColorfmError("io", `io error: ${message}`, { cause });
  }
}

/** Narrowing helper for `catch` clauses. */
export function isColorfmError(value: unknown): value is ColorfmError {
  return value instanceof ColorfmError;
}

/** Wraps any thrown value in a `ColorfmError`, keeping the message intact. */
export function asColorfmError(value: unknown): ColorfmError {
  if (isColorfmError(value)) return value;
  if (value instanceof Error) {
    return new ColorfmError("io", `io error: ${value.message}`, { cause: value });
  }
  return new ColorfmError("io", `io error: ${String(value)}`);
}
