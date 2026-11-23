import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { findProcessWithLibrary } from "./process-scan.js";

function fakeClient(options: {
  children?: Record<number, number[]>;
  maps?: Record<number, string>;
  rootFails?: boolean;
}): AuroraClient {
  const children = options.children ?? {};
  const maps = options.maps ?? {};
  const shell = (command: string): string => {
    const childrenMatch = command.match(/\/proc\/(\d+)\/task\/\d+\/children/);
    if (childrenMatch) {
      return (children[Number(childrenMatch[1])] ?? []).join(" ");
    }
    const mapsMatch = command.match(/grep -q (\S+) \/proc\/(\d+)\/maps/);
    if (mapsMatch) {
      const marker = mapsMatch[1];
      const pid = Number(mapsMatch[2]);
      return (maps[pid] ?? "").includes(marker) ? "match" : "other";
    }
    return "";
  };

  return {
    shellRoot: (command: string): string => {
      if (options.rootFails) throw new Error("root unavailable");
      return shell(command);
    },
    shell,
  } as unknown as AuroraClient;
}

describe("findProcessWithLibrary", () => {
  it("walks firejail wrapper children to the real app pid", () => {
    const client = fakeClient({
      children: { 10: [11], 11: [12], 12: [] },
      maps: { 10: "other", 11: "other", 12: "libflutter_engine.so" },
    });

    expect(findProcessWithLibrary(client, 10, "libflutter_engine")).toBe(12);
  });

  it("returns the root pid when it already has the library", () => {
    const client = fakeClient({
      children: { 20: [] },
      maps: { 20: "libqtium-engine.so" },
    });

    expect(findProcessWithLibrary(client, 20, "libqtium-engine")).toBe(20);
  });

  it("falls back to the unprivileged shell when root probing fails", () => {
    const client = fakeClient({
      children: { 30: [31] },
      maps: { 30: "other", 31: "libflutter_engine.so" },
      rootFails: true,
    });

    expect(findProcessWithLibrary(client, 30, "libflutter_engine")).toBe(31);
  });

  it("returns undefined when the library is absent or the pid is invalid", () => {
    const client = fakeClient({ children: { 40: [41] }, maps: { 40: "other", 41: "other" } });

    expect(findProcessWithLibrary(client, 40, "libflutter_engine")).toBeUndefined();
    expect(findProcessWithLibrary(client, 0, "libflutter_engine")).toBeUndefined();
  });
});
