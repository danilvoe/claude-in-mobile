import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AudbCli } from "./audb.js";
import { FlutterCli } from "./flutter-cli.js";
import type { CommandExecutor, CommandResult, RunCommandOptions } from "./flutter-cli.js";
import { FlutterTestController, formatJournalSince, isRealTestStart } from "./test.js";
import { commandResult, makeExecutor } from "./test-fixtures.js";

const FLUTTER_DEVICES = [
  {
    name: "Emulator Aurora OS 5.2.0.180 (x64)",
    id: "AuroraOS-5.2.0.180",
    targetPlatform: "aurora-x64",
    emulator: true,
    isSupported: true,
  },
];

const AUDB_DEVICES = [
  {
    id: "emulator",
    name: "Aurora Emulator",
    kind: "emulator",
    host: "127.0.0.1",
    emulator: { emulatorName: "AuroraOS-5.2.0.180" },
  },
];

const PASS_EVENTS = [
  {
    type: "testStart",
    test: {
      id: 1,
      name: "smoke test",
      suiteID: 0,
      groupIDs: [1],
      metadata: { skip: false, skipReason: null },
      line: 1,
      column: 1,
      url: "package:fixture/integration_test/smoke_test.dart",
    },
    time: 1,
  },
  {
    type: "testDone",
    testID: 1,
    result: "success",
    skipped: false,
    hidden: false,
    retried: false,
    time: 5,
  },
  { type: "done", success: true, time: 6 },
];

interface HarnessOptions {
  events?: unknown[];
  testResult?: Partial<CommandResult>;
  testHandler?: (
    options: RunCommandOptions,
    writeEvents: (events: unknown[]) => void,
  ) => Promise<Partial<CommandResult>>;
  screenshotFails?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const project = mkdtempSync(join(tmpdir(), "audb-flutter-controller-"));
  chmodSync(project, 0o700);
  mkdirSync(join(project, "integration_test"), { recursive: true });
  mkdirSync(join(project, "aurora", "rpm"), { recursive: true });
  mkdirSync(join(project, "aurora", "desktop"), { recursive: true });
  writeFileSync(
    join(project, "pubspec.yaml"),
    [
      "name: fixture",
      'organization: "ru.audb.fixture"',
      "environment:",
      "  sdk: ^3.9.2",
      "dev_dependencies:",
      "  flutter_test:",
      "    sdk: flutter",
      "  integration_test:",
      "    sdk: flutter",
      "",
    ].join("\n"),
  );
  writeFileSync(join(project, "integration_test", "smoke_test.dart"), "void main() {}\n");
  writeFileSync(
    join(project, "aurora", "desktop", "ru.audb.fixture.fixture.desktop"),
    "[Desktop Entry]\nExec=/usr/bin/ru.audb.fixture.fixture\n",
  );

  let packageInstalled = true;

  const flutterExecutor: CommandExecutor = async (command, args, runOptions) => {
    if (args.includes("devices") && args.includes("--machine")) {
      return commandResult({ stdout: JSON.stringify(FLUTTER_DEVICES) });
    }
    if (args.includes("--version") && args.includes("--machine")) {
      return commandResult({
        stdout: JSON.stringify({
          frameworkVersion: "3.35.7",
          channel: "flutter-aurora-3.35.7",
          flutterRoot: "/opt/flutter_aurora",
        }),
      });
    }
    if (args.includes("doctor")) {
      return commandResult({ stdout: "doctor ok" });
    }
    if (args[0] === "test") {
      const fileReporter = args.find((arg) => arg.startsWith("--file-reporter=json:"));
      let capturedStdout = "";
      const writeEvents = (events: unknown[]): string => {
        const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        capturedStdout = text;
        if (fileReporter) {
          const path = fileReporter.slice("--file-reporter=json:".length);
          writeFileSync(path, text);
        }
        for (const line of events) runOptions?.onStdoutLine?.(JSON.stringify(line));
        return text;
      };
      if (options.testHandler) {
        const partial = await options.testHandler(runOptions ?? {}, writeEvents);
        return commandResult({ stdout: capturedStdout, ...partial });
      }
      writeEvents(options.events ?? PASS_EVENTS);
      // Mirror IntegrationTestTestDevice.kill: the test package is removed.
      packageInstalled = false;
      return commandResult({ stdout: capturedStdout, ...(options.testResult ?? { exitCode: 0 }) });
    }
    return commandResult();
  };

