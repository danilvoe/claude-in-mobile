/** Domain error with a stable machine-readable code for MCP responses. */
export class FlutterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FlutterError";
  }
}

export function errorCode(error: unknown, fallback = "TOOL_ERROR"): string {
  if (error instanceof FlutterError) return error.code;
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof Reflect.get(error, "code") === "string"
  ) {
    return Reflect.get(error, "code") as string;
  }
  return fallback;
}
