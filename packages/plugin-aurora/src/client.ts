import { execFileSync } from "child_process";
import { rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { MobileError } from "mcp-devices/errors";
import { validateDeviceId } from "mcp-devices/utils/sanitize";
import {
  makePrivateTempDir,
  readPrivateFileSync,
} from "mcp-devices/utils/private-storage";

export interface Device {
  id: string;
  name: string;
  platform: "aurora";
  state: string;
  isSimulator: boolean;
  host?: string;
}

export interface LogOptions {
  lines?: number;
  priority?: string;
  unit?: string;
  grep?: string;
  since?: string;
}

export interface AuroraTrackPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  /** Milliseconds between this point and the previous one. Default: 2000. */
  intervalMs?: number;
}

export interface AuroraTrackOptions {
  loop?: boolean;
  /** Track playback speed multiplier (audb/OS UI accepts 1–5). */
  speed?: number;
  /** true — use each point's intervalMs; false — fixed 2 s per point. */
  defaultInterval?: boolean;
}

export type AuroraTrackAction = "start" | "pause" | "resume" | "stop" | "goto";

export interface AuroraTrackControlOptions extends AuroraTrackOptions {
  /** Index of the point for the `goto` action. */
  index?: number;
}

const EXEC_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const STATE_CACHE_TTL_MS = 10_000;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const MAX_PULL_BYTES = 16 * 1024 * 1024;

interface AudbDeviceEntry {
  id?: unknown;
  name?: unknown;
  host?: unknown;
  kind?: unknown;
  current?: unknown;
}

interface DeviceStateCacheEntry {
  state: string;
  checkedAt: number;
}

/** Extract the `data` payload from an `audb --json` envelope (or the bare value). */
function parseAudbData(output: string): unknown {
  const parsed: unknown = JSON.parse(output);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "data" in parsed &&
    (parsed as { ok?: unknown }).ok !== false
  ) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

export class AuroraClient {
  private readonly stateCache = new Map<string, DeviceStateCacheEntry>();

