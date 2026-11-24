/**
 * Qt/QML UI-tree backend (qtium-driver bridge).
 *
 * The bridge is an Aurora SDK component (`qtium-bridge.service`) that exposes
 * a newline-delimited JSON protocol on port 8888. It is available on Aurora
 * 5.1.5+ when "Allow UI autotesting" is enabled in developer mode. Only
 * third-party sandboxed Qt/QML apps load the `libqtium-driver-hook.so` hook.
 *
 * The bridge itself is reached through the same SSH forwarding helper as the
 * Flutter VM Service; the device-side port is 8888.
 */

import net from "node:net";
import zlib from "node:zlib";

import type { AuroraClient } from "../client.js";
import { findProcessWithLibrary } from "./process-scan.js";
import { SshTunnel } from "./tunnel.js";
import {
  UiTreeUnavailableError,
  UiTreeSetupRequiredError,
  type ScreenGeometry,
  type UiTreeNode,
  type UiTreeSnapshot,
} from "./types.js";

const QTIUM_PORT = 8888;
const COMMAND_TIMEOUT_MS = 8_000;
const PID_CACHE_TTL_MS = 2_000;

interface QtiumNode {
  classname?: unknown;
  abs_x?: unknown;
  abs_y?: unknown;
  width?: unknown;
  height?: unknown;
  mainTextProperty?: unknown;
  objectName?: unknown;
  enabled?: unknown;
  visible?: unknown;
  children?: unknown;
  acceptedButtons?: unknown;
  contentY?: unknown;
}

interface QtiumResponse {
  status?: number;
  value?: string;
}

interface CachedTunnel {
  host: string;
  tunnel: SshTunnel;
}

export interface QtiumUiTreeOptions {
  timeoutMs?: number;
}

export class QtiumUiTreeBackend {
  private readonly client: AuroraClient;
  private readonly timeoutMs: number;
  private tunnel?: CachedTunnel;
  private readonly pidCache = new Map<number, { pid: number | undefined; at: number }>();