  const audbExecutor: CommandExecutor = async (command, args) => {
    const json = args.includes("--json");
    if (args.includes("device") && args.includes("list")) {
      return commandResult({ stdout: JSON.stringify({ ok: true, data: AUDB_DEVICES }) });
    }
    if (args.includes("package") && args.includes("list")) {
      return commandResult({
        stdout: JSON.stringify({
          ok: true,
          data: { packages: packageInstalled ? ["ru.audb.fixture.fixture"] : [] },
        }),
      });
    }
    if (args.includes("screenshot")) {
      if (options.screenshotFails) {
        return commandResult({
          exitCode: 1,
          stdout: JSON.stringify({ ok: false, error: { message: "QMP failed" } }),
        });
      }
      const index = args.indexOf("--output");
      const path = args[index + 1];
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return commandResult({ stdout: JSON.stringify({ ok: true, data: { bytes: 4 } }) });
    }
    if (args.includes("logs")) {
      return commandResult({ stdout: JSON.stringify({ ok: true, data: { output: "journal" } }) });
    }
    if (args.includes("crash")) {
      return commandResult({ stdout: JSON.stringify({ ok: true, data: { events: [] } }) });
    }
    if (args.includes("--version")) {
      return commandResult({ stdout: "audb 0.4.2\n" });
    }
    if (!json) return commandResult();
    return commandResult({ stdout: JSON.stringify({ ok: true, data: {} }) });
  };

  const controller = new FlutterTestController({
    flutter: new FlutterCli({ binary: process.execPath, executor: flutterExecutor }),
    audb: new AudbCli({ binary: "audb", executor: audbExecutor }),
    runIdFactory: () => "fixedrun",
  });

  return {
    project,
    controller,
    setPackageInstalled: (value: boolean) => {
      packageInstalled = value;
    },
  };
}

const activeHarnesses: Array<{ project: string; controller: FlutterTestController }> = [];

describe("run helpers", () => {
  it("formats journalctl-compatible timestamps independently of timezone", () => {
    const value = formatJournalSince(new Date(2026, 10, 20, 9, 5, 7));
    expect(value).toMatch(/^@\d+$/);
    expect(value).toBe(`@${Math.floor(new Date(2026, 10, 20, 9, 5, 7).getTime() / 1000)}`);
  });

  it("ignores the synthetic loading test when starting periodic screenshots", () => {
    expect(
      isRealTestStart({
        type: "testStart",
        test: { id: 1, name: "loading /tmp/project/integration_test/a_test.dart" },
      }),
    ).toBe(false);
    expect(
      isRealTestStart({ type: "testStart", test: { id: 2, name: "smoke test" } }),
    ).toBe(true);
  });
});

