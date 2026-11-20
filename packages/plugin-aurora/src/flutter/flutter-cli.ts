/**
 * Async, argv-only execution of the Aurora Flutter CLI.
 *
 * Security:
 *  - `spawn` is used with an argv array; `shell: true` is never set.
 *  - Only structured, allow-listed arguments are built here. Callers cannot
 *    pass arbitrary `flutterArgs`.
 *  - stdout/stderr are bounded and line callbacks receive raw lines only for
 *    in-memory parsing; persisted streams are redacted by the caller.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { accessSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { FlutterError } from "./errors.js";
import type { FlutterDevice, FlutterVersion } from "./types.js";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

function appendBounded(
  chunks: string[],
  chunk: string,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
): void {
  if (state.truncated) return;
  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.length > remaining) {
    chunks.push(chunk.slice(0, remaining));
    state.bytes += remaining;
    state.truncated = true;
    return;
  }
  chunks.push(chunk);
  state.bytes += chunk.length;
}

function createLineSplitter(onLine?: (line: string) => void) {
  let pending = "";
  return {
    push(chunk: string): void {
      if (!onLine) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        try {
          onLine(line);
        } catch {
          // A consumer callback must never break stream collection.
        }
        newline = pending.indexOf("\n");
      }
      // Bound a pathological line without newlines.
      if (pending.length > 1_000_000) {
        try {
          onLine(pending.slice(0, 1_000_000));
        } catch {
          // ignore
        }
        pending = pending.slice(1_000_000);
      }
    },
    flush(): void {
      if (!onLine || pending.length === 0) return;
      const line = pending.replace(/\r$/, "");
      pending = "";
      try {
        onLine(line);
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Run a command without a shell, capture bounded output, and stop the whole
 * managed process group on timeout or abort.
 */