  constructor(client: AuroraClient, options: QtiumUiTreeOptions = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  /** Is the bridge service running on the device? */
  isBridgeActive(): boolean {
    try {
      const output = this.client.shellRoot("systemctl is-active qtium-bridge || true");
      return output.trim() === "active" || output.includes("active");
    } catch {
      return false;
    }
  }

  /** Is the sailjail LD_PRELOAD permission file present for the app user? */
  hasHookPermission(): boolean {
    try {
      const output = this.client.shellRoot(
        "test -s ~defaultuser/.local/share/qtium/permission.local && echo yes || echo no",
      );
      return output.includes("yes");
    } catch {
      return false;
    }
  }

  /** Has this process loaded the qtium hook? Resolves the inner app pid. */
  isAppHooked(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const resolved = this.resolveAppPid(pid) ?? pid;
    try {
      const output = this.client.shellRoot(
        `grep -q libqtium-engine /proc/${resolved}/maps && echo hooked || echo plain`,
      );
      return output.includes("hooked");
    } catch {
      return false;
    }
  }

  /** Resolve the real QML app process behind the sailjail wrapper. */
  resolveAppPid(pid: number): number | undefined {
    const cached = this.pidCache.get(pid);
    if (cached && Date.now() - cached.at < PID_CACHE_TTL_MS) return cached.pid;
    const resolved = findProcessWithLibrary(this.client, pid, "libqtium-engine");
    this.pidCache.set(pid, { pid: resolved, at: Date.now() });
    return resolved;
  }

  /** Drop cached process lookups (e.g. after the app was restarted). */
  invalidatePidCache(): void {
    this.pidCache.clear();
  }

  async getSnapshot(packageName: string, pid: number): Promise<UiTreeSnapshot> {
    if (!this.isBridgeActive()) {
      throw new UiTreeSetupRequiredError(
        "The Aurora qtium bridge is not running. Call aurora_ui_setup to enable UI autotesting.",
        { packageName, pid },
      );
    }
    if (!this.isAppHooked(pid)) {
      throw new UiTreeSetupRequiredError(
        `The qtium hook is not loaded in ${packageName}. Call aurora_ui_setup with restartApp=true to relaunch it.`,
        { packageName, pid },
      );
    }

    try {
      const current = await this.dump("app:dumpCurrentPage", packageName);
      const tree = parseTreePayload(current.value);
      return this.toSnapshot(tree, packageName);
    } catch (currentError) {
      if (currentError instanceof UiTreeSetupRequiredError) throw currentError;
      // Newer/older hooks differ in which dump command is implemented.
      try {
        const tree = await this.dump("app:dumpTree", packageName);
        const json = parseCompressedPayload(tree.value);
        return this.toSnapshot(json, packageName);
      } catch (fallbackError) {
        if (fallbackError instanceof UiTreeSetupRequiredError) throw fallbackError;
        const message = currentError instanceof Error ? currentError.message : String(currentError);
        throw new UiTreeUnavailableError(
          `Qtium UI dump failed: ${message}`,
          "QTIUM_DUMP_UNAVAILABLE",
          { packageName, pid },
        );
      }
    }
  }

  close(): void {
    this.tunnel?.tunnel.close();
    this.tunnel = undefined;
    this.pidCache.clear();
  }

  private toSnapshot(tree: unknown, packageName: string): UiTreeSnapshot {
    const screen = this.client.getScreenshotGeometry();
    const nodes = flattenQtiumTree(tree, packageName, screen);
    if (nodes.length === 0) {
      throw new UiTreeUnavailableError(
        "Qtium returned an empty UI tree.",
        "QTIUM_EMPTY_TREE",
      );
    }
    return {
      backend: "qtium",
      packageName,
      screen,
      nodes,
      metadata: { bridgePort: QTIUM_PORT },
    };
  }

  private async dump(command: string, packageName: string): Promise<QtiumResponse> {
    const device = this.client.getDeviceRecord();
    const tunnel = await this.ensureTunnel(device.host);
    const response = await sendCommand(tunnel.localPort, command, packageName, this.timeoutMs);
    if (response.status !== 0) {
      const value = typeof response.value === "string" ? response.value : "";
      if (value === "unknown_app") {
        throw new UiTreeSetupRequiredError(
          `${packageName} is not connected to the qtium bridge. Restart it with aurora_ui_setup({ restartApp: true }).`,
          { packageName, status: response.status },
        );
      }
      throw new UiTreeUnavailableError(
        `Qtium command ${command} failed with status ${String(response.status)}${value ? `: ${value.slice(0, 120)}` : ""}.`,
        "QTIUM_DUMP_FAILED",
        { packageName, status: response.status },
      );
    }
    if (typeof response.value !== "string" || response.value.length === 0) {
      throw new UiTreeUnavailableError(
        `Qtium command ${command} returned no payload.`,
        "QTIUM_DUMP_EMPTY",
      );
    }
    return response;
  }

  private async ensureTunnel(host: string): Promise<SshTunnel> {
    if (this.tunnel && this.tunnel.host === host) return this.tunnel.tunnel;
    this.close();
    const device = this.client.getDeviceRecord();
    const tunnel = await SshTunnel.open({
      host: device.host,
      port: device.sshPort,
      user: device.sshUser,
      keyPath: device.sshKey,
      remoteHost: "127.0.0.1",
      remotePort: QTIUM_PORT,
    });
    this.tunnel = { host, tunnel };
    return tunnel;
  }
}

function sendCommand(
  port: number,
  command: string,
  packageName: string,
  timeoutMs: number,
): Promise<QtiumResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, response?: QtiumResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new UiTreeUnavailableError("Qtium returned no response.", "QTIUM_NO_RESPONSE"));
    };

    const timer = setTimeout(() => {
      finish(new UiTreeUnavailableError(
        `Qtium command ${command} timed out.`,
        "QTIUM_TIMEOUT",
      ));
    }, timeoutMs);

    socket.once("error", (error) => finish(new UiTreeUnavailableError(
      `Qtium connection failed: ${error.message}`,
      "QTIUM_CONNECT_FAILED",
    )));

    // The bridge processes commands in order, so both lines can be written at
    // once; `initialize` itself has no reply.
    socket.on("connect", () => {
      socket.write(buildCommandPayload(packageName, command));
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // The bridge does not always terminate the last reply with a newline, so
      // try the whole buffer first and only then fall back to line splitting.
      const whole = buffer.trim();
      if (whole.startsWith("{")) {
        const parsed = tryParseResponse(whole);
        if (parsed) {
          finish(undefined, parsed);
          return;
        }
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = tryParseResponse(line.trim());
        if (parsed) {
          finish(undefined, parsed);
          return;
        }
      }
    });
  });
}

