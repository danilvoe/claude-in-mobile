/**
 * Built-in Aurora OS plugin.
 *
 * Wraps AuroraAdapter. Aurora supports app lifecycle, shell, logs and screen
 * capture but does NOT have runtime permissions. The plugin also exposes the
 * Flutter/QEMU workflow tools (flutter_doctor, flutter_devices, flutter_test)
 * which orchestrate `flutter-aurora` for a normal audb device — no separate
 * `aurora-flutter` platform or device is created.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import { AuroraAdapter } from "./aurora-adapter.js";
import { FlutterTestController } from "./flutter/test.js";
import { buildFlutterTools } from "./flutter/tools.js";
import { buildAuroraUiTools } from "./ui-tree/tools.js";

export const AURORA_PLUGIN_MANIFEST: PluginManifest = {
  id: "aurora",
  name: "Aurora OS",
  version: "4.4.1",
  apiVersion: "1",
  capabilities: ["screen", "input", "ui", "shell", "appLifecycle", "logs", "fileTransfer", "deviceMgmt", "location"],
  tools: ["flutter_doctor", "flutter_devices", "flutter_test", "flutter_permissions", "aurora_ui_setup"],
  description:
    "Aurora OS automation via audb (screen, input, app lifecycle, shell, logs) plus Flutter/QEMU test orchestration",
};

export class AuroraPlugin implements SourcePlugin {
  readonly manifest = AURORA_PLUGIN_MANIFEST;
  readonly adapter: AuroraAdapter;
  private flutter?: FlutterTestController;

  constructor(adapter: AuroraAdapter = new AuroraAdapter()) {
    this.adapter = adapter;
  }

  init(ctx: PluginContext): void {
    if (this.flutter) return;
    this.flutter = new FlutterTestController();
    const tools = buildFlutterTools(this.flutter);
    for (const tool of tools) {
      ctx.registerTool(tool);
    }
    const uiTools = buildAuroraUiTools(this.adapter.getUiTreeProvider());
    for (const tool of uiTools) {
      ctx.registerTool(tool);
    }
    ctx.logger.info(`[aurora] registered ${tools.length + uiTools.length} Flutter/QEMU and UI-tree tools`);
  }

  async dispose(): Promise<void> {
    await this.flutter?.dispose();
    this.flutter = undefined;
    this.adapter.dispose();
  }
}

export function createAuroraPlugin(): SourcePlugin {
  return new AuroraPlugin();
}

export { AuroraAdapter } from "./aurora-adapter.js";
export { AuroraClient, auroraClient } from "./client.js";
export { FlutterTestController } from "./flutter/test.js";
export { AudbCli } from "./flutter/audb.js";
export { FlutterCli } from "./flutter/flutter-cli.js";
export { DeviceResolver } from "./flutter/devices.js";
export { JsonReporter, renderJUnit } from "./flutter/reporter.js";
export { redactSecrets } from "./flutter/redact.js";
export { buildFlutterTools } from "./flutter/tools.js";
export { AuroraUiTreeProvider } from "./ui-tree/provider.js";
export { buildAuroraUiTools } from "./ui-tree/tools.js";
export type {
  UiTreeSnapshot,
  UiTreeNode,
  UiTreeBackendKind,
} from "./ui-tree/types.js";
export * from "./flutter/types.js";
export const createPlugin = createAuroraPlugin;
export default createAuroraPlugin;
