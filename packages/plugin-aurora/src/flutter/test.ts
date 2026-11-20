/**
 * FlutterTestController — the Flutter/QEMU orchestration state machine.
 *
 * One active run per audb device. The controller owns locks, the child process
 * tree, collectors and report finalization; `dispose()` cancels everything.
 * `flutter-aurora` performs build/install/test; audb is used only with an
 * explicit `--device` for screenshots, logs and crash events.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { AudbCli } from "./audb.js";
import { ArtifactCollector } from "./artifacts.js";
import { DeviceResolver } from "./devices.js";
import { FlutterError } from "./errors.js";
import { FlutterCli } from "./flutter-cli.js";
import type { CommandResult } from "./flutter-cli.js";
import { redactSecrets } from "./redact.js";
import {
  JsonReporter,
  renderJUnit,
  renderSummaryText,
  testStatusOf,
} from "./reporter.js";
import type { ReporterFinalizeResult } from "./reporter.js";
import type {
  CleanupStatus,
  DevicesReport,
  DoctorCheck,
  DoctorReport,
  FlutterTestResult,
  FlutterTestRunInput,
  FlutterVersion,
  GrantPermissionsOptions,
  PermissionState,
  ProjectInfo,
  ReporterSummary,
  RunStatus,
  TestStatus,
  ValidatedTestRunInput,
} from "./types.js";

const MAX_RUN_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MIN_RUN_TIMEOUT_MS = 10_000;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

interface ActiveRun {
  controller: AbortController;
  runId: string;
  startedAt: string;
}

export interface FlutterTestControllerOptions {
  flutter?: FlutterCli;
  audb?: AudbCli;
  now?: () => Date;
  runIdFactory?: () => string;
}

export interface RunOptions {
  signal?: AbortSignal;
  flutterPath?: string;
}

export interface DoctorOptions {
  projectPath?: string;
  deviceId?: string;
  flutterPath?: string;
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isAuroraVersion(version: FlutterVersion): boolean {
  const channel = String(version.channel ?? "").toLowerCase();
  const root = String(version.flutterRoot ?? "").toLowerCase();
  return channel.includes("aurora") || root.includes("flutter_aurora");
}

function parseTopLevelField(pubspec: string, field: string): string | undefined {
  const match = pubspec.match(new RegExp(`^${field}\\s*:\\s*["']?([^"'\\n#]+)["']?\\s*$`, "m"));
  return match?.[1]?.trim();
}

function hasDevDependency(pubspec: string, dependency: string): boolean {
  const lines = pubspec.split(/\r?\n/);
  let inDevDependencies = false;
  const dependencyRe = new RegExp(`^\\s{2,}${dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  for (const line of lines) {
    if (/^dev_dependencies\s*:/.test(line)) {
      inDevDependencies = true;
      continue;
    }
    if (!inDevDependencies) continue;
    if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
    if (dependencyRe.test(line)) return true;
  }
  return false;
}

export function detectPackageId(projectPath: string, pubspec?: string): string | undefined {
  const desktopDir = join(projectPath, "aurora", "desktop");
  if (pathExists(desktopDir)) {
    for (const entry of readdirSync(desktopDir)) {
      if (!entry.endsWith(".desktop")) continue;
      try {
        const text = readFileSync(join(desktopDir, entry), "utf8");
        const match = text.match(/^Exec\s*=\s*\/usr\/bin\/([A-Za-z0-9_.+-]+)\s*$/m);
        if (match?.[1]) return match[1];
      } catch {
        // ignore unreadable desktop files
      }
    }
  }

  const rpmDir = join(projectPath, "aurora", "rpm");
  if (pathExists(rpmDir)) {
    for (const entry of readdirSync(rpmDir)) {
      if (!entry.endsWith(".spec")) continue;
      try {
        const text = readFileSync(join(rpmDir, entry), "utf8");
        const match = text.match(/^Name\s*:\s*(\S+)\s*$/m);
        const name = match?.[1];
        if (name && !name.includes("%{") && PACKAGE_ID_RE.test(name)) return name;
      } catch {
        // ignore unreadable specs
      }
    }
  }

  const text = pubspec ?? (pathExists(join(projectPath, "pubspec.yaml"))
    ? readFileSync(join(projectPath, "pubspec.yaml"), "utf8")
    : "");
  const name = parseTopLevelField(text, "name");
  const organization = parseTopLevelField(text, "organization");
  if (!name) return undefined;
  const packageId = organization ? `${organization}.${name}` : name;
  return PACKAGE_ID_RE.test(packageId) ? packageId : undefined;
}

function parseDeclaredPermissions(projectPath: string): string[] {
  const desktopDir = join(projectPath, "aurora", "desktop");
  if (!pathExists(desktopDir)) return [];
  const permissions = new Set<string>();
  for (const entry of readdirSync(desktopDir)) {
    if (!entry.endsWith(".desktop")) continue;
    try {
      const text = readFileSync(join(desktopDir, entry), "utf8");
      let section = "";
      for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) {
          section = header[1]!.trim();
          continue;
        }
        if (section !== "X-Application") continue;
        const value = line.match(/^\s*Permissions\s*=\s*(.*)$/);
        if (!value) continue;
        for (const permission of value[1]!.split(";")) {
          const trimmed = permission.trim();
          if (trimmed) permissions.add(trimmed);
        }
      }
    } catch {
      // ignore unreadable desktop files
    }
  }
  return [...permissions].sort();
}

export function inspectProject(projectPath: string): ProjectInfo {
  const pubspecPath = join(projectPath, "pubspec.yaml");
  if (!pathExists(pubspecPath)) {
    throw new FlutterError(
      `pubspec.yaml not found in ${projectPath}.`,
      "PROJECT_NOT_FOUND",
    );
  }
  const pubspec = readFileSync(pubspecPath, "utf8");
  const rpmDir = join(projectPath, "aurora", "rpm");
  const specFiles = pathExists(rpmDir)
    ? readdirSync(rpmDir).filter((entry) => entry.endsWith(".spec")).map((entry) => join(rpmDir, entry))
    : [];
  return {
    projectPath,
    pubspecPath,
    hasFlutterTest: hasDevDependency(pubspec, "flutter_test"),
    hasIntegrationTest: hasDevDependency(pubspec, "integration_test"),
    packageId: detectPackageId(projectPath, pubspec),
    specFiles,
    declaredPermissions: parseDeclaredPermissions(projectPath),
  };
}

export function validateTestRunInput(input: FlutterTestRunInput): ValidatedTestRunInput {
  if (!Number.isSafeInteger(input.runTimeoutMs) || input.runTimeoutMs < MIN_RUN_TIMEOUT_MS) {
    throw new FlutterError(
      `runTimeoutMs must be an integer >= ${MIN_RUN_TIMEOUT_MS}.`,
      "INVALID_ARGUMENT",
    );
  }
  if (input.runTimeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new FlutterError(
      `runTimeoutMs must be <= ${MAX_RUN_TIMEOUT_MS}.`,
      "INVALID_ARGUMENT",
    );
  }

  const projectPath = realpathSync(resolve(input.projectPath));
  if (!statSync(projectPath).isDirectory()) {
    throw new FlutterError(`${projectPath} is not a directory.`, "INVALID_PROJECT_PATH");
  }

  const testPath = realpathSync(resolve(projectPath, input.testPath));
  if (!isInside(testPath, projectPath)) {
    throw new FlutterError(
      "testPath must be inside the project directory.",
      "INVALID_TEST_PATH",
    );
  }
  const integrationDir = join(projectPath, "integration_test");
  if (!pathExists(integrationDir) || !isInside(testPath, realpathSync(integrationDir))) {
    throw new FlutterError(
      "testPath must be inside the project's integration_test directory.",
      "INVALID_TEST_PATH",
    );
  }
  if (!testPath.endsWith(".dart")) {
    throw new FlutterError("testPath must be a .dart file.", "INVALID_TEST_PATH");
  }

  const artifactsBaseDir = input.artifactsDir
    ? resolve(projectPath, input.artifactsDir)
    : join(projectPath, ".audb");

  return {
    ...input,
    projectPath,
    testPath,
    artifactsBaseDir,
  };
}

function makeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * journalctl accepts `@<unix-seconds>` independently of the host/device
 * timezone; `audb logs --since` and `audb crash list --since` pass it through.
 * ISO-8601 with `T`/`Z` is rejected by the device's journalctl.
 */