  /**
   * SECURITY: All audb invocations route through this argv-form path (execFileSync — no /bin/sh -c).
   * Shell metacharacters in `args` are passed as literal argv slots, not parsed by the host shell.
   * This structurally prevents host-side OS Command Injection (CWE-78) — see issue #40.
   *
   * Mirrors the defense applied in src/adb/client.ts:75-97.
   */
  private runAudbSync(args: string[], timeoutMs: number = EXEC_TIMEOUT_MS): string {
    try {
      const output = execFileSync("audb", args, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: EXEC_TIMEOUT_MS,
      });
      return output.trim();
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Reflect.get(error, "code")
        : undefined;
      if (code === "ENOENT") {
        throw new Error("audb not found. Install: cargo install audb-client");
      }
      throw new MobileError(
        `audb ${args[0] ?? "unknown"} command failed.`,
        "AUDB_COMMAND_FAILED",
      );
  }
  }

  async checkAvailability(): Promise<boolean> {
    try {
      execFileSync("audb", ["--version"], {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all configured Aurora devices.
   *
   * audb 0.4.2+ emits JSON for machine-readable output; older builds printed a
   * fixed-width table. JSON is preferred, with the table parser kept as a
   * compatibility fallback for older audb releases.
   *
   * @returns Array of Device objects
   */
  listDevices(): Device[] {
    try {
      const devices = this.readDeviceRegistry();
      for (const device of devices) {
        device.state = this.probeState(device.id);
      }
      return devices;
    } catch {
      // Older audb: fall back to the legacy table output.
      try {
        return this.parseDeviceTable(this.runAudbSync(["device", "list"]));
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Aurora] Failed to list devices: ${errorMessage}`);
        // Return empty array on error (e.g., audb not installed)
        return [];
      }
    }
  }

  private readDeviceRegistry(): Device[] {
    const output = this.runAudbSync(["--json", "device", "list"]);
    const data = parseAudbData(output);
    if (!Array.isArray(data)) {
      throw new Error("Unexpected audb device list payload.");
    }

    return data.map((raw) => {
      const entry = raw as AudbDeviceEntry;
      const host = typeof entry.host === "string" ? entry.host : undefined;
      const id =
        typeof entry.id === "string" && entry.id.length > 0
          ? entry.id
          : host ?? "unknown";
      return {
        id,
        name:
          typeof entry.name === "string" && entry.name.length > 0
            ? entry.name
            : id,
        platform: "aurora" as const,
        state: "unknown",
        isSimulator: entry.kind === "emulator",
        host,
      };
    });
  }

  private parseDeviceTable(output: string): Device[] {
    const devices: Device[] = [];

    // Strip ANSI escape codes
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");

    for (const line of cleanOutput.split("\n")) {
      // Skip headers, separators, and empty lines
      if (!line.trim() || line.includes("---") || line.includes("Index")) continue;

      // Parse format: "0     R570                 192.168.2.13       22     aurora-arm connected(3609s) *"
      const match = line.match(
        /^\s*\d+\s+(\S+)\s+([\d.]+)\s+\d+\s+(\S+)\s+(.+?)\s*(?:\*)?$/,
      );
      if (match) {
        const [, name, host, platformId, status] = match;
        devices.push({
          id: host,
          name: name.trim(),
          platform: "aurora",
          state: status.includes("connected") ? "connected" : "disconnected",
          isSimulator: /emulator/i.test(platformId),
          host,
        });
      }
    }

    return devices;
  }

  /**
   * Probe connection state through `audb status`. The registry itself only
   * reports `unknown`, so this is what makes auto-detection reliable.
   * Results are cached briefly to avoid an SSH round-trip per tool call.
   */
  private probeState(id: string): string {
    const cached = this.stateCache.get(id);
    if (cached && Date.now() - cached.checkedAt < STATE_CACHE_TTL_MS) {
      return cached.state;
    }

    let state = "disconnected";
    try {
      const data = parseAudbData(
        this.runAudbSync(["--json", "--device", id, "status"], PROBE_TIMEOUT_MS),
      );
      if (
        data !== null &&
        typeof data === "object" &&
        (data as { connected?: unknown }).connected === true
      ) {
        state = "connected";
      }
    } catch {
      state = "disconnected";
    }

    this.stateCache.set(id, { state, checkedAt: Date.now() });
    return state;
  }

  getActiveDevice(): string {
    const path = join(homedir(), ".config", "audb", "current_device");
    let selected: string;
    try {
      selected = readPrivateFileSync(path, 4096, "active Aurora device").toString("utf8").trim();
    } catch {
      throw new Error("Failed to read the active Aurora device.");
    }
    validateDeviceId(selected);
    return selected;
  }

  selectDevice(deviceId: string): void {
    validateDeviceId(deviceId);
    this.runAudbSync(["select", deviceId]);
  }

  // ============ Location emulation (emulators only) ============

  /**
   * Set the emulated GPS position.
   * audb rejects this command on physical devices (CAPABILITY_UNAVAILABLE).
   */
  setLocation(latitude: number, longitude: number, altitude = 0): void {
    this.runAudbSync([
      "--json",
      "location",
      "set",
      String(latitude),
      String(longitude),
      String(altitude),
    ]);
  }

  /**
   * Load a GPS track into the emulator. Does not start playback — call
   * `controlTrack("start")` explicitly so tests control the timing.
   */
  loadTrack(points: AuroraTrackPoint[], options: AuroraTrackOptions = {}): void {
    if (points.length === 0) {
      throw new MobileError("Track must contain at least one point.", "INVALID_ARGUMENT");
    }
    this.assertTrackOptions(options);

    const positions = points.map((point) => ({
      latitude: point.latitude,
      longitude: point.longitude,
      altitude: point.altitude ?? 0,
      interval: point.intervalMs ?? 2000,
    }));

    const tempDir = makePrivateTempDir("aurora-track");
    const trackFile = join(tempDir, "track.json");
    try {
      writeFileSync(trackFile, JSON.stringify({ positions }), {
        encoding: "utf8",
        mode: 0o600,
      });
      const args = ["--json", "location", "track", "load", trackFile];
      this.appendTrackOptions(args, options);
      this.runAudbSync(args);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Control track playback: start / pause / resume / stop / goto.
   */
  controlTrack(action: AuroraTrackAction, options: AuroraTrackControlOptions = {}): void {
    this.assertTrackOptions(options);

    const args = ["--json", "location", "track", action];
    if (action === "goto") {
      if (options.index === undefined) {
        throw new MobileError("The goto action requires an index.", "INVALID_ARGUMENT");
      }
      if (!Number.isInteger(options.index) || options.index < 0) {
        throw new MobileError("Track index must be a non-negative integer.", "INVALID_ARGUMENT");
      }
      args.push(String(options.index));
    }
    this.appendTrackOptions(args, options);
    this.runAudbSync(args);
  }

  private appendTrackOptions(args: string[], options: AuroraTrackOptions): void {
    if (options.loop !== undefined) args.push("--loop", options.loop ? "on" : "off");
    if (options.defaultInterval !== undefined) {
      args.push("--default-interval", options.defaultInterval ? "on" : "off");
    }
    if (options.speed !== undefined) args.push("--speed", String(options.speed));
  }

  private assertTrackOptions(options: AuroraTrackOptions): void {
    if (
      options.speed !== undefined &&
      (!Number.isInteger(options.speed) || options.speed < 1 || options.speed > 5)
    ) {
      throw new MobileError("Track speed must be an integer between 1 and 5.", "INVALID_ARGUMENT");
    }
  }

  /**
   * Performs a tap at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   */
  tap(x: number, y: number): void {
    this.runAudbSync(["tap", String(x), String(y)]);
  }

  /**
   * Performs a long press at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   * @param duration - Duration of the press in milliseconds
   */
  longPress(x: number, y: number, duration: number): void {
    this.runAudbSync(["tap", String(x), String(y), "--duration", String(duration)]);
  }

  /**
   * Performs a swipe in the specified direction.
   * @param direction - Direction to swipe: "up", "down", "left", or "right"
   */
  swipeDirection(direction: "up"|"down"|"left"|"right"): void {
    this.runAudbSync(["swipe", direction]);
  }

  /**
   * Performs a swipe from one coordinate to another.
   * @param x1 - Starting X coordinate in pixels
   * @param y1 - Starting Y coordinate in pixels
   * @param x2 - Ending X coordinate in pixels
   * @param y2 - Ending Y coordinate in pixels
   */
  swipeCoords(x1: number, y1: number, x2: number, y2: number): void {
    this.runAudbSync(["swipe", String(x1), String(y1), String(x2), String(y2)]);
  }

  /**
   * Performs a swipe from one coordinate to another.
   * Compatible with AdbClient signature.
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param durationMs - Duration in milliseconds (ignored by audb, kept for compatibility)
   */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void {
    this.runAudbSync(["swipe", String(x1), String(y1), String(x2), String(y2)]);
  }

  /** Input text on the selected Aurora device. */
  inputText(text: string): void {
    this.runAudbSync(["text", text]);
  }

  getUiHierarchy(): string {
    throw new MobileError(
      "Aurora UI hierarchy is not supported by audb.",
      "CAPABILITY_NOT_SUPPORTED",
    );
  }

  clearAppData(_packageName: string): void {
    throw new MobileError(
      "Aurora app-data clearing is not supported by audb.",
      "CAPABILITY_NOT_SUPPORTED",
    );
  }

  /**
   * Sends a keyboard key event to the device.
   * @param key - Key name to send (e.g., "Enter", "Back", "Home")
   */
  pressKey(key: string): void {
    this.runAudbSync(["key", key]);
  }

  /**
   * Take screenshot and return raw PNG buffer (consistent with Android/iOS)
   * @returns Raw PNG buffer
   */
  screenshotRaw(): Buffer {
    const tempDir = makePrivateTempDir("aurora-screenshot");
    const tmpFile = join(tempDir, "screenshot.png");

    try {
      // tmpFile passes as a literal argv slot — host shell never parses it,
      // so embedded metacharacters (if any future change introduced them) are inert.
      this.runAudbSync(["screenshot", "--output", tmpFile]);
      return readPrivateFileSync(tmpFile, MAX_SCREENSHOT_BYTES, "Aurora screenshot");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Takes a screenshot of the Aurora device
   * @returns Base64 encoded PNG screenshot
   */
  screenshot(): string {
    return this.screenshotRaw().toString("base64");
  }

  /**
   * Launch an application on the Aurora device
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   * @returns Output message from audb
   */
  launchApp(packageName: string): string {
    const output = this.runAudbSync(["launch", packageName]);
    return output || `Launched ${packageName}`;
  }

  /**
   * Stop a running application
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   */
  stopApp(packageName: string): void {
    this.runAudbSync(["stop", packageName]);
  }

  /**
   * Install an RPM package on the Aurora device
   * @param path - Local path to the RPM file
   * @returns Installation result message
   */
  installApp(path: string): string {
    const output = this.runAudbSync(["package", "install", path]);
    return output || `Installed ${path}`;
  }

  /**
   * Uninstall a package from the Aurora device
   * @param packageName - Package name (e.g., ru.domain.AppName)
   * @returns Uninstallation result message
   */
  uninstallApp(packageName: string): string {
    const output = this.runAudbSync(["package", "uninstall", packageName]);
    return output || `Uninstalled ${packageName}`;
  }

  /**
   * List installed packages on the Aurora device
   * @returns Array of package names
   */
  listPackages(): string[] {
    const output = this.runAudbSync(["package", "list"]);
    if (!output) return [];
    return output.split("\n").filter(line => line.trim().length > 0);
  }

  /**
   * Execute a shell command on the Aurora device.
   *
   * SECURITY: `command` travels as a SINGLE argv slot (`audb shell <command>`) — the host
   * shell never parses it, so host-side metacharacters (`;`, `&&`, backticks, `$()`)
   * cannot inject host-side commands. This structurally closes CWE-78 on the host (issue #40).
   *
   * NOTE on device-side semantics: `command` may still be parsed by the DEVICE shell once
   * audb hands it off. Call sites that accept untrusted input MUST validate via
   * `validateShellCommand` from src/utils/sanitize.ts (system_shell tool already does this).
   *
   * @param command - Shell command to execute (already validated at call site)
   * @returns Command output
   */
  shell(command: string): string {
    return this.runAudbSync(["shell", command]);
  }

  /**
   * Get device logs with optional filters
   * @param options - Log filtering options
   * @param options.lines - Maximum number of log lines to retrieve
   * @param options.priority - Filter by log priority level
   * @param options.unit - Filter by systemd unit
   * @param options.grep - Filter by grep pattern
   * @param options.since - Show logs since timestamp
   * @returns Log output
   */
  getLogs(options: LogOptions = {}): string {
    const args: string[] = ["logs"];
    if (options.lines) args.push("-n", String(Math.trunc(options.lines)));
    if (options.priority) args.push("--priority", options.priority);
    if (options.unit) args.push("--unit", options.unit);
    if (options.grep) args.push("--grep", options.grep);
    if (options.since) args.push("--since", options.since);

    return this.runAudbSync(args);
  }

  /**
   * Clear device logs
   * @returns Result message
   */
  clearLogs(): string {
    return this.runAudbSync(["logs", "--clear", "--force"]);
  }

  /**
   * Get detailed system information
   * @returns System info output
   */
  getSystemInfo(): string {
    return this.runAudbSync(["info"]);
  }

  /**
   * Upload a file to the Aurora device
   * @param localPath - Path to the local file
   * @param remotePath - Destination path on the device
   * @returns Upload result message
   */
  pushFile(localPath: string, remotePath: string): string {
    const output = this.runAudbSync(["push", localPath, remotePath]);
    return output || `Uploaded ${localPath} → ${remotePath}`;
  }

  /**
   * Download a file from the Aurora device
   * @param remotePath - Path to the remote file
   * @param localPath - Optional local destination path (defaults to remote filename)
   * @returns File contents as Buffer
   */
  pullFile(remotePath: string, localPath?: string): Buffer {
    const local = localPath || remotePath.split("/").pop() || "pulled_file";
    this.runAudbSync(["pull", remotePath, "--output", local]);
    return readPrivateFileSync(local, MAX_PULL_BYTES, "Aurora pulled file");
  }
}

export const auroraClient = new AuroraClient();
