/**
 * Device-scoped, JSON-only audb access.
 *
 * Every device operation passes `--device <id>` explicitly. This module never
 * calls `audb select` and never changes the global active device, so parallel
 * workflows cannot race on a shared default.
 */

import { validateDeviceId } from "mcp-devices/utils/sanitize";
import { runCommand } from "./flutter-cli.js";
import type { CommandExecutor, CommandResult } from "./flutter-cli.js";
import { FlutterError } from "./errors.js";
import { redactDeep, redactSecrets } from "./redact.js";
import type {
  AudbDeviceRecord,
  GrantPermissionsOptions,
  PermissionState,
} from "./types.js";

export interface AudbCliOptions {
  binary?: string;
  executor?: CommandExecutor;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface AudbEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

const AUDB_COMMAND_TIMEOUT_MS = 120_000;

export class AudbCli {
  readonly binary: string;
  private readonly executor: CommandExecutor;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AudbCliOptions = {}) {
    this.binary = options.binary ?? process.env.AUDB_PATH ?? "audb";
    this.executor = options.executor ?? runCommand;
    this.timeoutMs = options.timeoutMs ?? AUDB_COMMAND_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  private async raw(args: string[], timeoutMs = this.timeoutMs): Promise<CommandResult> {
    const result = await this.executor(this.binary, args, {
      env: this.env,
      timeoutMs,
    });
    if (result.spawnError) {
      throw new FlutterError(
        `audb not found (${this.binary}): ${result.spawnError}`,
        "AUDB_NOT_FOUND",
      );
    }
    return result;
  }

  private async json<T>(deviceId: string, args: string[]): Promise<T> {
    validateDeviceId(deviceId);
    const full = ["--device", deviceId, "--json", ...args];
    const result = await this.raw(full);
    let envelope: AudbEnvelope<T>;
    try {
      envelope = JSON.parse(result.stdout) as AudbEnvelope<T>;
    } catch {
      throw new FlutterError(
        `audb ${args[0] ?? "command"} returned malformed JSON.`,
        "AUDB_MALFORMED_JSON",
      );
    }
    if (result.exitCode !== 0 || envelope.ok === false) {
      const message = envelope.error?.message ?? `exit ${String(result.exitCode)}`;
      throw new FlutterError(
        `audb ${args.slice(0, 2).join(" ")} failed: ${redactSecrets(message)}`,
        envelope.error?.code ?? "AUDB_COMMAND_FAILED",
      );
    }
    return redactDeep(envelope.data as T);
  }

  async version(): Promise<string> {
    const result = await this.raw(["--version"]);
    if (result.exitCode !== 0) {
      throw new FlutterError(
        "audb --version failed.",
        "AUDB_COMMAND_FAILED",
      );
    }
    return result.stdout.trim();
  }

  /** Global registry list; no device exists yet, hence no --device flag. */
  async listDevices(): Promise<AudbDeviceRecord[]> {
    const result = await this.raw(["--json", "device", "list"]);
    if (result.exitCode !== 0) {
      throw new FlutterError(
        "audb device list failed.",
        "AUDB_COMMAND_FAILED",
      );
    }
    try {
      const envelope = JSON.parse(result.stdout) as AudbEnvelope<AudbDeviceRecord[]>;
      return Array.isArray(envelope.data) ? envelope.data : [];
    } catch {
      throw new FlutterError(
        "audb device list returned malformed JSON.",
        "AUDB_MALFORMED_JSON",
      );
    }
  }

  async doctor(deviceId: string): Promise<unknown> {
    return this.json(deviceId, ["doctor"]);
  }

  async capabilities(deviceId: string): Promise<unknown> {
    return this.json(deviceId, ["capabilities"]);
  }

  async packageList(deviceId: string): Promise<string[]> {
    const data = await this.json<{ packages?: string[] }>(deviceId, ["package", "list"]);
    return Array.isArray(data.packages) ? data.packages : [];
  }

  async screenshot(deviceId: string, outputPath: string, timeoutMs = 120_000): Promise<void> {
    await this.json(deviceId, ["screenshot", "--output", outputPath]);
  }

  async logsSince(deviceId: string, since: string): Promise<string> {
    const data = await this.json<{ output?: string }>(deviceId, [
      "logs",
      "--since",
      since,
    ]);
    return redactSecrets(typeof data.output === "string" ? data.output : "");
  }

  async crashList(
    deviceId: string,
    packageId: string | undefined,
    since: string,
  ): Promise<unknown[]> {
    const args = ["crash", "list"];
    if (packageId) args.push(packageId);
    args.push("--since", since);
    const data = await this.json<{ events?: unknown[] }>(deviceId, args);
    return Array.isArray(data.events) ? data.events : [];
  }

  private validateApplicationId(applicationId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(applicationId)) {
      throw new FlutterError(
        `Invalid Sailjail application ID: ${applicationId}`,
        "INVALID_ARGUMENT",
      );
    }
  }

  async permissionList(
    deviceId: string,
    applicationId: string,
  ): Promise<PermissionState> {
    this.validateApplicationId(applicationId);
    return this.json<PermissionState>(deviceId, [
      "permission",
      "list",
      applicationId,
    ]);
  }

  async permissionGrant(
    deviceId: string,
    applicationId: string,
    options: GrantPermissionsOptions = {},
  ): Promise<unknown> {
    this.validateApplicationId(applicationId);
    const permissions = options.permissions ?? [];
    if (options.allRequested && permissions.length > 0) {
      throw new FlutterError(
        "Specify permissions or allRequested=true, but not both.",
        "INVALID_ARGUMENT",
      );
    }
    if (!options.allRequested && permissions.length === 0) {
      throw new FlutterError(
        "Specify at least one permission or allRequested=true.",
        "INVALID_ARGUMENT",
      );
    }
    const args = ["permission", "grant", applicationId];
    if (options.allRequested) args.push("--all-requested");
    else args.push(...permissions);
    if (options.disablePrompt) args.push("--disable-prompt");
    return this.json(deviceId, args);
  }

  async permissionRevoke(
    deviceId: string,
    applicationId: string,
    permissions: string[],
  ): Promise<unknown> {
    this.validateApplicationId(applicationId);
    if (permissions.length === 0) {
      throw new FlutterError(
        "At least one permission is required for revoke.",
        "INVALID_ARGUMENT",
      );
    }
    return this.json(deviceId, [
      "permission",
      "revoke",
      applicationId,
      ...permissions,
    ]);
  }

  async permissionReset(
    deviceId: string,
    applicationId: string,
  ): Promise<unknown> {
    this.validateApplicationId(applicationId);
    return this.json(deviceId, ["permission", "reset", applicationId]);
  }

  async permissionPrompt(
    deviceId: string,
    applicationId: string,
    enabled: boolean,
  ): Promise<unknown> {
    this.validateApplicationId(applicationId);
    return this.json(deviceId, [
      "permission",
      "prompt",
      applicationId,
      enabled ? "--enable" : "--disable",
    ]);
  }
}
