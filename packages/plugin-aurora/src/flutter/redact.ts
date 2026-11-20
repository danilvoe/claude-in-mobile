/**
 * Secret redaction for Flutter/Aurora output.
 *
 * Upstream `flora_tools` may print a complete VM Service/DDS URI including its
 * authentication token. Raw streams must never reach artifacts, MCP responses
 * or logs. Redaction happens line-by-line before anything is persisted.
 */

const VM_SERVICE_URI_RE =
  /(https?|wss?):\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\/[^\s"'`<>\\]+/gi;

const AUTH_QUERY_RE =
  /([?&](?:authToken|auth_token|token|access_token|service_token)=)[^&\s"']+/gi;

const KEY_VALUE_RE =
  /\b(root_password|password|passwd|auth[-_]?token|access[-_]?token|service[-_]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi;

const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/**
 * Redact VM Service/DDS URIs, auth tokens and password-like key/value pairs.
 * Idempotent: applying it twice produces the same output.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(VM_SERVICE_URI_RE, (_match, scheme: string) =>
      `${scheme}://127.0.0.1:<port>/<redacted>`,
    )
    .replace(AUTH_QUERY_RE, "$1<redacted>")
    .replace(BEARER_RE, "$1 <redacted>")
    .replace(KEY_VALUE_RE, (_match, key: string, separator: string) =>
      `${key}${separator}<redacted>`,
    );
}

/** Redact every string in a JSON-like value (bounded traversal). */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (value === null || typeof value !== "object" || depth >= 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(item, depth + 1);
  }
  return out as T;
}