describe("FlutterTestController", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    activeHarnesses.push(harness);
  });

  afterEach(async () => {
    await harness.controller.dispose();
    rmSync(harness.project, { recursive: true, force: true });
    const index = activeHarnesses.indexOf(harness);
    if (index >= 0) activeHarnesses.splice(index, 1);
  });

  it("runs a passing test and produces schema v1 reports", async () => {
    const result = await harness.controller.run({
      projectPath: harness.project,
      testPath: "integration_test/smoke_test.dart",
      deviceId: "emulator",
      runTimeoutMs: 30_000,
      screenshotIntervalMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.runStatus).toBe("completed");
    expect(result.testStatus).toBe("passed");
    expect(result.reporterComplete).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary.passed).toBe(1);
    expect(result.artifactsComplete).toBe(true);
    expect(result.cleanup).toMatchObject({
      packageId: "ru.audb.fixture.fixture",
      checked: true,
      packagePresentAfterRun: false,
    });

    const resultJson = JSON.parse(readFileSync(result.artifacts.resultJson, "utf8"));
    expect(resultJson.schemaVersion).toBe(1);
    expect(resultJson.ok).toBe(true);

    const runDir = statSync(result.artifacts.dir);
    expect(runDir.mode & 0o777).toBe(0o700);
    const resultFile = statSync(result.artifacts.resultJson);
    expect(resultFile.mode & 0o777).toBe(0o600);

    const junit = readFileSync(result.artifacts.junit, "utf8");
    expect(junit).toContain("<testsuite");
    expect(readFileSync(result.artifacts.summary, "utf8")).toContain("testStatus: passed");
  });

  it("redacts VM Service tokens from logs and result files", async () => {
    const events = [
      {
        type: "print",
        testID: 1,
        messageType: "print",
        message: "VM service at http://127.0.0.1:37887/SECRET_TOKEN=/",
        time: 1,
      },
      ...PASS_EVENTS,
    ];
    const local = createHarness({ events });
    activeHarnesses.push(local);
    try {
      const result = await local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      const everything = [
        readFileSync(result.artifacts.resultJson, "utf8"),
        readFileSync(join(result.artifacts.dir, "logs", "flutter-stdout-redacted.txt"), "utf8"),
      ].join("\n");
      expect(everything).not.toContain("SECRET_TOKEN");
      expect(everything).toContain("<redacted>");
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("returns RUN_IN_PROGRESS for a second run on the same device", async () => {
    let releaseTest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    let testStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      testStarted = resolve;
    });

    const local = createHarness({
      testHandler: async (_options, writeEvents) => {
        testStarted();
        await gate;
        writeEvents(PASS_EVENTS);
        return { exitCode: 0 };
      },
    });
    activeHarnesses.push(local);
    try {
      const first = local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      await started;

      await expect(
        local.controller.run({
          projectPath: local.project,
          testPath: "integration_test/smoke_test.dart",
          deviceId: "emulator",
          runTimeoutMs: 30_000,
          screenshotIntervalMs: 0,
        }),
      ).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });

      releaseTest();
      const result = await first;
      expect(result.ok).toBe(true);
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("classifies a timeout, kills the run and still writes reports", async () => {
    const local = createHarness({
      testHandler: async (_options, writeEvents) => {
        writeEvents([
          {
            type: "testStart",
            test: { id: 1, name: "stuck", suiteID: 0, groupIDs: [1], metadata: { skip: false } },
            time: 1,
          },
        ]);
        return { timedOut: true, exitCode: null };
      },
    });
    activeHarnesses.push(local);
    try {
      const result = await local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      expect(result.runStatus).toBe("timeout");
      expect(result.ok).toBe(false);
      expect(statSync(result.artifacts.resultJson).isFile()).toBe(true);
      expect(statSync(result.artifacts.junit).isFile()).toBe(true);
      expect(readFileSync(result.artifacts.junit, "utf8")).toContain("stuck");
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("classifies a build failure without tests as not_run with an infra JUnit case", async () => {
    const local = createHarness({
      events: [{ type: "done", success: false, time: 3 }],
      testResult: { exitCode: 1 },
    });
    activeHarnesses.push(local);
    try {
      const result = await local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      expect(result.runStatus).toBe("completed");
      expect(result.testStatus).toBe("not_run");
      expect(result.reporterComplete).toBe(true);
      expect(result.ok).toBe(false);
      expect(readFileSync(result.artifacts.junit, "utf8")).toContain("infrastructure");
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("classifies a missing reporter as internal_error", async () => {
    const local = createHarness({ events: [], testResult: { exitCode: 0 } });
    activeHarnesses.push(local);
    try {
      const result = await local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      expect(result.runStatus).toBe("internal_error");
      expect(result.reporterComplete).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("keeps the Flutter result when an optional screenshot collector fails", async () => {
    const local = createHarness({ screenshotFails: true });
    activeHarnesses.push(local);
    try {
      const result = await local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.artifactsComplete).toBe(false);
      expect(result.artifactErrors.some((item) => item.artifact.startsWith("screenshot"))).toBe(true);
    } finally {
      await local.controller.dispose();
      rmSync(local.project, { recursive: true, force: true });
    }
  });

  it("rejects a test path outside integration_test", async () => {
    writeFileSync(join(harness.project, "outside_test.dart"), "void main() {}\n");
    await expect(
      harness.controller.run({
        projectPath: harness.project,
        testPath: "outside_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TEST_PATH" });
  });

  it("dispose aborts an active run", async () => {
    let testStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      testStarted = resolve;
    });
    const local = createHarness({
      testHandler: async (runOptions) => {
        testStarted();
        await new Promise<void>((resolve) => {
          if (runOptions.signal?.aborted) resolve();
          else runOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { aborted: true, exitCode: null };
      },
    });
    activeHarnesses.push(local);
    try {
      const run = local.controller.run({
        projectPath: local.project,
        testPath: "integration_test/smoke_test.dart",
        deviceId: "emulator",
        runTimeoutMs: 30_000,
        screenshotIntervalMs: 0,
      });
      await started;
      await local.controller.dispose();
      const result = await run;
      expect(result.runStatus).toBe("cancelled");
      expect(result.ok).toBe(false);
    } finally {
      rmSync(local.project, { recursive: true, force: true });
    }
  });
});
