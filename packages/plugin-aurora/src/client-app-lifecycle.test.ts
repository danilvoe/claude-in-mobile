import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { AuroraClient } from "./client.js";

/**
 * `audb launch` fails with ApplicationAlreadyRunning for a running app, so the
 * client raises the existing window through lipstick instead. The fake audb
 * below records every invocation so the chosen path is observable.
 */
describe("AuroraClient app lifecycle", () => {
  let workDir: string;
  let logFile: string;
  let savedPath: string | undefined;
  let savedLog: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-aurora-lifecycle-"));
    logFile = join(workDir, "audb.log");
    const fakeAudb = join(workDir, "audb");
    writeFileSync(
      fakeAudb,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$AUDB_TEST_LOG"',
        'case "$*" in',
        '  *"app list-running"*) echo \'{"ok":true,"data":[{"package":"ru.example.Running","pid":42}]}\' ;;',
        '  "shell "*"WindowModel"*) if [ "$AUDB_FAIL_SHELL" = "1" ]; then echo "shell boom" >&2; exit 1; fi; echo "()" ;;',
        '  "launch "*"ru.example.Stopped"*) if [ "$AUDB_FAIL_LAUNCH" = "1" ]; then echo "Error: ApplicationAlreadyRunning" >&2; exit 1; fi; echo "" ;;',
        "  *) echo '' ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAudb, 0o755);

    savedPath = process.env.PATH;
    savedLog = process.env.AUDB_TEST_LOG;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
    process.env.AUDB_TEST_LOG = logFile;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.AUDB_TEST_LOG;
    else process.env.AUDB_TEST_LOG = savedLog;
    rmSync(workDir, { recursive: true, force: true });
  });

  const invocations = (): string[] => readFileSync(logFile, "utf8").trim().split("\n");

  it("raises a running app instead of calling `audb launch`", () => {
    const client = new AuroraClient();

    expect(client.launchApp("ru.example.Running")).toBe("Activated ru.example.Running");

    const calls = invocations();
    const activate = calls.find((line) => line.includes("WindowModel"));
    expect(activate).toContain('local.Lipstick.WindowModel.launchProcess "ru.example.Running"');
    expect(calls.some((line) => /^launch ru\.example\.Running$/.test(line))).toBe(false);
  });

  it("falls back to `audb launch` when activation fails", () => {
    process.env.AUDB_FAIL_SHELL = "1";
    try {
      const client = new AuroraClient();

      client.launchApp("ru.example.Running");

      const calls = invocations();
      expect(calls.some((line) => line.includes("WindowModel"))).toBe(true);
      expect(calls.some((line) => line === "launch ru.example.Running")).toBe(true);
    } finally {
      delete process.env.AUDB_FAIL_SHELL;
    }
  });

  it("launches an app that is not running", () => {
    const client = new AuroraClient();

    client.launchApp("ru.example.Stopped");

    const calls = invocations();
    expect(calls.some((line) => line === "launch ru.example.Stopped")).toBe(true);
    expect(calls.some((line) => line.includes("WindowModel"))).toBe(false);
  });

  it("rejects an invalid package name before building a device shell command", () => {
    const client = new AuroraClient();

    expect(() => client.activateApp('ru.example.App"; rm -rf /')).toThrow(/invalid package name/i);
  });

  it("keeps audb stderr so callers can match RuntimeManager errors", () => {
    process.env.AUDB_FAIL_LAUNCH = "1";
    try {
      const client = new AuroraClient();

      expect(() => client.launchApp("ru.example.Stopped")).toThrow(/ApplicationAlreadyRunning/);
    } finally {
      delete process.env.AUDB_FAIL_LAUNCH;
    }
  });
});
