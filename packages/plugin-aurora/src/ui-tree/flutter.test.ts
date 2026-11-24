import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { FlutterUiTreeBackend } from "./flutter.js";
import { UiTreeUnavailableError } from "./types.js";

function fakeClient(options: { maps?: string; ss?: string; logs?: string }): AuroraClient {
  return {
    shell: (command: string): string => {
      if (command.includes("/proc/") && command.includes("maps")) {
        return options.maps ?? "other";
      }
      return "";
    },
    shellRoot: (command: string): string => {
      if (command.includes("ss -tlnp")) return options.ss ?? "";
      return options.maps ?? "other";
    },
    getLogs: (): string => options.logs ?? "",
  } as unknown as AuroraClient;
}

describe("FlutterUiTreeBackend discovery", () => {
  it("reports the VM Service port when the auth token is no longer logged", async () => {
    const backend = new FlutterUiTreeBackend(
      fakeClient({
        ss: 'LISTEN 0 0 127.0.0.1:34819 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=39))',
      }),
    );

    await expect(backend.getSnapshot("ru.example.app", 4242)).rejects.toMatchObject({
      code: "VM_SERVICE_TOKEN_LOST",
      details: { port: 34819 },
    });
  });

  it("reports VM_SERVICE_NOT_DISCOVERED when the app has no VM Service socket", async () => {
    const backend = new FlutterUiTreeBackend(fakeClient({}));

    await expect(backend.getSnapshot("ru.example.app", 4242)).rejects.toMatchObject({
      code: "VM_SERVICE_NOT_DISCOVERED",
    });
  });

  it("findVmServicePort ignores non-localhost listeners", () => {
    const backend = new FlutterUiTreeBackend(
      fakeClient({
        ss: [
          'LISTEN 0 0 0.0.0.0:8080 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=5))',
          'LISTEN 0 0 127.0.0.1:39999 0.0.0.0:* users:(("ru.example.app",pid=4242,fd=6))',
        ].join("\n"),
      }),
    );

    expect(backend.findVmServicePort(4242)).toBe(39999);
    expect(backend.findVmServicePort(0)).toBeUndefined();
  });

  it("wraps even unexpected errors with a redacted message", async () => {
    const backend = new FlutterUiTreeBackend(fakeClient({}));
    const error = await backend.getSnapshot("ru.example.app", 4242).catch((caught) => caught);

    expect(error).toBeInstanceOf(UiTreeUnavailableError);
  });
});
