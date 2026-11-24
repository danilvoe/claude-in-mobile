import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { FlutterUiTreeBackend } from "./flutter.js";
import { UiTreeUnavailableError } from "./types.js";

function fakeClient(options: { maps?: string; ss?: string; logs?: string }): AuroraClient {
  return {
    shell: (command: string): string => {
      if (command.includes("/proc/") && command.includes("maps")) {
        return options.maps ?? "other";
      }
      return "";
    },
    shellRoot: (command: string): string => {
      if (command.includes("ss -tlnp")) return options.ss ?? "";
      return options.maps ?? "other";
    },
    getLogs: (): string => options.logs ?? "",
  } as unknown as AuroraClient;
}

/**
 * Physical device, SSH user is not root: `audb shell --root` fails and
 * `/proc/<pid>/maps` is unreadable. Shared children are still readable.
 */
function rootlessClient(options: {
  logs?: string;
  children?: Record<number, number[]>;
  unprivilegedMaps?: string;
} = {}): AuroraClient {
  const children = options.children ?? {};
  return {
    shell: (command: string): string => {
      const childrenMatch = command.match(/\/proc\/(\d+)\/task\/\d+\/children/);
      if (childrenMatch) return (children[Number(childrenMatch[1])] ?? []).join(" ");
      if (command.includes("/proc/") && command.includes("maps")) {
        return options.unprivilegedMaps ?? "unreadable";
      }
      return "";
    },
    shellRoot: (): string => {
      throw new Error("audb shell --root command failed.");
    },
    getLogs: (): string => options.logs ?? "",
    getDeviceRecord: (): never => {
      throw new Error("device record unavailable in tests");
    },
  } as unknown as AuroraClient;
}

/** Emulator-like device: `audb shell --root` works, maps are readable. */
function privilegedClient(options: {
  logs?: string;
  children?: Record<number, number[]>;
  maps?: Record<number, string>;
}): AuroraClient {
  const children = options.children ?? {};
  const maps = options.maps ?? {};
  const probe = (command: string): string => {
    const childrenMatch = command.match(/\/proc\/(\d+)\/task\/\d+\/children/);
    if (childrenMatch) return (children[Number(childrenMatch[1])] ?? []).join(" ");
    const mapsMatch = command.match(/grep -q (\S+) \/proc\/(\d+)\/maps/);
    if (mapsMatch) {
      return (maps[Number(mapsMatch[2])] ?? "").includes(mapsMatch[1]) ? "match" : "other";
    }
    return "";
  };
  return {
    shell: probe,
    shellRoot: (command: string): string => {
      if (command.trim() === "id -u") return "0";
      if (command.includes("ss -tlnp")) return "";
      return probe(command);
    },
    getLogs: (): string => options.logs ?? "",
    getDeviceRecord: (): never => {
      throw new Error("device record unavailable in tests");
    },
  } as unknown as AuroraClient;
}

const VM_SERVICE_LINE =
  "ru.example.app[5150]: Dart VM Service is listening on http://127.0.0.1:34819/AbC-1_2=/";

describe("FlutterUiTreeBackend discovery", () => {
  it("reports the VM Service port when the auth token is no longer logged", async () => {
    const backend = new FlutterUiTreeBackend(
      fakeClient({
        ss: 'LISTEN 0 0 127.0.0.1:34819 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=39))',
      }),
    );

    await expect(backend.getSnapshot("ru.example.app", 4242)).rejects.toMatchObject({
      code: "VM_SERVICE_TOKEN_LOST",
      details: { port: 34819 },
    });
  });

  it("reports VM_SERVICE_NOT_DISCOVERED when the app has no VM Service socket", async () => {
    const backend = new FlutterUiTreeBackend(fakeClient({}));

    await expect(backend.getSnapshot("ru.example.app", 4242)).rejects.toMatchObject({
      code: "VM_SERVICE_NOT_DISCOVERED",
    });
  });

  it("findVmServicePort ignores non-localhost listeners", () => {
    const backend = new FlutterUiTreeBackend(
      fakeClient({
        ss: [
          'LISTEN 0 0 0.0.0.0:8080 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=5))',
          'LISTEN 0 0 127.0.0.1:39999 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=6))',
        ].join("\n"),
      }),
    );

    expect(backend.findVmServicePort(4242)).toBe(39999);
    expect(backend.findVmServicePort(0)).toBeUndefined();
  });

  it("throws a UiTreeUnavailableError when discovery fails", async () => {
    const backend = new FlutterUiTreeBackend(fakeClient({}));
    const error = await backend.getSnapshot("ru.example.app", 4242).catch((caught) => caught);

    expect(error).toBeInstanceOf(UiTreeUnavailableError);
    expect(error.code).toBe("VM_SERVICE_NOT_DISCOVERED");
  });

  it("finds an IPv6 localhost VM Service listener", () => {
    const backend = new FlutterUiTreeBackend(
      fakeClient({
        ss: 'LISTEN 0 0 [::1]:41000 [::]:* users:(("ru.example.app",pid=4242,fd=7))',
      }),
    );

    expect(backend.findVmServicePort(4242)).toBe(41000);
  });
});

describe("FlutterUiTreeBackend rootless detection", () => {
  it("uses the VM Service journal line when maps are unreadable", () => {
    const backend = new FlutterUiTreeBackend(rootlessClient({ logs: VM_SERVICE_LINE }));

    expect(backend.detectApp("ru.example.app", 100)).toEqual({
      innerPid: 5150,
      source: "vm-service",
      vmService: { pid: 5150, port: 34819 },
    });
  });

  it("returns undefined when maps are unreadable and no VM Service line exists", () => {
    const backend = new FlutterUiTreeBackend(rootlessClient({}));

    expect(backend.detectApp("ru.example.app", 100)).toBeUndefined();
  });

  it("reaches the VM Service instead of failing maps detection", async () => {
    const backend = new FlutterUiTreeBackend(rootlessClient({ logs: VM_SERVICE_LINE }));

    // getDeviceRecord throws, which only happens after backend selection chose
    // Flutter and the log line pid was used to open the session.
    await expect(backend.getSnapshot("ru.example.app", 100)).rejects.toMatchObject({
      code: "FLUTTER_UI_TREE_FAILED",
    });
  });

  it("reports VM_SERVICE_NOT_DISCOVERED without root and without a journal line", async () => {
    const backend = new FlutterUiTreeBackend(rootlessClient({}));

    await expect(backend.getSnapshot("ru.example.app", 100)).rejects.toMatchObject({
      code: "VM_SERVICE_NOT_DISCOVERED",
    });
  });

  it("still resolves the nested Flutter pid through root (regression)", () => {
    const backend = new FlutterUiTreeBackend(
      privilegedClient({
        children: { 100: [101], 101: [] },
        maps: { 100: "firejail", 101: "libflutter_engine.so" },
      }),
    );

    expect(backend.detectApp("ru.example.app", 100)).toEqual({
      innerPid: 101,
      source: "maps",
    });
    expect(backend.isFlutterProcess(101)).toBe(true);
    expect(backend.isFlutterProcess(100)).toBe(false);
  });
});
