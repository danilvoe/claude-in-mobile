import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { AuroraUiTreeProvider } from "./provider.js";

const PACKAGE = "ru.example.app";

interface FakeDeviceOptions {
  apps?: Array<{ package: string; pid: number }>;
  logs?: string;
  /** `audb shell --root` works (emulator) or fails (physical device). */
  root?: boolean;
  /** pid -> /proc/<pid>/maps contents, only visible to root. */
  maps?: Record<number, string>;
  children?: Record<number, number[]>;
}

/**
 * `audb app list-running` reports the outer firejail pid (100); the real app
 * process is nested 1-2 levels down (101+).
 */
function fakeDevice(options: FakeDeviceOptions = {}): AuroraClient {
  const apps = options.apps ?? [{ package: PACKAGE, pid: 100 }];
  const root = options.root ?? false;
  const maps = options.maps ?? {};
  const children = options.children ?? { 100: [101], 101: [] };

  const probe = (command: string, privileged: boolean): string => {
    const childrenMatch = command.match(/\/proc\/(\d+)\/task\/\d+\/children/);
    if (childrenMatch) {
      return (children[Number(childrenMatch[1])] ?? []).join(" ");
    }
    const mapsMatch = command.match(/grep -q (\S+) \/proc\/(\d+)\/maps/);
    if (mapsMatch) {
      if (!privileged) return "unreadable";
      return (maps[Number(mapsMatch[2])] ?? "").includes(mapsMatch[1]) ? "match" : "other";
    }
    return "";
  };

  return {
    shell: (command: string): string => probe(command, false),
    shellRoot: (command: string): string => {
      if (!root) throw new Error("audb shell --root command failed.");
      if (command.trim() === "id -u") return "0";
      if (command.includes("ss -tlnp")) return "";
      if (command.includes("systemctl is-active")) return "inactive";
      return probe(command, true);
    },
    listRunningApps: () => apps,
    getLogs: (): string => options.logs ?? "",
    activateApp: (): boolean => true,
    getScreenshotGeometry: () => ({ width: 720, height: 1280 }),
    getDeviceRecord: (): never => {
      throw new Error("device record unavailable in tests");
    },
  } as unknown as AuroraClient;
}

const VM_SERVICE_LINE =
  "ru.example.app[5150]: Dart VM Service is listening on http://127.0.0.1:34819/AbC-1_2=/";

// The Flutter backend is selected exactly when the dump reaches the SSH tunnel
// stage (getDeviceRecord throws inside ensureSession). A qtium selection fails
// earlier with UI_TREE_SETUP_REQUIRED.
const FLUTTER_SELECTED = "FLUTTER_UI_TREE_FAILED";
const QTium_SELECTED = "UI_TREE_SETUP_REQUIRED";

describe("AuroraUiTreeProvider backend selection", () => {
  it("selects flutter from the VM Service line when maps are unreadable (no root)", async () => {
    const provider = new AuroraUiTreeProvider(
      fakeDevice({ logs: VM_SERVICE_LINE }),
      { flutterTimeoutMs: 1_000, qtiumTimeoutMs: 1_000 },
    );

    await expect(provider.getHierarchy()).rejects.toMatchObject({ code: FLUTTER_SELECTED });
  });

  it("falls back to qtium when maps are unreadable and no VM Service line exists", async () => {
    const provider = new AuroraUiTreeProvider(
      fakeDevice({}),
      { flutterTimeoutMs: 1_000, qtiumTimeoutMs: 1_000 },
    );

    await expect(provider.getHierarchy()).rejects.toMatchObject({ code: QTium_SELECTED });
  });

  it("still resolves the nested flutter pid through root (regression)", async () => {
    const provider = new AuroraUiTreeProvider(
      fakeDevice({
        root: true,
        maps: { 100: "firejail", 101: "libflutter_engine.so" },
        logs: VM_SERVICE_LINE,
      }),
      { flutterTimeoutMs: 1_000, qtiumTimeoutMs: 1_000 },
    );

    await expect(provider.getHierarchy()).rejects.toMatchObject({ code: FLUTTER_SELECTED });
  });

  it("reports the flutter backend in setup() on a rootless device", async () => {
    const provider = new AuroraUiTreeProvider(
      fakeDevice({ logs: VM_SERVICE_LINE }),
      { flutterTimeoutMs: 1_000, qtiumTimeoutMs: 1_000 },
    );

    await expect(provider.setup({ packageName: PACKAGE })).resolves.toMatchObject({
      ok: true,
      backend: "flutter",
    });
  });

  it("reports BRIDGE_INACTIVE instead of throwing when root is unavailable", async () => {
    const provider = new AuroraUiTreeProvider(
      fakeDevice({}),
      { flutterTimeoutMs: 1_000, qtiumTimeoutMs: 1_000 },
    );

    await expect(provider.setup({ packageName: PACKAGE })).resolves.toMatchObject({
      ok: false,
      backend: "qtium",
      code: "BRIDGE_INACTIVE",
      bridgeActive: false,
    });
  });
});

describe("AuroraUiTreeProvider cache invalidation", () => {
  it("does not tear down the Flutter VM session on input-driven invalidation", () => {
    const provider = new AuroraUiTreeProvider(fakeDevice());
    const flutter = (provider as unknown as { flutter: { invalidate: () => void } }).flutter;
    let calls = 0;
    flutter.invalidate = () => {
      calls += 1;
    };

    provider.invalidate();
    expect(calls).toBe(0);

    // Switching apps must drop the old session.
    provider.setActivePackage(PACKAGE);
    expect(calls).toBe(1);
  });
});
