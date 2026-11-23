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
    return findProcessWithLibrary(this.client, pid, "libqtium-engine");
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
      // Newer/older hooks differ in which dump command is implemented.
      try {
        const tree = await this.dump("app:dumpTree", packageName);
        const json = parseCompressedPayload(tree.value);
        return this.toSnapshot(json, packageName);
      } catch {
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
    if (response.status !== 0 || typeof response.value !== "string" || response.value.length === 0) {
      throw new UiTreeUnavailableError(
        `Qtium command ${command} returned status ${String(response.status)} with no payload.`,
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

    socket.on("connect", () => {
      const initialize = JSON.stringify({
        cmd: "action",
        action: "initialize",
        params: [packageName],
      });
      socket.write(`${initialize}\n`);
      setTimeout(() => {
        socket.write(`${JSON.stringify({
          cmd: "action",
          action: "execute",
          params: [[command, []]],
        })}\n`);
      }, 250);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: QtiumResponse;
        try {
          parsed = JSON.parse(trimmed) as QtiumResponse;
        } catch {
          continue;
        }
        if (typeof parsed.status === "number") {
          finish(undefined, parsed);
          return;
        }
      }
    });
  });
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
  const nodes: UiTreeNode[] = [];
  const maxX = { value: 0 };
  const maxY = { value: 0 };

  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const raw = value as QtiumNode;
    const x = toNumber(raw.abs_x);
    const y = toNumber(raw.abs_y);
    const width = toNumber(raw.width);
    const height = toNumber(raw.height);
    const className = typeof raw.classname === "string" ? raw.classname : "QmlItem";
    const text = typeof raw.mainTextProperty === "string" ? raw.mainTextProperty : "";
    const objectName = typeof raw.objectName === "string" ? raw.objectName : "";
    const visible = raw.visible !== false;

    if (visible && x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      maxX.value = Math.max(maxX.value, x + width);
      maxY.value = Math.max(maxY.value, y + height);
    }

    if (visible && x !== undefined && y !== undefined && width !== undefined && height !== undefined
      && width > 0 && height > 0) {
      nodes.push({
        kind: "qtium",
        id: objectName || `${className}@${x},${y}`,
        className,
        text,
        contentDesc: "",
        resourceId: objectName,
        packageName,
        bounds: { x1: x, y1: y, x2: x + width, y2: y + height },
        clickable: isClickableClass(className) || text.length > 0,
        longClickable: false,
        scrollable: isScrollableClass(className),
        enabled: raw.enabled !== false,
        focusable: isTextInputClass(className),
        focused: false,
        selected: false,
        checkable: false,
        checked: false,
        password: false,
      });
    }

    if (Array.isArray(raw.children)) {
      for (const child of raw.children) walk(child);
    }
  };

  walk(tree);

  // QML dumps are normally already in screen pixels. If a build reports a
  // larger logical space, scale it to the device coordinate space so taps line
  // up with audb input.
  const scaleX = maxX.value > screen.width * 1.1 ? screen.width / maxX.value : 1;
  const scaleY = maxY.value > screen.height * 1.1 ? screen.height / maxY.value : 1;
  if (scaleX !== 1 || scaleY !== 1) {
    for (const node of nodes) {
      node.bounds = {
        x1: Math.round(node.bounds.x1 * scaleX),
        y1: Math.round(node.bounds.y1 * scaleY),
        x2: Math.round(node.bounds.x2 * scaleX),
        y2: Math.round(node.bounds.y2 * scaleY),
      };
    }
  }

  // QML children can extend past the window. Clamp so the XML bounds regex
  // (which only accepts unsigned integers) does not silently drop them.
  for (const node of nodes) {
    node.bounds = {
      x1: clamp(node.bounds.x1, 0, screen.width),
      y1: clamp(node.bounds.y1, 0, screen.height),
      x2: clamp(node.bounds.x2, 0, screen.width),
      y2: clamp(node.bounds.y2, 0, screen.height),
    };
  }

  return nodes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isClickableClass(className: string): boolean {
  return /Button|MouseArea|ListItem|MenuItem|Switch|Slider|ComboBox|TextField|TextArea|IconButton/i.test(className);
}

function isScrollableClass(className: string): boolean {
  return /Flickable|ListView|GridView|ScrollView|PageView/i.test(className);
}

function isTextInputClass(className: string): boolean {
  return /TextField|TextArea|TextInput/i.test(className);
}