function tryParseResponse(text: string): QtiumResponse | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as QtiumResponse;
    return typeof parsed.status === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire format of the bridge: newline-delimited JSON. `execute` must carry
 * `[command, args]` (the bridge looks up `executeCommand(ITransportClient*,
 * QString, QVariant)`), not a nested list.
 */
export function buildCommandPayload(packageName: string, command: string, args: unknown[] = []): string {
  return [
    JSON.stringify({ cmd: "action", action: "initialize", params: [packageName] }),
    JSON.stringify({ cmd: "action", action: "execute", params: [command, args] }),
    "",
  ].join("\n");
}

// Exported for tests.
export function parseTreePayload(value: string | undefined): unknown {
  if (typeof value !== "string") {
    throw new UiTreeUnavailableError("Qtium returned no tree payload.", "QTIUM_EMPTY_TREE");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new UiTreeUnavailableError("Qtium tree payload is not valid JSON.", "QTIUM_INVALID_TREE");
  }
}

// Exported for tests.
export function parseCompressedPayload(value: string | undefined): unknown {
  if (typeof value !== "string") {
    throw new UiTreeUnavailableError("Qtium returned no tree payload.", "QTIUM_EMPTY_TREE");
  }
  try {
    const inflated = zlib.inflateSync(Buffer.from(value, "base64")).toString("utf8");
    return JSON.parse(inflated);
  } catch {
    // Some builds return plain JSON for dumpTree.
    return parseTreePayload(value);
  }
}

// Exported for tests.
export function flattenQtiumTree(tree: unknown, packageName: string, screen: ScreenGeometry): UiTreeNode[] {
  const root = tree !== null && typeof tree === "object" ? (tree as QtiumNode) : {};
  const scale = computeScale(root, tree, screen);

  const nodes: UiTreeNode[] = [];

  const walk = (value: unknown, inheritedVisible: boolean): void => {
    if (value === null || typeof value !== "object") return;
    const raw = value as QtiumNode;
    const visible = inheritedVisible && raw.visible !== false;
    // Skip the whole subtree: a hidden container renders nothing.
    if (!visible) return;

    const x = toNumber(raw.abs_x);
    const y = toNumber(raw.abs_y);
    const width = toNumber(raw.width);
    const height = toNumber(raw.height);
    const className = typeof raw.classname === "string" ? raw.classname : "QmlItem";
    const text = typeof raw.mainTextProperty === "string" ? raw.mainTextProperty : "";
    const objectName = typeof raw.objectName === "string" ? raw.objectName : "";

    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined
      && width > 0 && height > 0) {
      const clickable = isClickable(raw, className);
      const scrollable = isScrollable(raw, className);
      const focusable = isTextInputClass(className);
      const bounds = {
        x1: Math.round(x * scale.x),
        y1: Math.round(y * scale.y),
        x2: Math.round((x + width) * scale.x),
        y2: Math.round((y + height) * scale.y),
      };
      // QML list delegates exist outside the viewport. Drop them instead of
      // clamping, otherwise they all pile up on the screen edge.
      const meaningful = text.length > 0 || objectName.length > 0
        || clickable || scrollable || focusable;
      if (meaningful && !isOffscreen(bounds, screen)) {
        nodes.push({
          kind: "qtium",
          id: objectName || `${className}@${x},${y}`,
          className,
          text,
          contentDesc: "",
          resourceId: objectName,
          packageName,
          bounds: {
            x1: clamp(bounds.x1, 0, screen.width),
            y1: clamp(bounds.y1, 0, screen.height),
            x2: clamp(bounds.x2, 0, screen.width),
            y2: clamp(bounds.y2, 0, screen.height),
          },
          clickable,
          longClickable: false,
          scrollable,
          enabled: raw.enabled !== false,
          focusable,
          focused: false,
          selected: false,
          checkable: false,
          checked: false,
          password: false,
        });
      }
    }

    if (Array.isArray(raw.children)) {
      for (const child of raw.children) walk(child, visible);
    }
  };

  walk(tree, true);
  return nodes;
}

