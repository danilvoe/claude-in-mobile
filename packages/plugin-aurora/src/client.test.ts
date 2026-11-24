import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { delimiter, join } from "path";

import { AuroraClient } from "./client.js";

/**
 * Security regression tests for issue #40 — host-side OS Command Injection (CWE-78).
 *
 * Strategy: install a fake `audb` shell script that always exits 0 in a tmp dir,
 * then prepend that dir to PATH so `execFileSync("audb", ...)` resolves to the fake.
 * Invoke AuroraClient methods with payloads that would trigger host-side RCE under the old
 * `execSync(string)` implementation. Assert that the side-effect (touch on host filesystem)
 * does NOT occur — which proves the argv-form (execFileSync) is in effect.
 *
 * Skipped on Windows where the shell semantics of `&` differ (cmd.exe vs /bin/sh) and the
 * shim mechanism isn't portable. The vulnerability and fix are Unix-shell-specific.
 *
 * NOTE: Aurora client resolves `audb` by name from PATH (no resolver module / env-var
 * override), so we use the PATH-prepend strategy. The fake audb must precede the real one
 * (if any) in PATH.
 */

const isWin = platform() === "win32";
const describeUnix = isWin ? describe.skip : describe;

describeUnix("AuroraClient — host-side injection regression (issue #40)", () => {
  let workDir: string;
  let proofFile: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-sec-aurora-"));
    const fakeAudb = join(workDir, "audb");
    proofFile = join(workDir, "RCE_PROOF");

    // Fake audb: exit 0, ignore args. Real audb would also exit 0 for many sub-commands;
    // we only care about host-side side-effects here.
    writeFileSync(fakeAudb, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAudb, 0o755);

    savedPath = process.env.PATH;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    try {
      if (existsSync(proofFile)) unlinkSync(proofFile);
    } catch {
      // best-effort
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("shell() with `& touch <hostfile>` does NOT execute the host command", () => {
    const client = new AuroraClient();
    // Under the OLD execSync(string) path this would background-fork the (fake) audb call
    // and then run `touch <proofFile>` on the host. With the new execFileSync(audb, argv)
    // path the entire payload travels as a single argv slot — host shell never parses it.
    client.shell(`x & touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `; touch` chaining does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell(`x ; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `$(touch <hostfile>)` does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell(`echo $(touch ${proofFile})`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with backticks does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell("echo `touch " + proofFile + "`");
    expect(existsSync(proofFile)).toBe(false);
  });

  it("installApp() with a path containing `; touch` does NOT execute the host command", () => {
    const client = new AuroraClient();
    // Path with embedded injection attempt — argv-form treats it as a literal filename.
    client.installApp(`/tmp/fake.rpm; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("launchApp() with an injection payload does NOT execute the host command", () => {
    const client = new AuroraClient();
    // `audb launch <packageName>` — the entire packageName slot stays a single argv arg.
    client.launchApp(`ru.example.App; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("pushFile() with injection in remote path does NOT execute the host command", () => {
    const client = new AuroraClient();
    // Both args pass through to `audb push <local> <remote>` as distinct argv slots.
    client.pushFile("/tmp/local.bin", `/tmp/remote.bin; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listDevices — audb JSON output (0.4.2+) with legacy table fallback
// ---------------------------------------------------------------------------

describeUnix("AuroraClient — listDevices", () => {
  let workDir: string;
  let savedPath: string | undefined;

  function installFakeAudb(body: string): void {
    const fakeAudb = join(workDir, "audb");
    writeFileSync(fakeAudb, `#!/bin/sh\n${body}\n`);
    chmodSync(fakeAudb, 0o755);
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-aurora-list-"));
    savedPath = process.env.PATH;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("parses the --json envelope and probes device state", () => {
    installFakeAudb(`
if [ "$1" = "--json" ] && [ "$2" = "device" ]; then
  printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":null,"data":[{"id":"emulator","name":"Aurora Emulator","host":"127.0.0.1","kind":"emulator","current":true}]}'
  exit 0
fi
if [ "$1" = "--json" ] && [ "$2" = "--device" ] && [ "$4" = "status" ]; then
  printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"connected":true,"status":{"running":true}}}'
  exit 0
fi
exit 1
`);

    const devices = new AuroraClient().listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "emulator",
      name: "Aurora Emulator",
      platform: "aurora",
      state: "connected",
      isSimulator: true,
      host: "127.0.0.1",
    });
  });

  it("marks a device disconnected when the status probe fails", () => {
    installFakeAudb(`
if [ "$1" = "--json" ] && [ "$2" = "device" ]; then
  printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":null,"data":[{"id":"phone","name":"Phone","host":"192.168.2.15","kind":"physical"}]}'
  exit 0
fi
exit 1
`);

    const devices = new AuroraClient().listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "phone",
      state: "disconnected",
      isSimulator: false,
    });
  });

  it("falls back to the legacy table output for older audb", () => {
    installFakeAudb(`
if [ "$1" = "--json" ]; then
  exit 2
fi
if [ "$1" = "device" ]; then
  printf '%s\n' 'Index Name                 Address           Port  Platform   State'
  printf '%s\n' '0     R570                 192.168.2.13      22    aurora-arm connected(3609s) *'
  exit 0
fi
exit 1
`);

    const devices = new AuroraClient().listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "192.168.2.13",
      name: "R570",
      state: "connected",
      isSimulator: false,
    });
  });
});

// ---------------------------------------------------------------------------
// getLogs / crashList — argv pass-through to audb
// ---------------------------------------------------------------------------

describeUnix("AuroraClient — logs and crash list argv", () => {
  let workDir: string;
  let argsFile: string;
  let savedPath: string | undefined;

  function installFakeAudb(body: string): void {
    const fakeAudb = join(workDir, "audb");
    writeFileSync(fakeAudb, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n${body}\n`);
    chmodSync(fakeAudb, 0o755);
  }

  function readArgs(): string[] {
    return readFileSync(argsFile, "utf-8").trimEnd().split("\n");
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-aurora-logs-"));
    argsFile = join(workDir, "args.txt");
    savedPath = process.env.PATH;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("getLogs maps level/grep/since/lines onto `audb logs` flags", () => {
    installFakeAudb(`printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"output":"journal line"}}'`);

    const output = new AuroraClient().getLogs({
      lines: 42,
      priority: "err",
      grep: "segfault",
      since: "1 hour ago",
    });

    expect(output).toBe(
      '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"output":"journal line"}}',
    );
    expect(readArgs()).toEqual([
      "logs",
      "-n", "42",
      "--priority", "err",
      "--grep", "segfault",
      "--since", "1 hour ago",
    ]);
  });

  it("crashList builds `crash list [package] --since --lines --json` and parses events", () => {
    installFakeAudb(`printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"count":1,"events":[{"type":"segfault","line":"2026-11-24T09:42:01+0300 host app[42]: segfault at 0"}],"nativeBacktraceAvailable":false,"package":"ru.example.App","since":"today"}}'`);

    const events = new AuroraClient().crashList({
      package: "ru.example.App",
      since: "today",
      lines: 250,
    });

    expect(readArgs()).toEqual([
      "crash", "list",
      "ru.example.App",
      "--since", "today",
      "--lines", "250",
      "--json",
    ]);
    expect(events).toEqual([
      { type: "segfault", line: "2026-11-24T09:42:01+0300 host app[42]: segfault at 0" },
    ]);
  });

  it("crashList omits filters that were not supplied and returns [] on an empty journal", () => {
    installFakeAudb(`printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"count":0,"events":[],"nativeBacktraceAvailable":false,"package":null,"since":"@1700000000"}}'`);

    expect(new AuroraClient().crashList()).toEqual([]);
    expect(readArgs()).toEqual(["crash", "list", "--json"]);
  });

  it("crashList drops malformed event entries instead of throwing", () => {
    installFakeAudb(`printf '%s' '{"ok":true,"schemaVersion":1,"deviceId":"emulator","data":{"events":[null,{"type":"oom"},{"type":"fatal","line":""},{"type":"abort","line":"boom"}],"count":4}}'`);

    expect(new AuroraClient().crashList({ since: "today" })).toEqual([
      { type: "abort", line: "boom" },
    ]);
  });

  it("crashList rejects an injected package id before spawning audb", () => {
    installFakeAudb("exit 0");

    expect(() => new AuroraClient().crashList({ package: "ru.example.App;rm -rf /" })).toThrow();
    expect(existsSync(argsFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pressKey — Aurora has no BACK key, so it maps to the system edge swipe
// ---------------------------------------------------------------------------

describeUnix("AuroraClient — pressKey", () => {
  let workDir: string;
  let argsFile: string;
  let savedPath: string | undefined;

  function installFakeAudb(): void {
    const fakeAudb = join(workDir, "audb");
    writeFileSync(fakeAudb, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`);
    chmodSync(fakeAudb, 0o755);
  }

  function readArgs(): string[] {
    return readFileSync(argsFile, "utf-8").trimEnd().split("\n");
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-aurora-key-"));
    argsFile = join(workDir, "args.txt");
    savedPath = process.env.PATH;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("maps BACK to the system edge swipe instead of `audb key`", () => {
    installFakeAudb();

    new AuroraClient().pressKey("BACK");

    expect(readArgs()).toEqual(["swipe", "edge-right"]);
  });

  it("maps any casing of back to the edge swipe", () => {
    installFakeAudb();

    new AuroraClient().pressKey("Back");

    expect(readArgs()).toEqual(["swipe", "edge-right"]);
  });

  it("forwards ordinary keys to `audb key` unchanged", () => {
    installFakeAudb();

    new AuroraClient().pressKey("ENTER");

    expect(readArgs()).toEqual(["key", "ENTER"]);
  });
});
