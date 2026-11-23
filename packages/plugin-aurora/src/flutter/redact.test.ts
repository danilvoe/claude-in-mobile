import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts VM Service / DDS URIs including tokens", () => {
    const input =
      "Check vm service connection at http://127.0.0.1:37887/XwGA4GlJ1kM=/. Attempt 1\n" +
      "A Dart VM Service is available at: http://127.0.0.1:1234/TOKEN/";
    const output = redactSecrets(input);
    expect(output).not.toContain("XwGA4GlJ1kM");
    expect(output).not.toContain("TOKEN");
    expect(output).toContain("http://127.0.0.1:<port>/<redacted>");
  });

  it("redacts root_password and auth tokens", () => {
    const input = "root_password = \"hunter2\"\nauth_token: abc123\npassword=secret";
    const output = redactSecrets(input);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("secret");
  });

  it("is idempotent", () => {
    const input = "ws://127.0.0.1:9000/abcDEF==/ and token=zzz";
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });

  it("redacts nested JSON values", () => {
    const value = { nested: { uri: "http://localhost:8080/secret-token/" } };
    expect(JSON.stringify(redactDeep(value))).not.toContain("secret-token");
  });
});
