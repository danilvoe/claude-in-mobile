/**
 * Run artifacts: private directories, screenshots, redacted logs and crash
 * events. Collector failures are recorded in `artifactErrors` and never change
 * the original Flutter test result or exit code.
 */

import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AudbCli } from "./audb.js";
import { redactSecrets } from "./redact.js";
import type { ArtifactError } from "./types.js";

export interface ArtifactCollectorOptions {
  dir: string;
  audb: AudbCli;
  deviceId: string;
  screenshotIntervalMs?: number;
  maxScreenshots?: number;
  maxScreenshotBytes?: number;
  maxScreenshotFileBytes?: number;
}

const DEFAULT_MAX_SCREENSHOTS = 60;
const DEFAULT_MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT_FILE_BYTES = 20 * 1024 * 1024;

export class ArtifactCollector {
  readonly dir: string;
  readonly errors: ArtifactError[] = [];
  readonly testScreenshots = new Map<number, string[]>();
  screenshotCount = 0;

  private readonly audb: AudbCli;
  private readonly deviceId: string;
  private readonly intervalMs: number;
  private readonly maxScreenshots: number;
  private readonly maxScreenshotBytes: number;
  private readonly maxScreenshotFileBytes: number;
  private capturedBytes = 0;
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private limitReported = false;

  constructor(options: ArtifactCollectorOptions) {
    this.dir = resolve(options.dir);
    this.audb = options.audb;
    this.deviceId = options.deviceId;
    this.intervalMs = options.screenshotIntervalMs ?? 5_000;
    this.maxScreenshots = options.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
    this.maxScreenshotFileBytes =
      options.maxScreenshotFileBytes ?? DEFAULT_MAX_SCREENSHOT_FILE_BYTES;
  }

  get screenshotsDir(): string {
    return join(this.dir, "screenshots");
  }

  get logsDir(): string {
    return join(this.dir, "logs");
  }

  get crashDir(): string {
    return join(this.dir, "crash");
  }

  get flutterDir(): string {
    return join(this.dir, "flutter");
  }

  async init(): Promise<void> {
    for (const directory of [this.dir, this.screenshotsDir, this.logsDir, this.crashDir, this.flutterDir]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  /** Write a file (0600) inside the run directory, rejecting traversal. */
  async write(relativePath: string, content: string | Buffer): Promise<string> {
    if (relativePath.includes("..") || relativePath.startsWith("/")) {
      throw new Error(`Refusing to write outside the run directory: ${relativePath}`);
    }
    const path = join(this.dir, relativePath);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
    return path;
  }

  private recordError(artifact: string, error: unknown): void {
    this.errors.push({
      artifact,
      message: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }

  /** Capture the pre-run state. Explicitly awaited, so failures are reported. */
  async baseline(): Promise<string | undefined> {
    try {
      return await this.capture("baseline", true);
    } catch (error) {
      this.recordError("screenshot:baseline", error);
      return undefined;
    }
  }

  /** Start bounded periodic screenshots. Call after the first testStart event. */
  startPeriodic(): void {
    if (this.timer || this.intervalMs <= 0 || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.pending >= 2) return;
      void this.capture("periodic", false);
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Associate an event screenshot with a reporter test ID. */
  captureForTest(testId: number, kind: "error" | "failure" | "timeout"): Promise<string | undefined> {
    return this.capture(`test-${testId}-${kind}`, true).then((path) => {
      if (!path) return undefined;
      const list = this.testScreenshots.get(testId) ?? [];
      list.push(path);
      this.testScreenshots.set(testId, list);
      return path;
    });
  }

  private capture(kind: string, priority: boolean): Promise<string | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    if (this.screenshotCount >= this.maxScreenshots) {
      this.reportLimit("max screenshot count reached");
      return Promise.resolve(undefined);
    }
    if (!priority && this.pending >= 2) return Promise.resolve(undefined);

    this.pending += 1;
    const job = this.queue.then(async () => {
      try {
        return await this.doCapture(kind);
      } catch (error) {
        // Periodic screenshots are best-effort; only explicit captures surface
        // in artifactErrors.
        if (priority) this.recordError(`screenshot:${kind}`, error);
        return undefined;
      } finally {
        this.pending -= 1;
      }
    });
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async doCapture(kind: string): Promise<string | undefined> {
    if (this.stopped || this.screenshotCount >= this.maxScreenshots) return undefined;
    if (this.capturedBytes >= this.maxScreenshotBytes) {
      this.reportLimit("max screenshot bytes reached");
      return undefined;
    }

    this.screenshotCount += 1;
    const name = `${kind}-${String(this.screenshotCount).padStart(4, "0")}.png`;
    const path = join(this.screenshotsDir, name);
    try {
      await this.audb.screenshot(this.deviceId, path);
      const info = await stat(path);
      if (info.size > this.maxScreenshotFileBytes) {
        await unlink(path).catch(() => undefined);
        this.recordError(
          `screenshot:${name}`,
          new Error(`Screenshot exceeds ${this.maxScreenshotFileBytes} bytes.`),
        );
        return undefined;
      }
      if (this.capturedBytes + info.size > this.maxScreenshotBytes) {
        await unlink(path).catch(() => undefined);
        this.reportLimit("max screenshot bytes reached");
        return undefined;
      }
      this.capturedBytes += info.size;
      return path;
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  private reportLimit(message: string): void {
    if (this.limitReported) return;
    this.limitReported = true;
    this.errors.push({ artifact: "screenshot:limit", message });
    this.stopPeriodic();
  }

  async collectJournal(since: string): Promise<string | undefined> {
    try {
      const output = await this.audb.logsSince(this.deviceId, since);
      return await this.write("logs/journal.txt", redactSecrets(output));
    } catch (error) {
      this.recordError("logs:journal", error);
      return undefined;
    }
  }

  async collectCrashEvents(packageId: string | undefined, since: string): Promise<string | undefined> {
    try {
      const events = await this.audb.crashList(this.deviceId, packageId, since);
      return await this.write("crash/events.json", JSON.stringify(events, null, 2) + "\n");
    } catch (error) {
      this.recordError("crash:events", error);
      return undefined;
    }
  }

  /** Wait for scheduled captures (event screenshots) before finalizing results. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Stop timers and wait for scheduled captures. */
  async dispose(): Promise<void> {
    this.stopped = true;
    this.stopPeriodic();
    await this.queue;
  }
}
