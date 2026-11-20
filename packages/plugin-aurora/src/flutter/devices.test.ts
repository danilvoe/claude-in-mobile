import { describe, expect, it } from "vitest";
import { FlutterCli } from "./flutter-cli.js";
import { AudbCli } from "./audb.js";
import { DeviceResolver } from "./devices.js";
import { commandResult, makeExecutor } from "./test-fixtures.js";

const flutterDevices = [
  {
    name: "Emulator Aurora OS 5.2.0.180 (x64)",
    id: "AuroraOS-5.2.0.180",
    targetPlatform: "aurora-x64",
    emulator: true,
    isSupported: true,
  },
  {
    name: "Physical Aurora",
    id: "aurora-192.168.1.2",
    targetPlatform: "aurora-arm64",
    emulator: false,
    isSupported: true,
  },
];

const audbDevices = [
  {
    id: "emulator",
    name: "Aurora Emulator",
    kind: "emulator",
    host: "127.0.0.1",
    emulator: { emulatorName: "AuroraOS-5.2.0.180" },
  },
  {
    id: "aurora-192.168.1.2",
    name: "Physical Aurora",
    kind: "device",
    host: "192.168.1.2",
  },
];

function makeFlutter(devices: unknown[]): FlutterCli {
  return new FlutterCli({
    binary: process.execPath,
    executor: makeExecutor(() => ({
      stdout: JSON.stringify(devices),
    })),
  });
}

function makeAudb(devices: unknown[]): AudbCli {
  return new AudbCli({
    binary: "audb",
    executor: makeExecutor((_command, args) => {
      if (args.includes("device") && args.includes("list")) {
        return { stdout: JSON.stringify({ ok: true, data: devices }) };
      }
      return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { message: "no" } }) };
    }),
  });
}

describe("DeviceResolver", () => {
  it("maps an auto-discovered QEMU emulator by emulatorName", async () => {
    const resolver = new DeviceResolver(makeFlutter(flutterDevices), makeAudb(audbDevices));
    const mapping = await resolver.resolve("emulator");
    expect(mapping.flutterDeviceId).toBe("AuroraOS-5.2.0.180");
    expect(mapping.method).toBe("emulatorName");
  });

  it("maps a physical device by name", async () => {
    const resolver = new DeviceResolver(makeFlutter(flutterDevices), makeAudb(audbDevices));
    const mapping = await resolver.resolve("aurora-192.168.1.2");
    expect(mapping.flutterDeviceId).toBe("aurora-192.168.1.2");
  });

  it("fails when the audb device is absent", async () => {
    const resolver = new DeviceResolver(makeFlutter(flutterDevices), makeAudb(audbDevices));
    await expect(resolver.resolve("missing")).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });

  it("fails when no Flutter device matches", async () => {
    const resolver = new DeviceResolver(
      makeFlutter(flutterDevices),
      makeAudb([{ id: "other", name: "Other", kind: "device", host: "10.0.0.1" }]),
    );
    await expect(resolver.resolve("other")).rejects.toMatchObject({
      code: "FLUTTER_DEVICE_NOT_FOUND",
    });
  });

  it("fails on an ambiguous mapping", async () => {
    const devices = [
      { id: "A", name: "Same", targetPlatform: "aurora-x64", emulator: false },
      { id: "B", name: "Same", targetPlatform: "aurora-x64", emulator: false },
    ];
    const resolver = new DeviceResolver(
      makeFlutter(devices),
      makeAudb([{ id: "dup", name: "Same", kind: "device", host: "10.0.0.2" }]),
    );
    await expect(resolver.resolve("dup")).rejects.toMatchObject({
      code: "AMBIGUOUS_DEVICE_MAPPING",
    });
  });

  it("fails on duplicate audb registry ids", async () => {
    const resolver = new DeviceResolver(
      makeFlutter(flutterDevices),
      makeAudb([...audbDevices, { id: "emulator", name: "Duplicate", kind: "emulator" }]),
    );
    await expect(resolver.resolve("emulator")).rejects.toMatchObject({
      code: "AMBIGUOUS_DEVICE_MAPPING",
    });
  });

  it("fails list() when the selected device maps ambiguously", async () => {
    const devices = [
      { id: "A", name: "Same", targetPlatform: "aurora-x64", emulator: false },
      { id: "B", name: "Same", targetPlatform: "aurora-x64", emulator: false },
    ];
    const resolver = new DeviceResolver(
      makeFlutter(devices),
      makeAudb([{ id: "dup", name: "Same", kind: "device", host: "10.0.0.2" }]),
    );
    await expect(resolver.list({ deviceId: "dup" })).rejects.toMatchObject({
      code: "AMBIGUOUS_DEVICE_MAPPING",
    });
  });

  it("lists mappings and unmatched devices", async () => {
    const resolver = new DeviceResolver(
      makeFlutter(flutterDevices),
      makeAudb([
        ...audbDevices,
        { id: "offline", name: "Offline", kind: "device", host: "10.9.9.9" },
      ]),
    );
    const report = await resolver.list();
    expect(report.ok).toBe(true);
    expect(report.mappings).toHaveLength(2);
    expect(report.unmatched).toEqual([
      { audbDeviceId: "offline", reason: "No Flutter device matches this audb record." },
    ]);
  });

  it("fails when there are no Aurora Flutter devices", async () => {
    const resolver = new DeviceResolver(
      makeFlutter([{ id: "chrome", name: "Chrome", targetPlatform: "web-javascript" }]),
      makeAudb(audbDevices),
    );
    await expect(resolver.resolve("emulator")).rejects.toMatchObject({
      code: "FLUTTER_DEVICE_NOT_FOUND",
    });
  });
});

