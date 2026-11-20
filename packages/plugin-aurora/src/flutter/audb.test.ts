import { describe, expect, it } from "vitest";
import { AudbCli } from "./audb.js";
import { commandResult, makeExecutor } from "./test-fixtures.js";

function makeAudb(onCall: (args: string[]) => void, data: unknown = {}) {
  return new AudbCli({
    binary: "audb",
    executor: makeExecutor((_command, args) => {
      onCall(args);
      return { stdout: JSON.stringify({ ok: true, data }) };
    }),
  });
}

describe("AudbCli permissions", () => {
  it("lists declaration, grants and dialog state with an explicit device", async () => {
    let captured: string[] = [];
    const state = {
      applicationId: "ru.example.app",
      uid: 100000,
      declared: ["UserDirs"],
      granted: [],
      showPrompt: true,
    };
    const audb = makeAudb((args) => { captured = args; }, state);
    const result = await audb.permissionList("emulator", "ru.example.app");
    expect(result).toEqual(state);
    expect(captured).toEqual([
      "--device",
      "emulator",
      "--json",
      "permission",
      "list",
      "ru.example.app",
    ]);
  });

  it("grants all requested permissions with --disable-prompt", async () => {
    let captured: string[] = [];
    const audb = makeAudb((args) => { captured = args; });
    await audb.permissionGrant("emulator", "ru.example.app", {
      allRequested: true,
      disablePrompt: true,
    });
    expect(captured.slice(3)).toEqual([
      "permission",
      "grant",
      "ru.example.app",
      "--all-requested",
      "--disable-prompt",
    ]);
  });

  it("grants explicit permissions", async () => {
    let captured: string[] = [];
    const audb = makeAudb((args) => { captured = args; });
    await audb.permissionGrant("emulator", "ru.example.app", {
      permissions: ["UserDirs", "Internet"],
      disablePrompt: false,
    });
    expect(captured.slice(3)).toEqual([
      "permission",
      "grant",
      "ru.example.app",
      "UserDirs",
      "Internet",
    ]);
  });

  it("rejects grant without permissions or allRequested", async () => {
    const audb = makeAudb(() => undefined);
    await expect(
      audb.permissionGrant("emulator", "ru.example.app", {}),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects grant with both permissions and allRequested", async () => {
    const audb = makeAudb(() => undefined);
    await expect(
      audb.permissionGrant("emulator", "ru.example.app", {
        permissions: ["UserDirs"],
        allRequested: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("resets, revokes and toggles the prompt", async () => {
    const calls: string[][] = [];
    const audb = makeAudb((args) => calls.push(args));
    await audb.permissionReset("emulator", "ru.example.app");
    await audb.permissionRevoke("emulator", "ru.example.app", ["UserDirs"]);
    await audb.permissionPrompt("emulator", "ru.example.app", false);
    expect(calls[0]!.slice(3)).toEqual(["permission", "reset", "ru.example.app"]);
    expect(calls[1]!.slice(3)).toEqual([
      "permission",
      "revoke",
      "ru.example.app",
      "UserDirs",
    ]);
    expect(calls[2]!.slice(3)).toEqual([
      "permission",
      "prompt",
      "ru.example.app",
      "--disable",
    ]);
  });

  it("rejects an invalid Sailjail application ID before exec", async () => {
    let called = false;
    const audb = makeAudb(() => { called = true; });
    await expect(
      audb.permissionList("emulator", "bad app;rm -rf"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(called).toBe(false);
  });

  it("surfaces APP_NOT_FOUND from audb", async () => {
    const audb = new AudbCli({
      binary: "audb",
      executor: makeExecutor(() => ({
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "APP_NOT_FOUND", message: "Invalid application name" },
        }),
      })),
    });
    await expect(
      audb.permissionList("emulator", "ru.missing.app"),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("accepts an ordinary command result shape", () => {
    expect(commandResult()).toMatchObject({ exitCode: 0, timedOut: false });
  });
});
