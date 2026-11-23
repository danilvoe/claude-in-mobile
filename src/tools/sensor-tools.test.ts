import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sensorTools } from "./sensor-tools.js";
import { ValidationError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(name: string) {
  const def = sensorTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getAndroidClient: vi.fn(() => ({
        shell: vi.fn(() => ""),
        exec: vi.fn(() => ""),
      })),
      shell: vi.fn(() => ""),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sensor_location
// ---------------------------------------------------------------------------

describe("sensor_location", () => {
  const handler = findHandler("sensor_location");

  it("sets location on Android emulator — longitude comes FIRST in emu geo fix", async () => {
    const shell = vi.fn(() => "OK");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ latitude: 55.7558, longitude: 37.6173 }, ctx);

    expect(shell).toHaveBeenCalledWith("emu geo fix 37.6173 55.7558 0", "android", undefined);
    expect((result as { text: string }).text).toContain("Android emulator");
    expect((result as { text: string }).text).toContain("55.7558");
    expect((result as { text: string }).text).toContain("37.6173");
  });

  it("uses default altitude 0 when not specified", async () => {
    const shell = vi.fn(() => "OK");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ latitude: 40.7128, longitude: -74.006 }, ctx);

    expect(shell).toHaveBeenCalledWith("emu geo fix -74.006 40.7128 0", "android", undefined);
  });

  it("passes custom altitude to emu geo fix", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ latitude: 0, longitude: 0, altitude: 150 }, ctx);

    expect(shell).toHaveBeenCalledWith("emu geo fix 0 0 150", "android", undefined);
  });

  it("sets location on iOS simulator using xcrun simctl", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        shell,
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
      } as any,
    });

    const result = await handler({ latitude: 37.3861, longitude: -122.0839, platform: "ios" }, ctx);

    expect(shell).toHaveBeenCalledWith("xcrun simctl location booted set 37.3861,-122.0839", "ios");
    expect((result as { text: string }).text).toContain("iOS Simulator");
  });

  it("validates latitude — rejects value above 90", async () => {
    const ctx = makeMockContext();
    await expect(handler({ latitude: 91, longitude: 0 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates latitude — rejects value below -90", async () => {
    const ctx = makeMockContext();
    await expect(handler({ latitude: -91, longitude: 0 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates longitude — rejects value above 180", async () => {
    const ctx = makeMockContext();
    await expect(handler({ latitude: 0, longitude: 181 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates longitude — rejects value below -180", async () => {
    const ctx = makeMockContext();
    await expect(handler({ latitude: 0, longitude: -181 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("rejects non-numeric latitude (NaN string)", async () => {
    const ctx = makeMockContext();
    await expect(handler({ latitude: "not-a-number", longitude: 0 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("returns unsupported message for desktop platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "desktop"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell: vi.fn(() => ""),
      } as any,
    });

    const result = await handler({ latitude: 0, longitude: 0, platform: "desktop" }, ctx);
    expect((result as { text: string }).text).toContain("not supported on platform");
    expect((result as { text: string }).text).toContain("desktop");
  });

  it("falls back to physical device path when emulator shell throws", async () => {
    let callCount = 0;
    const shell = vi.fn(() => {
      callCount++;
      if (callCount === 1) throw new Error("error: unknown command");
      return "Broadcast completed";
    });

    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ latitude: 55.0, longitude: 37.0 }, ctx);

    expect(shell).toHaveBeenCalledWith("appops set com.android.shell android:mock_location allow", "android", undefined);
    expect((result as { text: string }).text).toContain("physical device");
  });

  it("falls back when emulator returns error string (does not throw)", async () => {
    const shell = vi.fn()
      .mockReturnValueOnce("error: unknown host")   // emu geo fix → error path
      .mockReturnValueOnce("")                        // appops
      .mockReturnValueOnce("Broadcast completed");   // am broadcast

    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ latitude: 10, longitude: 20 }, ctx);
    expect((result as { text: string }).text).toContain("physical device");
  });
});

// ---------------------------------------------------------------------------
// sensor_battery
// ---------------------------------------------------------------------------

describe("sensor_battery", () => {
  const handler = findHandler("sensor_battery");

  it("returns unsupported on iOS", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell: vi.fn(() => ""),
      } as any,
    });

    const result = await handler({ level: 50, platform: "ios" }, ctx);
    expect((result as { text: string }).text).toContain("only supported on Android");
  });

  it("sets battery level via dumpsys battery set level", async () => {
    const shell = vi.fn(() => "AC powered: false\nlevel: 75");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ level: 75 }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set level 75", "android", undefined);
    expect((result as { text: string }).text).toContain("75%");
  });

  it("sets battery status — charging maps to code 2", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ status: "charging" }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set status 2", "android", undefined);
  });

  it("sets battery status — discharging maps to code 3", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ status: "discharging" }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set status 3", "android", undefined);
  });

  it("sets plugged source to ac — enables ac, disables usb and wireless", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ plugged: "ac" }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set ac 1", "android", undefined);
    expect(shell).toHaveBeenCalledWith("dumpsys battery set usb 0", "android", undefined);
    expect(shell).toHaveBeenCalledWith("dumpsys battery set wireless 0", "android", undefined);
  });

  it("sets plugged source to none — disables all charger sources", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ plugged: "none" }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set ac 0", "android", undefined);
    expect(shell).toHaveBeenCalledWith("dumpsys battery set usb 0", "android", undefined);
    expect(shell).toHaveBeenCalledWith("dumpsys battery set wireless 0", "android", undefined);
  });

  it("resets battery state when reset=true", async () => {
    const shell = vi.fn(() => "AC powered: true\nlevel: 98");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ reset: true }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery reset", "android", undefined);
    expect((result as { text: string }).text).toContain("reset to real hardware values");
  });

  it("validates battery level — rejects -1", async () => {
    const ctx = makeMockContext();
    await expect(handler({ level: -1 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates battery level — rejects 101", async () => {
    const ctx = makeMockContext();
    await expect(handler({ level: 101 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("rounds non-integer level to nearest integer (50.5 becomes 51)", async () => {
    // Implementation uses Math.round(level) before validating, so 50.5 → 51 is accepted.
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ level: 50.5 }, ctx);

    expect(shell).toHaveBeenCalledWith("dumpsys battery set level 51", "android", undefined);
    expect((result as { text: string }).text).toContain("51%");
  });

  it("returns error message when no level/status/plugged and no reset", async () => {
    const ctx = makeMockContext();

    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("Nothing to set");
  });

  it("reads back current battery state after setting level", async () => {
    const shell = vi.fn(() => "Current Battery Service state:\n  level: 80");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ level: 80 }, ctx);

    // The read-back call (last shell call) is dumpsys battery with no args
    expect(shell).toHaveBeenCalledWith("dumpsys battery", "android", undefined);
    expect((result as { text: string }).text).toContain("Current state");
  });
});

// ---------------------------------------------------------------------------
// sensor_notifications
// ---------------------------------------------------------------------------

const MOCK_DUMPSYS_OUTPUT = `
Notification List:
  NotificationRecord(pkg=com.example.app userId=0 id=1)
    android.title= My Notification Title
    android.text= This is the notification body
    when=1700000000000
    priority=0
  NotificationRecord(pkg=com.other.app userId=0 id=2)
    android.title= Other App Alert
    android.text= Something happened
    when=1700000001000
    priority=-1
`;

describe("sensor_notifications", () => {
  const handler = findHandler("sensor_notifications");

  it("returns unsupported on iOS", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell: vi.fn(() => ""),
      } as any,
    });

    const result = await handler({ platform: "ios" }, ctx);
    expect((result as { text: string }).text).toContain("only supported on Android");
  });

  it("parses NotificationRecord blocks from dumpsys output", async () => {
    const shell = vi.fn(() => MOCK_DUMPSYS_OUTPUT);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;

    expect(text).toContain("com.example.app");
    expect(text).toContain("My Notification Title");
    expect(text).toContain("This is the notification body");
    expect(text).toContain("com.other.app");
  });

  it("filters notifications by package name", async () => {
    const shell = vi.fn(() => MOCK_DUMPSYS_OUTPUT);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ package: "com.example.app" }, ctx);
    const text = (result as { text: string }).text;

    expect(text).toContain("com.example.app");
    expect(text).not.toContain("com.other.app");
  });

  it("returns 'no notifications' message when dumpsys output has no records", async () => {
    const shell = vi.fn(() => "Notification List:\n  (nothing)");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("No active notifications");
  });

  it("returns 'no notifications' with filter note when package filter yields no match", async () => {
    const shell = vi.fn(() => MOCK_DUMPSYS_OUTPUT);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ package: "com.nonexistent.app" }, ctx);
    const text = (result as { text: string }).text;

    expect(text).toContain("No active notifications");
    expect(text).toContain("com.nonexistent.app");
  });

  it("rejects invalid package name with shell injection characters", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example;evil" }, ctx)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sensor_thermal
// ---------------------------------------------------------------------------

describe("sensor_thermal", () => {
  const handler = findHandler("sensor_thermal");

  it("returns unsupported on iOS", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell: vi.fn(() => ""),
      } as any,
    });

    const result = await handler({ platform: "ios" }, ctx);
    expect((result as { text: string }).text).toContain("only supported on Android");
  });

  it("sets thermal status none — sends code 0", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ status: "none" }, ctx);
    expect(shell).toHaveBeenCalledWith("cmd thermalservice override-status 0", "android", undefined);
  });

  it("sets thermal status moderate — sends code 2", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ status: "moderate" }, ctx);

    expect(shell).toHaveBeenCalledWith("cmd thermalservice override-status 2", "android", undefined);
    expect((result as { text: string }).text).toContain("moderate");
    expect((result as { text: string }).text).toContain("code 2");
  });

  it("sets thermal status critical — sends code 4", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ status: "critical" }, ctx);
    expect(shell).toHaveBeenCalledWith("cmd thermalservice override-status 4", "android", undefined);
  });

  it("sets thermal status shutdown — sends code 6", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    await handler({ status: "shutdown" }, ctx);
    expect(shell).toHaveBeenCalledWith("cmd thermalservice override-status 6", "android", undefined);
  });

  it("resets thermal state when reset=true", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ reset: true }, ctx);

    expect(shell).toHaveBeenCalledWith("cmd thermalservice reset", "android", undefined);
    expect((result as { text: string }).text).toContain("reset to real hardware state");
  });

  it("returns error when no status and reset is not set", async () => {
    const ctx = makeMockContext();

    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("Provide a 'status'");
  });

  it("detects API < 29 error from thermalservice output containing 'not found'", async () => {
    const shell = vi.fn(() => "cmd: 'thermalservice' not found");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ status: "severe" }, ctx) as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("API 29");
  });

  it("detects API < 29 error from thermalservice output containing 'error'", async () => {
    const shell = vi.fn(() => "error: unknown service thermalservice");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });

    const result = await handler({ status: "light" }, ctx) as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Thermal override failed");
  });

  it("throws ValidationError for unknown thermal status string", async () => {
    const ctx = makeMockContext();
    await expect(handler({ status: "blazing" }, ctx)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// sensor_location — Aurora
// ---------------------------------------------------------------------------

describe("sensor_location — Aurora", () => {
  const handler = findHandler("sensor_location");

  function auroraCtx(adapter: Record<string, unknown>) {
    const getAdapter = vi.fn(() => adapter);
    return {
      ctx: makeMockContext({
        deviceManager: {
          getCurrentPlatform: vi.fn(() => "aurora"),
          getAdapter,
          shell: vi.fn(() => ""),
        } as any,
      }),
      getAdapter,
    };
  }

  it("delegates to the Aurora LocationAdapter", async () => {
    const setLocation = vi.fn(async () => "GPS location set on Aurora emulator");
    const { ctx, getAdapter } = auroraCtx({
      setLocation,
      loadTrack: vi.fn(),
      controlTrack: vi.fn(),
    });

    const result = await handler(
      { latitude: 59.9311, longitude: 30.3609, altitude: 10, platform: "aurora" },
      ctx,
    );

    expect(getAdapter).toHaveBeenCalledWith("aurora", undefined);
    expect(setLocation).toHaveBeenCalledWith(59.9311, 30.3609, 10, undefined);
    expect((result as { text: string }).text).toContain("Aurora");
  });

  it("reports an outdated Aurora plugin instead of throwing", async () => {
    const { ctx } = auroraCtx({ shell: vi.fn(() => "") });

    const result = await handler(
      { latitude: 59.9311, longitude: 30.3609, platform: "aurora" },
      ctx,
    ) as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("plugin-aurora");
  });

  it("returns the adapter error message when audb rejects the command", async () => {
    const { ctx } = auroraCtx({
      setLocation: vi.fn(async () => {
        throw new Error("Location and sensor emulation is only supported on emulators");
      }),
      loadTrack: vi.fn(),
      controlTrack: vi.fn(),
    });

    const result = await handler(
      { latitude: 1, longitude: 2, platform: "aurora" },
      ctx,
    ) as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("only supported on emulators");
  });
});

// ---------------------------------------------------------------------------
// sensor_track — Aurora
// ---------------------------------------------------------------------------

describe("sensor_track — Aurora", () => {
  const handler = findHandler("sensor_track");

  function auroraCtx() {
    const adapter = {
      setLocation: vi.fn(),
      loadTrack: vi.fn(async () => "GPS track loaded on Aurora emulator"),
      controlTrack: vi.fn(async () => "GPS track started on Aurora emulator"),
    };
    const getAdapter = vi.fn(() => adapter);
    return {
      ctx: makeMockContext({
        deviceManager: {
          getCurrentPlatform: vi.fn(() => "aurora"),
          getAdapter,
          shell: vi.fn(() => ""),
        } as any,
      }),
      adapter,
      getAdapter,
    };
  }

  it("loads a track from positions without starting playback", async () => {
    const { ctx, adapter } = auroraCtx();

    const result = await handler(
      {
        operation: "load",
        platform: "aurora",
        positions: [
          { latitude: 59.93, longitude: 30.36, altitude: 5, intervalMs: 1000 },
          { latitude: 59.94, longitude: 30.37 },
        ],
        loop: true,
        speed: 2,
      },
      ctx,
    );

    expect(adapter.loadTrack).toHaveBeenCalledWith(
      [
        { latitude: 59.93, longitude: 30.36, altitude: 5, intervalMs: 1000 },
        { latitude: 59.94, longitude: 30.37, altitude: 0, intervalMs: 2000 },
      ],
      { loop: true, speed: 2 },
      undefined,
    );
    expect(adapter.controlTrack).not.toHaveBeenCalled();
    expect((result as { text: string }).text).toContain("track loaded");
  });

  it("loads a track from a JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensor-track-"));
    const file = join(dir, "route.json");
    writeFileSync(
      file,
      JSON.stringify({
        positions: [{ latitude: 1.5, longitude: 2.5, altitude: 3, interval: 500 }],
      }),
    );

    try {
      const { ctx, adapter } = auroraCtx();
      await handler({ operation: "load", platform: "aurora", file }, ctx);

      expect(adapter.loadTrack).toHaveBeenCalledWith(
        [{ latitude: 1.5, longitude: 2.5, altitude: 3, intervalMs: 500 }],
        {},
        undefined,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires exactly one of positions/file for load", async () => {
    const { ctx } = auroraCtx();

    await expect(handler({ operation: "load", platform: "aurora" }, ctx)).rejects.toThrow(
      ValidationError,
    );
    await expect(
      handler(
        {
          operation: "load",
          platform: "aurora",
          positions: [{ latitude: 1, longitude: 2 }],
          file: "/tmp/route.json",
        },
        ctx,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid speed", async () => {
    const { ctx } = auroraCtx();

    await expect(
      handler(
        {
          operation: "load",
          platform: "aurora",
          positions: [{ latitude: 1, longitude: 2 }],
          speed: 9,
        },
        ctx,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("controls playback", async () => {
    const { ctx, adapter } = auroraCtx();

    const result = await handler({ operation: "start", platform: "aurora" }, ctx);

    expect(adapter.controlTrack).toHaveBeenCalledWith("start", {}, undefined);
    expect((result as { text: string }).text).toContain("started");
  });

  it("requires an index for goto", async () => {
    const { ctx, adapter } = auroraCtx();

    await expect(handler({ operation: "goto", platform: "aurora" }, ctx)).rejects.toThrow(
      ValidationError,
    );
    expect(adapter.controlTrack).not.toHaveBeenCalled();

    await handler({ operation: "goto", index: 3, platform: "aurora" }, ctx);
    expect(adapter.controlTrack).toHaveBeenCalledWith("goto", { index: 3 }, undefined);
  });

  it("rejects index for non-goto actions", async () => {
    const { ctx } = auroraCtx();

    await expect(
      handler({ operation: "pause", index: 1, platform: "aurora" }, ctx),
    ).rejects.toThrow(ValidationError);
  });

  it("reports unsupported platforms", async () => {
    const { ctx } = auroraCtx();

    const result = await handler(
      {
        operation: "load",
        platform: "android",
        positions: [{ latitude: 1, longitude: 2 }],
      },
      ctx,
    ) as { text: string };

    expect(result.text).toContain("not supported on platform: android");
  });
});