describe("FlutterCli", () => {
  it("reports a missing binary as FLUTTER_NOT_FOUND", async () => {
    const cli = new FlutterCli({ binary: "/definitely/not/a/flutter" });
    await expect(cli.version()).rejects.toMatchObject({ code: "FLUTTER_NOT_FOUND" });
  });

  it("rejects malformed devices JSON", async () => {
    const cli = new FlutterCli({
      binary: process.execPath,
      executor: makeExecutor(() => ({ stdout: "not json" })),
    });
    await expect(cli.devicesMachine()).rejects.toMatchObject({
      code: "FLUTTER_MALFORMED_JSON",
    });
  });

  it("surfaces non-zero exit codes", async () => {
    const cli = new FlutterCli({
      binary: process.execPath,
      executor: makeExecutor(() => ({ exitCode: 2, stdout: "[]" })),
    });
    await expect(cli.devicesMachine()).rejects.toMatchObject({
      code: "FLUTTER_COMMAND_FAILED",
    });
  });

  it("builds only allow-listed test arguments", async () => {
    let captured: string[] = [];
    const cli = new FlutterCli({
      binary: process.execPath,
      executor: makeExecutor((_command, args) => {
        captured = args;
        return commandResult({ exitCode: 0 });
      }),
    });
    await cli.testProcess({
      projectPath: "/tmp/project",
      testPath: "/tmp/project/integration_test/smoke_test.dart",
      flutterDeviceId: "AuroraOS-5.2.0.180",
      fileReporterPath: "/tmp/run/flutter/tests.json",
      timeoutMs: 1_000,
      testTimeout: 30,
    });
    expect(captured).toEqual([
      "test",
      "/tmp/project/integration_test/smoke_test.dart",
      "-d",
      "AuroraOS-5.2.0.180",
      "--reporter=json",
      "--file-reporter=json:/tmp/run/flutter/tests.json",
      "--timeout",
      "30s",
    ]);
    expect(captured.some((arg) => arg.includes(";"))).toBe(false);
    expect(captured.some((arg) => arg.includes("--disable-service-auth-codes"))).toBe(false);
  });
});
