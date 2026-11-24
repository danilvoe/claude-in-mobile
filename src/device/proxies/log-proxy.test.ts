import { describe, it, expect, vi } from "vitest";
import { LogProxy } from "./log-proxy.js";
import type { CorePlatformAdapter } from "../../adapters/platform-adapter.js";

function makeShellAdapter(overrides: Record<string, unknown> = {}) {
  return {
    platform: "aurora",
    shell: vi.fn(() => ""),
    getLogs: vi.fn(() => "journal output"),
    clearLogs: vi.fn(() => "Logs cleared."),
    ...overrides,
  } as unknown as CorePlatformAdapter;
}

describe("LogProxy.getLogs", () => {
  it("forwards Aurora since/grep/lines filters to the adapter", () => {
    const adapter = makeShellAdapter();
    const proxy = new LogProxy(() => adapter);

    const output = proxy.getLogs({
      platform: "aurora",
      deviceId: "emulator",
      lines: 250,
      level: "err",
      since: "yesterday",
      grep: "segfault",
    });

    expect(output).toBe("journal output");
    expect(adapter.getLogs).toHaveBeenCalledWith(
      {
        level: "err",
        tag: undefined,
        lines: 250,
        package: undefined,
        since: "yesterday",
        grep: "segfault",
      },
      "emulator",
    );
  });

  it("rejects platforms without the shell/logs capability", () => {
    const proxy = new LogProxy(() => ({ platform: "browser" } as unknown as CorePlatformAdapter));
    expect(() => proxy.getLogs({ platform: "browser" })).toThrow(/not supported for browser/);
  });
});