export function formatJournalSince(date: Date): string {
  return `@${Math.floor(date.getTime() / 1000)}`;
}

/**
 * `flutter test` emits a synthetic `loading <file>` test before the app is
 * built. Periodic screenshots must start at the first real test event, not
 * during the whole build.
 */
export function isRealTestStart(event: Record<string, unknown>): boolean {
  if (event.type !== "testStart") return false;
  const test = event.test;
  if (!test || typeof test !== "object") return false;
  const name = (test as Record<string, unknown>).name;
  return typeof name === "string" && !name.startsWith("loading ");
}

export class FlutterTestController {
  private readonly audb: AudbCli;
  private readonly defaultFlutter: FlutterCli;
  private readonly now: () => Date;
  private readonly runIdFactory: () => string;
  private readonly active = new Map<string, ActiveRun>();
  private disposed = false;

  constructor(options: FlutterTestControllerOptions = {}) {
    this.audb = options.audb ?? new AudbCli();
    this.defaultFlutter = options.flutter ?? new FlutterCli();
    this.now = options.now ?? (() => new Date());
    this.runIdFactory = options.runIdFactory ?? (() => randomBytes(4).toString("hex"));
  }

  private flutterFor(flutterPath?: string): FlutterCli {
    return flutterPath ? new FlutterCli({ binary: flutterPath }) : this.defaultFlutter;
  }

