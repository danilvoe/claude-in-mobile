/**
 * Aurora UI-tree provider.
 *
 * Chooses between the Flutter VM Service backend (debug/profile Flutter apps)
 * and the qtium QML backend, caches the resulting XML briefly, and exposes an
 * explicit setup operation for the agent (enable autotesting / restart app).
 *
 * The provider never restarts an application implicitly: only `setup()` with
 * `restartApp: true` does that, and it is called through the
 * `aurora_ui_setup` tool.
 */

import type { AuroraClient, RunningApp } from "../client.js";
import { errorCode } from "../flutter/errors.js";
import { FlutterUiTreeBackend } from "./flutter.js";
import { QtiumUiTreeBackend } from "./qtium.js";
import {
  UiTreeSetupRequiredError,
  UiTreeUnavailableError,
  type UiTreeBackendKind,
} from "./types.js";
import { uiNodesToHierarchyXml } from "./xml.js";

export interface AuroraUiTreeOptions {
  ttlMs?: number;
  flutterTimeoutMs?: number;
  qtiumTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface UiTreeSetupOptions {
  packageName?: string;
  restartApp?: boolean;
  enableAutoTest?: boolean;
}

export interface UiTreeSetupResult {
  ok: boolean;
  packageName?: string;
  backend?: UiTreeBackendKind | "unknown";
  bridgeActive?: boolean;
  appHooked?: boolean;
  hookPermission?: boolean;
  appRestarted?: boolean;
  needsAppRestart?: boolean;
  message?: string;
  code?: string;
}

interface CacheEntry {
  packageName: string;
  pid: number;
  backend: UiTreeBackendKind;
  xml: string;
  at: number;
}

interface TargetApp {
  packageName: string;
  pid: number;
}

interface PidResolution {
  innerPid: number;
  backend: UiTreeBackendKind;
  at: number;
}

const DEFAULT_TTL_MS = 300;
const PID_RESOLUTION_TTL_MS = 5_000;

export class AuroraUiTreeProvider {
  private readonly client: AuroraClient;
  private readonly ttlMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly flutter: FlutterUiTreeBackend;
  private readonly qtium: QtiumUiTreeBackend;
  private activePackage?: string;
  private cache?: CacheEntry;
  private inFlight?: { key: string; promise: Promise<string> };
  private readonly pidResolution = new Map<number, PidResolution>();

  constructor(client: AuroraClient, options: AuroraUiTreeOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.env = options.env ?? process.env;
    this.flutter = new FlutterUiTreeBackend(client, {
      timeoutMs: options.flutterTimeoutMs ?? 25_000,
    });
    this.qtium = new QtiumUiTreeBackend(client, {
      timeoutMs: options.qtiumTimeoutMs ?? 10_000,
    });
  }

  /** Select the audb device used by the provider, if explicitly requested. */
  selectDevice(deviceId?: string): void {
    if (!deviceId) return;
    this.client.selectDevice(deviceId);
    this.setActivePackage(undefined);
    this.invalidate();
  }

  /** Called by the adapter after app launch/stop. */
  setActivePackage(packageName: string | undefined): void {
    this.activePackage = packageName;
    this.pidResolution.clear();
    // The VM Service session belongs to the previous app.
    this.flutter.invalidate();
    this.invalidate();
  }

  getActivePackage(): string | undefined {
    return this.activePackage;
  }

  /**
   * Invalidate the cached XML only. Input actions call this after every tap;
   * tearing down the Flutter VM session here would force re-discovery from a
   * journal line that may already be gone.
   */
  invalidate(): void {
    this.cache = undefined;
  }

  close(): void {
    this.cache = undefined;
    this.flutter.close();
    this.qtium.close();
  }