export const runCommand: CommandExecutor = (
  command,
  args,
  options = {},
): Promise<CommandResult> => {
  const {
    cwd,
    env,
    timeoutMs = 0,
    signal,
    maxStdoutBytes = DEFAULT_MAX_STREAM_BYTES,
    maxStderrBytes = DEFAULT_MAX_STREAM_BYTES,
    onStdoutLine,
    onStderrLine,
  } = options;
  const startedMs = Date.now();

  return new Promise<CommandResult>((resolvePromise) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    const stdoutLines = createLineSplitter(onStdoutLine);
    const stderrLines = createLineSplitter(onStderrLine);

    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killTree = (signalName: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          child.kill(signalName);
        } else {
          process.kill(-pid, signalName);
        }
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // Process is already gone.
        }
      }
    };

    const finish = (
      exitCode: number | null,
      spawnError?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      stdoutLines.flush();
      stderrLines.flush();
      resolvePromise({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
        timedOut,
        aborted,
        spawnError,
        durationMs: Date.now() - startedMs,
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
      });
    };

    const requestStop = (): void => {
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      appendBounded(stdoutChunks, chunk, stdoutState, maxStdoutBytes);
      stdoutLines.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      appendBounded(stderrChunks, chunk, stderrState, maxStderrBytes);
      stderrLines.push(chunk);
    });

    child.on("error", (error) => {
      finish(null, error.message);
    });

    child.on("close", (code) => {
      finish(typeof code === "number" ? code : null);
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        requestStop();
      }, timeoutMs);
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
    }

    if (signal) {
      const onAbort = (): void => {
        aborted = true;
        requestStop();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Resolve an explicit path or a PATH entry to an absolute executable path.
 * Defaults to `flutter-aurora`, i.e. the Aurora build — never plain `flutter`.
 */
export function resolveFlutterBinary(explicit?: string): string {
  const configured =
    explicit
    ?? process.env.FLUTTER_AURORA_BIN
    ?? process.env.AURORA_FLUTTER_BIN
    ?? "flutter-aurora";

  if (isAbsolute(configured)) {
    try {
      accessSync(configured, fsConstants.X_OK);
    } catch {
      throw new FlutterError(
        `Aurora Flutter binary is not executable: ${configured}`,
        "FLUTTER_NOT_FOUND",
      );
    }
    return resolve(configured);
  }

  if (configured.includes("/") || configured.includes("\\")) {
    const absolute = resolve(configured);
    try {
      accessSync(absolute, fsConstants.X_OK);
    } catch {
      throw new FlutterError(
        `Aurora Flutter binary is not executable: ${absolute}`,
        "FLUTTER_NOT_FOUND",
      );
    }
    return absolute;
  }

  const found = findOnPath(configured);
  if (!found) {
    throw new FlutterError(
      `Aurora Flutter binary not found (${configured}). Set FLUTTER_AURORA_BIN to the absolute path of flutter-aurora.`,
      "FLUTTER_NOT_FOUND",
    );
  }
  return resolve(found);
}

export interface FlutterCliOptions {
  binary?: string;
  executor?: CommandExecutor;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface FlutterTestProcessOptions {
  projectPath: string;
  testPath: string;
  flutterDeviceId: string;
  fileReporterPath: string;
  timeoutMs: number;
  testTimeout?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export class FlutterCli {
  readonly configuredBinary: string;
  private readonly executor: CommandExecutor;
  private readonly commandTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private resolvedBinary?: string;

  constructor(options: FlutterCliOptions = {}) {
    this.configuredBinary =
      options.binary
      ?? process.env.FLUTTER_AURORA_BIN
      ?? process.env.AURORA_FLUTTER_BIN
      ?? "flutter-aurora";
    this.executor = options.executor ?? runCommand;
    this.commandTimeoutMs = options.timeoutMs ?? 120_000;
    this.env = options.env ?? process.env;
  }

  /** Absolute path used for exec, resolved lazily so doctor can report errors. */
  binary(): string {
    if (!this.resolvedBinary) {
      this.resolvedBinary = resolveFlutterBinary(this.configuredBinary);
    }
    return this.resolvedBinary;
  }

  realPath(): string | undefined {
    try {
      return realpathSync(this.binary());
    } catch {
      return undefined;
    }
  }

  private async run(
    args: string[],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    const result = await this.executor(this.binary(), args, {
      env: this.env,
      timeoutMs: this.commandTimeoutMs,
      ...options,
    });
    if (result.spawnError) {
      throw new FlutterError(
        `Failed to launch Aurora Flutter: ${result.spawnError}`,
        "FLUTTER_NOT_FOUND",
      );
    }
    return result;
  }

  async version(): Promise<FlutterVersion> {
    const result = await this.run(["--version", "--machine"]);
    if (result.exitCode !== 0) {
      throw new FlutterError(
        `flutter --version --machine failed (exit ${String(result.exitCode)}).`,
        "FLUTTER_COMMAND_FAILED",
      );
    }
    try {
      return JSON.parse(result.stdout) as FlutterVersion;
    } catch {
      throw new FlutterError(
        "flutter --version --machine returned malformed JSON.",
        "FLUTTER_MALFORMED_JSON",
      );
    }
  }

  async doctor(): Promise<CommandResult> {
    return this.run(["doctor", "-v"], { timeoutMs: 180_000 });
  }

  async devicesMachine(): Promise<FlutterDevice[]> {
    const result = await this.run(["devices", "--machine"]);
    if (result.exitCode !== 0) {
      throw new FlutterError(
        `flutter devices --machine failed (exit ${String(result.exitCode)}).`,
        "FLUTTER_COMMAND_FAILED",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new FlutterError(
        "flutter devices --machine returned malformed JSON.",
        "FLUTTER_MALFORMED_JSON",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new FlutterError(
        "flutter devices --machine did not return an array.",
        "FLUTTER_MALFORMED_JSON",
      );
    }
    return parsed.filter((item): item is FlutterDevice => {
      return (
        typeof item === "object"
        && item !== null
        && typeof (item as FlutterDevice).id === "string"
      );
    });
  }

  /**
   * Run `flutter test` with the allow-listed arguments used by the MVP.
   * No caller-provided extra argv is accepted.
   */
  async testProcess(options: FlutterTestProcessOptions): Promise<CommandResult> {
    const args = [
      "test",
      options.testPath,
      "-d",
      options.flutterDeviceId,
      "--reporter=json",
      `--file-reporter=json:${options.fileReporterPath}`,
    ];
    if (options.testTimeout !== undefined) {
      args.push("--timeout", `${Math.trunc(options.testTimeout)}s`);
    }
    return this.run(args, {
      cwd: options.projectPath,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onStdoutLine: options.onStdoutLine,
      onStderrLine: options.onStderrLine,
    });
  }
}