  private acquire(deviceId: string, runId: string): AbortController {
    if (this.disposed) {
      throw new FlutterError("Flutter controller is disposed.", "CONTROLLER_DISPOSED");
    }
    const existing = this.active.get(deviceId);
    if (existing) {
      throw new FlutterError(
        `A Flutter test run is already in progress on device '${deviceId}' (run ${existing.runId} since ${existing.startedAt}).`,
        "RUN_IN_PROGRESS",
      );
    }
    const controller = new AbortController();
    this.active.set(deviceId, {
      controller,
      runId,
      startedAt: this.now().toISOString(),
    });
    return controller;
  }

  private release(deviceId: string): void {
    this.active.delete(deviceId);
  }

  private nextRunId(date: Date): string {
    return `${makeTimestamp(date)}-${this.runIdFactory()}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  }

  private async createRunDirectory(baseDir: string, runId: string): Promise<string> {
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    await chmod(baseDir, 0o700);
    const runsDir = join(baseDir, "runs");
    await mkdir(runsDir, { recursive: true, mode: 0o700 });
    await chmod(runsDir, 0o700);
    const runDir = join(runsDir, runId);
    try {
      await mkdir(runDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FlutterError(
          `Run directory already exists: ${runDir}`,
          "RUN_DIRECTORY_CONFLICT",
        );
      }
      throw error;
    }
    await chmod(runDir, 0o700);
    return runDir;
  }

  private linkAbort(internal: AbortController, external?: AbortSignal): () => void {
    if (!external) return () => undefined;
    const abort = (): void => internal.abort();
    if (external.aborted) abort();
    else external.addEventListener("abort", abort, { once: true });
    return () => external.removeEventListener("abort", abort);
  }

  /** Run one integration test on one audb device. */
  async run(input: FlutterTestRunInput, options: RunOptions = {}): Promise<FlutterTestResult> {
    const validated = validateTestRunInput(input);
    const startedDate = this.now();
    const startedMs = Date.now();
    const runId = this.nextRunId(startedDate);
    const internal = this.acquire(validated.deviceId, runId);
    const unlinkAbort = this.linkAbort(internal, options.signal);

    let collector: ArtifactCollector | undefined;
    try {
      const runDir = await this.createRunDirectory(validated.artifactsBaseDir, runId);
      collector = new ArtifactCollector({
        dir: runDir,
        audb: this.audb,
        deviceId: validated.deviceId,
        screenshotIntervalMs: validated.screenshotIntervalMs,
      });
      await collector.init();
      return await this.executeRun({
        validated,
        runId,
        runDir,
        startedDate,
        startedMs,
        collector,
        signal: internal.signal,
        flutter: this.flutterFor(options.flutterPath),
      });
    } finally {
      collector?.stopPeriodic();
      await collector?.dispose().catch(() => undefined);
      this.release(validated.deviceId);
      unlinkAbort();
    }
  }

  private async executeRun(args: {
    validated: ValidatedTestRunInput;
    runId: string;
    runDir: string;
    startedDate: Date;
    startedMs: number;
    collector: ArtifactCollector;
    signal: AbortSignal;
    flutter: FlutterCli;
  }): Promise<FlutterTestResult> {
    const { validated, runId, runDir, startedDate, startedMs, collector, signal, flutter } = args;
    const resolver = new DeviceResolver(flutter, this.audb);

    let flutterDeviceId = "";
    let packageId: string | undefined;
    let declaredPermissions: string[] = [];
    let version: FlutterVersion | undefined;
    let audbVersion: string | undefined;
    let command: CommandResult | undefined;
    let reporter: JsonReporter | undefined;
    let finalized: ReporterFinalizeResult | undefined;
    let earlyError: FlutterError | undefined;
    let cleanup: CleanupStatus | undefined;
    let journalPath: string | undefined;
    let crashPath: string | undefined;

    try {
      const mapping = await resolver.resolve(validated.deviceId);
      flutterDeviceId = mapping.flutterDeviceId;

      const project = inspectProject(validated.projectPath);
      if (!project.hasFlutterTest) {
        throw new FlutterError(
          "flutter_test is missing from dev_dependencies.",
          "PROJECT_NOT_READY",
        );
      }
      if (!project.hasIntegrationTest) {
        throw new FlutterError(
          "integration_test is missing from dev_dependencies.",
          "PROJECT_NOT_READY",
        );
      }
      packageId = project.packageId;
      declaredPermissions = project.declaredPermissions;

      if (declaredPermissions.length > 0 && validated.permissionPolicy !== "allow_prompt") {
        throw new FlutterError(
          `Project declares Sailjail permissions (${declaredPermissions.join(", ")}). `
            + "flutter_test reinstall resets grants, so an unattended run would block on the system permission dialog. "
            + "Use flutter_permissions to inspect/grant after install, or set permissionPolicy=\"allow_prompt\" "
            + "to run with an externally answered dialog.",
          "PERMISSIONS_REQUIRE_GRANT",
        );
      }

      version = await flutter.version();
      audbVersion = await this.audb.version().catch(() => undefined);

      await collector.baseline();

      let packagesBefore: string[] | undefined;
      try {
        packagesBefore = await this.audb.packageList(validated.deviceId);
      } catch (error) {
        collector.errors.push({
          artifact: "cleanup:before",
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }

      const testsJsonPath = join(collector.flutterDir, "tests.json");
      let seenTestStart = false;
      reporter = new JsonReporter({
        onEvent: (event) => {
          if (!seenTestStart && isRealTestStart(event)) {
            seenTestStart = true;
            collector.startPeriodic();
          }
          if (event.type === "error" && typeof event.testID === "number") {
            void collector.captureForTest(event.testID, "error");
          }
          if (
            event.type === "testDone"
            && event.result !== "success"
            && event.skipped !== true
            && typeof event.testID === "number"
          ) {
            void collector.captureForTest(event.testID, "failure");
          }
        },
      });

      command = await flutter.testProcess({
        projectPath: validated.projectPath,
        testPath: validated.testPath,
        flutterDeviceId,
        fileReporterPath: testsJsonPath,
        timeoutMs: validated.runTimeoutMs,
        testTimeout: validated.testTimeout,
        signal,
        onStdoutLine: (line) => reporter?.feedLine(line),
      });

      // The file reporter is a fallback when stdout carried no JSON events.
      if (reporter.eventCount === 0 && pathExists(testsJsonPath)) {
        try {
          reporter.feed(await readFile(testsJsonPath, "utf8"));
        } catch {
          // handled as a reporter problem below
        }
      }
      finalized = reporter.finalize(command.exitCode);

      if (command.stdout.length > 0 || command.stderr.length > 0) {
        try {
          await collector.write("logs/flutter-stdout-redacted.txt", redactSecrets(command.stdout));
          await collector.write("logs/flutter-stderr-redacted.txt", redactSecrets(command.stderr));
        } catch (error) {
          collector.errors.push({
            artifact: "logs:flutter",
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
          });
        }
      }

      const since = formatJournalSince(startedDate);
      journalPath = await collector.collectJournal(since);
      crashPath = await collector.collectCrashEvents(packageId, since);

      try {
        const packagesAfter = await this.audb.packageList(validated.deviceId);
        cleanup = {
          packageId,
          checked: true,
          packagePresentBeforeRun: packagesBefore?.includes(packageId ?? "") ?? undefined,
          packagePresentAfterRun: packageId ? packagesAfter.includes(packageId) : undefined,
        };
      } catch (error) {
        cleanup = { packageId, checked: false };
        collector.errors.push({
          artifact: "cleanup:after",
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
    } catch (error) {
      earlyError =
        error instanceof FlutterError
          ? error
          : new FlutterError(
              redactSecrets(error instanceof Error ? error.message : String(error)),
              "INTERNAL_ERROR",
            );
    }

    if (command?.timedOut && reporter) {
      void collector.captureForTest(-1, "timeout").catch(() => undefined);
    }
    collector.stopPeriodic();
    // Event screenshots are fire-and-forget; wait for them so result.json can
    // link the captured paths to the failing test.
    await collector.flush().catch(() => undefined);

    const testsJsonPath = join(runDir, "flutter", "tests.json");
    const junitPath = join(runDir, "junit.xml");
    const summaryPath = join(runDir, "summary.txt");
    const resultPath = join(runDir, "result.json");

    const summary: ReporterSummary = finalized?.summary ?? {
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      total: 0,
    };
    const tests = (finalized?.tests ?? []).map((test) => ({
      id: test.id,
      name: test.name,
      suiteID: test.suiteID,
      groupIDs: test.groupIDs,
      url: test.url,
      line: test.line,
      status: testStatusOf(test),
      durationMs:
        test.finishedAtMs !== undefined && test.startedAtMs !== undefined
          ? Math.max(0, test.finishedAtMs - test.startedAtMs)
          : undefined,
      retried: test.retried,
      flaky: test.flaky,
      hidden: test.hidden,
      errors: test.errors,
      screenshots: collector.testScreenshots.get(test.id) ?? [],
    }));

    let runStatus: RunStatus = "completed";
    let error = earlyError
      ? { code: earlyError.code, message: redactSecrets(earlyError.message) }
      : undefined;

    if (command?.timedOut) {
      runStatus = "timeout";
      error = {
        code: "RUN_TIMEOUT",
        message: `Flutter test exceeded runTimeoutMs=${validated.runTimeoutMs}.`,
      };
    } else if (command?.aborted) {
      runStatus = "cancelled";
      error = { code: "RUN_CANCELLED", message: "Flutter test was cancelled." };
    } else if (command?.spawnError) {
      runStatus = "tool_error";
      error = { code: "FLUTTER_COMMAND_FAILED", message: redactSecrets(command.spawnError) };
    } else if (earlyError) {
      runStatus = earlyError.code === "FLUTTER_NOT_FOUND"
        || earlyError.code === "AUDB_NOT_FOUND"
        || earlyError.code === "PERMISSIONS_REQUIRE_GRANT"
        ? "tool_error"
        : "internal_error";
    } else if (!finalized || !finalized.complete) {
      runStatus = "internal_error";
      error = {
        code: "REPORTER_INCOMPLETE",
        message:
          finalized?.warnings.join(" ")
          || "Flutter JSON reporter did not complete consistently.",
      };
    }

    const exitCode = command?.exitCode ?? null;
    let testStatus: TestStatus;
    if (!finalized) {
      testStatus = "not_run";
    } else if (summary.failed > 0) {
      testStatus = "failed";
    } else if (runStatus === "timeout" || runStatus === "cancelled") {
      testStatus = "unknown";
    } else if (summary.total === 0) {
      testStatus = runStatus === "completed" && finalized.done?.success === true
        ? "unknown"
        : "not_run";
    } else if (
      runStatus === "completed"
      && finalized.complete
      && finalized.done?.success === true
      && exitCode === 0
    ) {
      testStatus = "passed";
    } else {
      testStatus = "unknown";
    }

    const reporterWarnings = [...(finalized?.warnings ?? [])];
    if (finalized && finalized.malformedLines.length > 0) {
      reporterWarnings.push(
        `Reporter output contained ${finalized.malformedLines.length} malformed JSON line(s).`,
      );
    }
    if (command?.stdoutTruncated || command?.stderrTruncated) {
      reporterWarnings.push("Flutter output was truncated by the size limit.");
    }

    const artifacts = {
      dir: runDir,
      resultJson: resultPath,
      junit: junitPath,
      summary: summaryPath,
      testsJson: pathExists(testsJsonPath) ? testsJsonPath : undefined,
      journal: journalPath,
      crashEvents: crashPath,
      screenshots: collector.screenshotCount,
    };

    if (pathExists(testsJsonPath) === false) {
      collector.errors.push({
        artifact: "flutter:testsJson",
        message: "File reporter did not produce flutter/tests.json.",
      });
    }

    const infrastructureError =
      summary.total === 0 && testStatus !== "passed"
        ? error?.message
          ?? (runStatus === "timeout"
            ? "Flutter test timed out before reporting tests."
            : "Flutter test did not report any tests.")
        : undefined;

    let reportsWritten = true;
    try {
      await collector.write(
        "junit.xml",
        renderJUnit(finalized?.tests ?? [], {
          suiteName: packageId ?? "flutter-aurora",
          infrastructureError,
        }),
      );
    } catch (writeError) {
      reportsWritten = false;
      collector.errors.push({
        artifact: "report:junit",
        message: redactSecrets(writeError instanceof Error ? writeError.message : String(writeError)),
      });
    }

    let artifactsComplete = collector.errors.length === 0;
    const ok =
      runStatus === "completed"
      && testStatus === "passed"
      && exitCode === 0
      && finalized?.done?.success === true
      && finalized.complete
      && reportsWritten;

    const preliminary: FlutterTestResult = {
      schemaVersion: 1,
      ok,
      runStatus,
      testStatus,
      reporterComplete: finalized?.complete ?? false,
      artifactsComplete,
      runId,
      deviceId: validated.deviceId,
      flutterDeviceId,
      projectPath: validated.projectPath,
      testPath: validated.testPath,
      startedAt: startedDate.toISOString(),
      finishedAt: this.now().toISOString(),
      exitCode,
      durationMs: Date.now() - startedMs,
      summary,
      tests,
      artifactErrors: collector.errors,
      artifacts,
      cleanup,
      declaredPermissions,
      permissionPolicy: validated.permissionPolicy ?? "fail",
      reporterWarnings,
      versions: { flutter: version, audb: audbVersion },
      error,
    };

    try {
      await collector.write("summary.txt", renderSummaryText(preliminary));
    } catch (writeError) {
      reportsWritten = false;
      collector.errors.push({
        artifact: "report:summary",
        message: redactSecrets(writeError instanceof Error ? writeError.message : String(writeError)),
      });
    }

    artifactsComplete = collector.errors.length === 0;
    preliminary.artifactsComplete = artifactsComplete;
    preliminary.ok = ok && reportsWritten;

    try {
      await collector.write("result.json", JSON.stringify(preliminary, null, 2) + "\n");
    } catch (writeError) {
      reportsWritten = false;
      collector.errors.push({
        artifact: "report:resultJson",
        message: redactSecrets(writeError instanceof Error ? writeError.message : String(writeError)),
      });
      preliminary.ok = false;
      preliminary.artifactsComplete = false;
    }

    return preliminary;
  }

  /**
   * Doctor for the Flutter/QEMU environment. Never prints devices.toml or
   * `root_password`; VM Service URIs in doctor output are redacted.
   */
  async doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const warnings: string[] = [];
    const report: DoctorReport = { ok: false, checks, warnings };
    const flutter = this.flutterFor(options.flutterPath);

    try {
      const binary = flutter.binary();
      const realPath = flutter.realPath();
      report.flutter = { binary, realPath };
      checks.push({ name: "flutter.binary", status: "passed", data: { binary, realPath } });
      const version = await flutter.version();
      report.flutter.version = version;
      const aurora = isAuroraVersion(version);
      report.flutter.isAuroraBuild = aurora;
      checks.push({
        name: "flutter.version",
        status: "passed",
        data: {
          frameworkVersion: version.frameworkVersion,
          channel: version.channel,
          flutterRoot: version.flutterRoot,
          isAuroraBuild: aurora,
        },
      });
      if (!aurora) {
        warnings.push(
          "The resolved Flutter binary does not look like an Aurora build. Set FLUTTER_AURORA_BIN to flutter-aurora.",
        );
      }
    } catch (error) {
      checks.push({
        name: "flutter.binary",
        status: "failed",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }

    try {
      const doctorResult = await flutter.doctor();
      checks.push({
        name: "flutter.doctor",
        status: doctorResult.exitCode === 0 ? "passed" : "warning",
        message: doctorResult.exitCode === 0
          ? undefined
          : `flutter doctor exited with ${String(doctorResult.exitCode)}.`,
        data: redactSecrets(doctorResult.stdout),
      });
    } catch (error) {
      checks.push({
        name: "flutter.doctor",
        status: "warning",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }

    try {
      const devices = await new DeviceResolver(flutter, this.audb).list(
        options.deviceId ? { deviceId: options.deviceId } : {},
      );
      report.devices = devices;
      checks.push({
        name: "devices",
        status: devices.ok ? "passed" : "failed",
        data: {
          mappings: devices.mappings,
          unmatched: devices.unmatched,
          warnings: devices.warnings,
        },
      });
      if (options.deviceId && devices.mappings[0]) report.mapping = devices.mappings[0];
      warnings.push(...devices.warnings);
    } catch (error) {
      checks.push({
        name: "devices",
        status: "failed",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }

    try {
      const version = await this.audb.version();
      report.audb = { binary: this.audb.binary, version };
      checks.push({ name: "audb.version", status: "passed", data: { version } });
    } catch (error) {
      checks.push({
        name: "audb.version",
        status: "failed",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }

    if (options.deviceId) {
      try {
        const doctor = await this.audb.doctor(options.deviceId);
        report.audb = { ...(report.audb ?? { binary: this.audb.binary }), doctor };
        checks.push({ name: "audb.doctor", status: "passed", data: doctor });
      } catch (error) {
        checks.push({
          name: "audb.doctor",
          status: "warning",
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
      try {
        const capabilities = await this.audb.capabilities(options.deviceId);
        report.audb = { ...(report.audb ?? { binary: this.audb.binary }), capabilities };
        checks.push({ name: "audb.capabilities", status: "passed", data: capabilities });
      } catch (error) {
        checks.push({
          name: "audb.capabilities",
          status: "warning",
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    if (options.projectPath) {
      try {
        const projectPath = realpathSync(resolve(options.projectPath));
        const project = inspectProject(projectPath);
        report.project = project;
        checks.push({
          name: "project",
          status:
            project.hasFlutterTest && project.hasIntegrationTest && project.specFiles.length > 0
              ? "passed"
              : "failed",
          data: project,
        });
        if (!project.hasFlutterTest) warnings.push("flutter_test is missing from dev_dependencies.");
        if (!project.hasIntegrationTest) warnings.push("integration_test is missing from dev_dependencies.");
        if (project.specFiles.length === 0) warnings.push("aurora/rpm/*.spec was not found.");
        if (!project.packageId) warnings.push("Package ID could not be derived from the project.");
        if (project.declaredPermissions.length > 0) {
          warnings.push(
            `Project declares Sailjail permissions (${project.declaredPermissions.join(", ")}). flutter_test defaults to PERMISSIONS_REQUIRE_GRANT because reinstall resets grants; use flutter_permissions after install or permissionPolicy="allow_prompt".`,
          );
        }
      } catch (error) {
        checks.push({
          name: "project",
          status: "failed",
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    report.ok = checks.every((check) => check.status !== "failed");
    return report;
  }

  async devices(options: { deviceId?: string; flutterPath?: string } = {}): Promise<DevicesReport> {
    const resolver = new DeviceResolver(this.flutterFor(options.flutterPath), this.audb);
    return resolver.list(options.deviceId ? { deviceId: options.deviceId } : {});
  }

  /** Read Sailjail permission state for an installed application. */
  async permissionState(
    deviceId: string,
    applicationId: string,
  ): Promise<PermissionState> {
    return this.audb.permissionList(deviceId, applicationId);
  }

  /** Grant declared Sailjail permissions and return before/after state. */
  async grantPermissions(
    deviceId: string,
    applicationId: string,
    options: GrantPermissionsOptions,
  ): Promise<{ before: PermissionState; after: PermissionState }> {
    const before = await this.audb.permissionList(deviceId, applicationId);
    await this.audb.permissionGrant(deviceId, applicationId, options);
    const after = await this.audb.permissionList(deviceId, applicationId);
    return { before, after };
  }

  /** Clear saved grants and re-enable the system dialog. */
  async resetPermissions(
    deviceId: string,
    applicationId: string,
  ): Promise<{ before: PermissionState; after: PermissionState }> {
    const before = await this.audb.permissionList(deviceId, applicationId);
    await this.audb.permissionReset(deviceId, applicationId);
    const after = await this.audb.permissionList(deviceId, applicationId);
    return { before, after };
  }

  /** Remove selected saved grants without changing the dialog policy. */
  async revokePermissions(
    deviceId: string,
    applicationId: string,
    permissions: string[],
  ): Promise<{ before: PermissionState; after: PermissionState }> {
    const before = await this.audb.permissionList(deviceId, applicationId);
    await this.audb.permissionRevoke(deviceId, applicationId, permissions);
    const after = await this.audb.permissionList(deviceId, applicationId);
    return { before, after };
  }

  /** Enable (clears grants) or disable (preserves grants) the system dialog. */
  async setPermissionPrompt(
    deviceId: string,
    applicationId: string,
    enabled: boolean,
  ): Promise<{ before: PermissionState; after: PermissionState }> {
    const before = await this.audb.permissionList(deviceId, applicationId);
    await this.audb.permissionPrompt(deviceId, applicationId, enabled);
    const after = await this.audb.permissionList(deviceId, applicationId);
    return { before, after };
  }

  /** Cancel all active runs and release resources. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.active.values()) {
      run.controller.abort();
    }
    const deadline = Date.now() + 5_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
}

/** Path helpers exported for tests. */
export const __testing = {
  hasDevDependency,
  isAuroraVersion,
  isInside,
  basename,
  dirname,
};