  /** Return the uiautomator-shaped XML for the current Aurora app. */
  async getHierarchy(options: { fresh?: boolean; packageName?: string } = {}): Promise<string> {
    const target = this.resolveTarget(options.packageName);

    if (
      !options.fresh
      && this.cache
      && this.cache.packageName === target.packageName
      && this.cache.pid === target.pid
      && Date.now() - this.cache.at < this.ttlMs
    ) {
      return this.cache.xml;
    }

    // A concurrent dump for a different app must not be shared.
    const key = `${target.packageName}:${target.pid}`;
    if (this.inFlight?.key === key) return await this.inFlight.promise;

    const promise = this.dump(target).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    });
    this.inFlight = { key, promise };
    return await promise;
  }

  /**
   * Explicit setup path used by `aurora_ui_setup`.
   *
   * For Flutter apps this only reports the backend (no autotesting required).
   * For QML apps it enables the qtium bridge, refreshes sailjail permissions
   * and, only when `restartApp` is true, relaunches the application so the
   * LD_PRELOAD hook is actually loaded.
   */
  async setup(options: UiTreeSetupOptions = {}): Promise<UiTreeSetupResult> {
    const running = this.runningApps();
    const explicit = options.packageName ?? this.activePackage ?? this.env.AURORA_UI_APP;
    const target = explicit
      ? running.find((app) => app.package === explicit)
      : running.length === 1
        ? running[0]
        : undefined;

    if (explicit && !target) {
      // Allow setup for a known-but-not-running app by launching it below.
      if (!options.restartApp) {
        return {
          ok: false,
          packageName: explicit,
          backend: "unknown",
          code: "APP_NOT_RUNNING",
          message: `App ${explicit} is not running. Launch it with app(action:'launch') or call aurora_ui_setup with restartApp=true.`,
        };
      }
      try {
        this.client.launchApp(explicit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already running/i.test(message)) throw error;
      }
      this.setActivePackage(explicit);
      const app = await this.waitForApp(explicit, 15_000);
      if (!app) {
        return {
          ok: false,
          packageName: explicit,
          backend: "unknown",
          code: "APP_NOT_RUNNING",
          message: `App ${explicit} did not start.`,
        };
      }
      return await this.setupForApp(app, options);
    }

    if (!target) {
      return {
        ok: false,
        backend: "unknown",
        code: "AMBIGUOUS_APP",
        message: running.length === 0
          ? "No Aurora application is running. Launch one first."
          : `Multiple applications are running: ${running.map((app) => app.package).join(", ")}. Pass packageName to aurora_ui_setup.`,
      };
    }

    this.setActivePackage(target.package);
    return await this.setupForApp(target, options);
  }

  private async setupForApp(app: RunningApp, options: UiTreeSetupOptions): Promise<UiTreeSetupResult> {
    // The tree describes the app's window; a backgrounded app receives neither
    // taps nor the same visible content. Raise it unless it is being restarted.
    if (!options.restartApp) {
      this.client.activateApp(app.package);
    }

    // A VM Service log line proves a Flutter debug build even when maps probing
    // is impossible (non-root SSH user on a physical device).
    const flutterEvidence = this.flutter.detectApp(app.package, app.pid);
    if (flutterEvidence) {
      const vmService = flutterEvidence.vmService ?? this.flutter.findVmService(app.package);
      if (!vmService) {
        return {
          ok: false,
          packageName: app.package,
          backend: "flutter",
          code: "VM_SERVICE_NOT_DISCOVERED",
          message: "A Flutter app was detected, but no VM Service log was found. Use a debug build, keep the app running, and retry.",
        };
      }
      return {
        ok: true,
        packageName: app.package,
        backend: "flutter",
        message: "Flutter debug app detected. UI tree is available through the VM Service; no autotesting setup is required.",
      };
    }

    let bridgeActive = this.qtium.isBridgeActive();
    let hookPermission = this.qtium.hasHookPermission();
    if ((!bridgeActive || !hookPermission) && options.enableAutoTest !== false) {
      try {
        this.enableAutoTest();
        bridgeActive = await this.waitForBridge(15_000);
        hookPermission = this.qtium.hasHookPermission();
      } catch {
        // No root SSH: developer-mode setup cannot run. Report the bridge as
        // inactive below instead of throwing an opaque audb error.
        bridgeActive = false;
      }
    }

    let appHooked = this.qtium.isAppHooked(app.pid);
    let appRestarted = false;
    if (!appHooked && options.restartApp) {
      // sailjaild caches the permission set; refresh it before relaunching.
      try {
        this.client.shellRoot("systemctl restart sailjaild");
      } catch {
        /* setup will report the hook as missing */
      }
      await this.restartApp(app.package);
      appRestarted = true;
      this.qtium.invalidatePidCache();
      this.pidResolution.clear();
      const restarted = await this.waitForApp(app.package, 15_000);
      if (restarted) {
        app.pid = restarted.pid;
        appHooked = this.qtium.isAppHooked(app.pid);
      }
    }

    if (!bridgeActive) {
      return {
        ok: false,
        packageName: app.package,
        backend: "qtium",
        bridgeActive,
        appHooked,
        hookPermission,
        appRestarted,
        code: "BRIDGE_INACTIVE",
        message: "qtium-bridge is not running and could not be enabled. Check developer mode and root SSH.",
      };
    }

    if (!appHooked) {
      return {
        ok: false,
        packageName: app.package,
        backend: "qtium",
        bridgeActive,
        appHooked,
        hookPermission,
        appRestarted,
        needsAppRestart: true,
        code: "APP_RESTART_REQUIRED",
        message: `The qtium hook is not loaded in ${app.package}. Call aurora_ui_setup with restartApp=true to relaunch the app (the app state will be reset).`,
      };
    }

    return {
      ok: true,
      packageName: app.package,
      backend: "qtium",
      bridgeActive,
      appHooked,
      hookPermission,
      appRestarted,
      message: "qtium bridge and app hook are ready.",
    };
  }

  private async dump(target: TargetApp): Promise<string> {
    const resolved = this.resolveBackend(target);

    try {
      const snapshot = resolved.backend === "flutter"
        ? await this.flutter.getSnapshot(target.packageName, resolved.innerPid)
        : await this.qtium.getSnapshot(target.packageName, resolved.innerPid);
      const xml = uiNodesToHierarchyXml(snapshot.nodes, target.packageName);
      this.cache = {
        packageName: target.packageName,
        pid: target.pid,
        backend: resolved.backend,
        xml,
        at: Date.now(),
      };
      return xml;
    } catch (error) {
      this.cache = undefined;
      if (error instanceof UiTreeSetupRequiredError) throw error;
      if (error instanceof UiTreeUnavailableError) throw error;
      throw new UiTreeUnavailableError(
        error instanceof Error ? error.message : String(error),
        errorCode(error, "AURORA_UI_TREE_FAILED"),
      );
    }
  }

  /**
   * audb reports the outer sailjail/firejail pid; the engine/hook lives in a
   * nested child. Cache the mapping briefly because hints call the tree after
   * every input action.
   *
   * Detection order: privileged maps probing (nested pid), then the journal VM
   * Service line (works without root and names the inner pid), then qtium.
   */
  private resolveBackend(target: TargetApp): PidResolution {
    const cached = this.pidResolution.get(target.pid);
    if (cached && Date.now() - cached.at < PID_RESOLUTION_TTL_MS) return cached;

    const flutterEvidence = this.flutter.detectApp(target.packageName, target.pid);
    const entry: PidResolution = flutterEvidence !== undefined
      ? { innerPid: flutterEvidence.innerPid, backend: "flutter", at: Date.now() }
      : {
        innerPid: this.qtium.resolveAppPid(target.pid) ?? target.pid,
        backend: "qtium",
        at: Date.now(),
      };
    this.pidResolution.set(target.pid, entry);
    return entry;
  }

  private resolveTarget(explicit?: string): TargetApp {
    const running = this.runningApps();
    // The app launched through MCP wins over the static env override.
    const packageName = explicit ?? this.activePackage ?? this.env.AURORA_UI_APP;

    if (packageName) {
      const app = running.find((entry) => entry.package === packageName);
      if (!app) {
        throw new UiTreeUnavailableError(
          `App ${packageName} is not running. Launch it with app(action:'launch') before reading the UI tree.`,
          "APP_NOT_RUNNING",
          { packageName },
        );
      }
      return { packageName: app.package, pid: app.pid };
    }

    if (running.length === 1) {
      return { packageName: running[0].package, pid: running[0].pid };
    }
    if (running.length === 0) {
      throw new UiTreeUnavailableError(
        "No Aurora application is running. Launch one before reading the UI tree.",
        "APP_NOT_RUNNING",
      );
    }

    throw new UiTreeUnavailableError(
      `Multiple Aurora applications are running: ${running.map((app) => app.package).join(", ")}. `
        + "Call aurora_ui_setup with packageName (or set AURORA_UI_APP) to choose one.",
      "AMBIGUOUS_APP",
      { candidates: running.map((app) => app.package) },
    );
  }

  private runningApps(): RunningApp[] {
    try {
      return this.client.listRunningApps();
    } catch {
      return [];
    }
  }

  private enableAutoTest(): void {
    const enable = [
      "gdbus call --system --dest ru.omp.developermode --object-path /",
      "--method ru.omp.developermode.SetAutoTestUIEnabled true",
    ].join(" ");
    try {
      this.client.shellRoot(enable);
    } catch {
      // Developer mode itself may be off; enabling it is a prerequisite.
      this.client.shellRoot(
        "gdbus call --system --dest ru.omp.developermode --object-path / --method ru.omp.developermode.SetEnabled true",
      );
      this.client.shellRoot(enable);
    }
    // sailjaild caches the per-app permission set. Restarting it is enough;
    // the tablet does not need a reboot.
    this.client.shellRoot("systemctl restart sailjaild");
  }

  private async restartApp(packageName: string): Promise<void> {
    try {
      this.client.stopApp(packageName);
    } catch {
      /* already stopped */
    }
    // RuntimeManager stops asynchronously; launching too early fails with
    // ApplicationAlreadyRunning.
    await this.waitForStop(packageName, 10_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.client.launchApp(packageName);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already running/i.test(message) || attempt === 2) throw error;
        await sleep(500);
      }
    }
    this.setActivePackage(packageName);
  }

  private async waitForStop(packageName: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.runningApps().some((entry) => entry.package === packageName)) return true;
      await sleep(200);
    }
    return false;
  }

  private async waitForApp(packageName: string, timeoutMs: number): Promise<RunningApp | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const app = this.runningApps().find((entry) => entry.package === packageName);
      if (app) return app;
      await sleep(250);
    }
    return undefined;
  }

  private async waitForBridge(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.qtium.isBridgeActive()) return true;
      await sleep(250);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