/**
 * QML dumps are usually in logical pixels (720x1600 for a 2x screen) while
 * audb input works in screenshot pixels. Scale by the root window extent, not
 * by the children: list views keep delegates far outside the viewport.
 */
function computeScale(
  root: QtiumNode,
  tree: unknown,
  screen: ScreenGeometry,
): { x: number; y: number } {
  const rootX = toNumber(root.abs_x) ?? 0;
  const rootY = toNumber(root.abs_y) ?? 0;
  const rootWidth = toNumber(root.width);
  const rootHeight = toNumber(root.height);

  if (rootWidth !== undefined && rootHeight !== undefined && rootWidth > 0 && rootHeight > 0) {
    const logicalWidth = rootX + rootWidth;
    const logicalHeight = rootY + rootHeight;
    return {
      x: logicalWidth > screen.width * 1.05 ? screen.width / logicalWidth : 1,
      y: logicalHeight > screen.height * 1.05 ? screen.height / logicalHeight : 1,
    };
  }

  // Fallback for payloads without a sized root: use the visible extent.
  let maxX = 0;
  let maxY = 0;
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const raw = value as QtiumNode;
    if (raw.visible !== false) {
      const x = toNumber(raw.abs_x);
      const y = toNumber(raw.abs_y);
      const width = toNumber(raw.width);
      const height = toNumber(raw.height);
      if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      }
    }
    if (Array.isArray(raw.children)) {
      for (const child of raw.children) walk(child);
    }
  };
  walk(tree);
  return {
    x: maxX > screen.width * 1.1 ? screen.width / maxX : 1,
    y: maxY > screen.height * 1.1 ? screen.height / maxY : 1,
  };
}

function isOffscreen(
  bounds: { x1: number; y1: number; x2: number; y2: number },
  screen: ScreenGeometry,
): boolean {
  return bounds.x1 >= screen.width || bounds.y1 >= screen.height
    || bounds.x2 <= 0 || bounds.y2 <= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const INTERACTIVE_CLASS =
  /Button|MouseArea|ListItem|MenuItem|Switch|Slider|ComboBox|TextField|TextArea|IconButton/i;
const SCROLLABLE_CLASS = /Flickable|ListView|GridView|ScrollView|PageView/i;
/** Full-screen containers also accept touches but are not tappable targets. */
const CONTAINER_CLASS = /^(?:MainPage|Page|PageHeader|ApplicationWindow|SilicaFlickable|AppBar|BackgroundRectangle)$/;

/**
 * `acceptedButtons` is exported by MouseArea-derived items and is the most
 * reliable "this responds to touches" signal in the dump.
 */
function isClickable(raw: QtiumNode, className: string): boolean {
  if (CONTAINER_CLASS.test(className)) return false;
  const acceptedButtons = toNumber(raw.acceptedButtons);
  if (acceptedButtons !== undefined && acceptedButtons > 0) return true;
  return INTERACTIVE_CLASS.test(className);
}

function isScrollable(raw: QtiumNode, className: string): boolean {
  if (toNumber(raw.contentY) !== undefined) return true;
  return SCROLLABLE_CLASS.test(className);
}

function isTextInputClass(className: string): boolean {
  return /TextField|TextArea|TextInput/i.test(className);
}
