/**
 * AuroraAdapter -- wraps AuroraClient.
 *
 * Implements core interaction, app lifecycle and inventory, shell/logs,
 * file transfer, and synchronous screenshots.
 *
 * Does NOT implement PermissionAdapter -- Aurora OS does not support
 * runtime permission management.
 */

import type {
  AppInventoryAdapter,
  AppManagementAdapter,
  CorePlatformAdapter,
  FileTransferAdapter,
  LocationAdapter,
  ShellAdapter,
  SyncScreenshotAdapter,
  TrackControlAction,
  TrackControlOptions,
  TrackOptions,
  TrackPoint,
} from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import { auroraClient as defaultAuroraClient, AuroraClient } from "./client.js";
import { AuroraUiTreeProvider } from "./ui-tree/provider.js";
import { compressScreenshot } from "mcp-devices/utils/image";
import type { CompressOptions } from "mcp-devices/utils/image";

export class AuroraAdapter
  implements
    CorePlatformAdapter,
    AppManagementAdapter,
    AppInventoryAdapter,
    ShellAdapter,
    FileTransferAdapter,
    SyncScreenshotAdapter,
    LocationAdapter
{
  readonly platform = "aurora" as const;
  private client: AuroraClient;
  private readonly uiTree: AuroraUiTreeProvider;

  constructor(client?: AuroraClient) {
    this.client = client ?? defaultAuroraClient;
    this.uiTree = new AuroraUiTreeProvider(this.client);
  }

  /** Raw client access -- needed by tools that call getAuroraClient(). */
  getClient(): AuroraClient {
    return this.client;
  }

  /** UI-tree provider shared with the `aurora_ui_setup` tool. */
  getUiTreeProvider(): AuroraUiTreeProvider {
    return this.uiTree;
  }

  dispose(): void {
    this.uiTree.close();
  }

  // ============ Device management ============

  listDevices(): Device[] {
    try {
      return this.client.listDevices();
    } catch {
      return [];
    }
  }

  selectDevice(deviceId: string): void {
    this.client.selectDevice(deviceId);
  }

  getSelectedDeviceId(): string | undefined {
    try {
      return this.client.getActiveDevice();
    } catch {
      return undefined;
    }
  }

  autoDetectDevice(): Device | undefined {
    const devices = this.listDevices();
    return devices.find(
      (d) => d.state === "device" || d.state === "booted" || d.state === "connected",
    );
  }

  // ============ Core actions ============

  async tap(x: number, y: number): Promise<void> {
    this.client.tap(x, y);
    this.uiTree.invalidate();
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100): Promise<void> {
    // Aurora: two taps with interval
    this.client.tap(x, y);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    this.client.tap(x, y);
    this.uiTree.invalidate();
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    this.client.longPress(x, y, durationMs);
    this.uiTree.invalidate();
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<void> {
    this.client.swipe(x1, y1, x2, y2, durationMs);
    this.uiTree.invalidate();
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    this.client.swipeDirection(direction);
    this.uiTree.invalidate();
  }

  async inputText(text: string): Promise<void> {
    this.client.inputText(text);
    this.uiTree.invalidate();
  }

  async pressKey(key: string): Promise<void> {
    this.client.pressKey(key);
    this.uiTree.invalidate();
  }

  // ============ Screenshot ============

  async screenshotAsync(
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = this.client.screenshotRaw();
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    return this.client.screenshotRaw();
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    return await this.uiTree.getHierarchy();
  }

  // ============ App management (AppManagementAdapter) ============

  launchApp(packageName: string): string {
    const result = this.client.launchApp(packageName);
    this.uiTree.setActivePackage(packageName);
    return result;
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
    if (this.uiTree.getActivePackage() === packageName) {
      this.uiTree.setActivePackage(undefined);
    }
  }

  installApp(path: string): string {
    return this.client.installApp(path);
  }

  // ============ App inventory (AppInventoryAdapter) ============

  listApps(): string[] {
    return this.client.listPackages();
  }

  uninstallApp(packageName: string): string {
    return this.client.uninstallApp(packageName);
  }

  // ============ Shell / Logs (ShellAdapter) ============

  shell(command: string): string {
    return this.client.shell(command);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}): string {
    return this.client.getLogs(options);
  }

  clearLogs(): string {
    return this.client.clearLogs();
  }

  // ============ File transfer (FileTransferAdapter) ============

  pushFile(localPath: string, remotePath: string): string {
    return this.client.pushFile(localPath, remotePath);
  }

  pullFile(remotePath: string, localPath?: string): string {
    const destination = localPath ?? remotePath.split("/").at(-1) ?? "pulled_file";
    const data = this.client.pullFile(remotePath, destination);
    return `Downloaded ${remotePath} → ${destination} (${data.byteLength} bytes)`;
  }

  // ============ Location emulation (LocationAdapter) ============

  setLocation(latitude: number, longitude: number, altitude = 0): string {
    this.client.setLocation(latitude, longitude, altitude);
    return `GPS location set on Aurora emulator:\n  Latitude:  ${latitude}\n  Longitude: ${longitude}\n  Altitude:  ${altitude}m`;
  }

  loadTrack(points: TrackPoint[], options: TrackOptions = {}): string {
    this.client.loadTrack(points, options);
    const details = [
      `${points.length} point${points.length === 1 ? "" : "s"}`,
      options.loop !== undefined ? `loop=${options.loop}` : undefined,
      options.speed !== undefined ? `speed=${options.speed}x` : undefined,
      options.defaultInterval !== undefined
        ? `defaultInterval=${options.defaultInterval}`
        : undefined,
    ].filter(Boolean);
    return `GPS track loaded on Aurora emulator (${details.join(", ")}). Call sensor(action:'track', operation:'start') to play it.`;
  }

  controlTrack(action: TrackControlAction, options: TrackControlOptions = {}): string {
    this.client.controlTrack(action, options);
    if (action === "goto") {
      return `GPS track moved to point ${options.index} on Aurora emulator.`;
    }
    const past = {
      start: "started",
      pause: "paused",
      resume: "resumed",
      stop: "stopped",
    } as const;
    return `GPS track ${past[action]} on Aurora emulator.`;
  }

  // ============ System info ============

  async getSystemInfo(): Promise<string> {
    return this.client.getSystemInfo();
  }
}
