import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { findProcessWithLibrary, probeProcessLibrary } from "./process-scan.js";

function fakeClient(options: {
  children?: Record<number, number[]>;
  maps?: Record<number, string>;
  rootFails?: boolean;
  /** What the unprivileged user sees: a physical device usually denies maps. */
  unprivilegedMaps?: "readable" | "unreadable";
}): AuroraClient {
  const children = options.children ?? {};
  const maps = options.maps ?? {};
  const unprivilegedMaps = options.unprivilegedMaps ?? "readable";

  const probe = (command: string, privileged: boolean): string => {
    const childrenMatch = command.match(/\/proc\/(\d+)\/task\/\d+\/children/);
    if (childrenMatch) {
      return (children[Number(childrenMatch[1])] ?? []).join(" ");
    }
    const mapsMatch = command.match(/grep -q (\S+) \/proc\/(\d+)\/maps/);
    if (mapsMatch) {
      if (!privileged && unprivilegedMaps === "unreadable") return "unreadable";
      const marker = mapsMatch[1];
      const pid = Number(mapsMatch[2]);
      return (maps[pid] ?? "").includes(marker) ? "match" : "other";
    }
    return "";
  };

  return {
    shellRoot: (command: string): string => {
      if (options.rootFails) throw new Error("audb shell --root command failed.");
      if (command.trim() === "id -u") return "0";
      return probe(command, true);
    },
    shell: (command: string): string => probe(command, false),
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

  it("returns undefined without throwing when a non-root user cannot read maps", () => {
    const client = fakeClient({
      children: { 50: [51], 51: [] },
      maps: { 50: "other", 51: "libflutter_engine.so" },
      rootFails: true,
      unprivilegedMaps: "unreadable",
    });

    expect(findProcessWithLibrary(client, 50, "libflutter_engine")).toBeUndefined();
    expect(probeProcessLibrary(client, 51, "libflutter_engine")).toBe("unreadable");
  });

  it("treats `audb shell --root` permission errors as unreadable evidence", () => {
    const client = {
      shellRoot: (): string => {
        throw new Error("audb shell --root command failed: Permission denied");
      },
      shell: (): string => `cat: /proc/61/maps: Permission denied`,
    } as unknown as AuroraClient;

    expect(findProcessWithLibrary(client, 61, "libflutter_engine")).toBeUndefined();
    expect(probeProcessLibrary(client, 61, "libflutter_engine")).toBe("unreadable");
  });

  it("does not read stderr noise about a denied maps file as `other`", () => {
    const client = {
      shellRoot: (): string => {
        throw new Error("root unavailable");
      },
      shell: (): string => "grep: /proc/42/maps: Permission denied\nother",
    } as unknown as AuroraClient;

    expect(probeProcessLibrary(client, 42, "libqtium-engine")).toBe("unreadable");
  });

  it("still finds the nested pid through root when maps are unreadable unprivileged", () => {
    const client = fakeClient({
      children: { 70: [71], 71: [] },
      maps: { 70: "firejail", 71: "libflutter_engine.so" },
      unprivilegedMaps: "unreadable",
    });

    expect(findProcessWithLibrary(client, 70, "libflutter_engine")).toBe(71);
    expect(probeProcessLibrary(client, 71, "libflutter_engine")).toBe("match");
  });
});
