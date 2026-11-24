/**
 * Resolve the real application process behind sailjail/firejail wrappers.
 *
 * `audb app list-running` reports the outer `firejail` process, while the
 * Flutter engine / qtium hook lives in a nested child (sometimes two levels
 * down). Both the VM Service log line and `/proc/<pid>/maps` refer to the
 * inner pid, so backend detection and hook probing must follow the tree.
 *
 * On a physical device the SSH user is usually not root, so
 * `/proc/<pid>/maps` of a sandboxed app cannot be read and `audb shell --root`
 * fails. That case is *not* fatal: the probe reports `unreadable` and callers
 * fall back to evidence that needs no privileges (the journal VM Service line
 * for Flutter). Only real mismatches are reported as `other`.
 */

import type { AuroraClient } from "../client.js";

const MAX_DEPTH = 4;

/** Well-known library markers; callers never pass user input here. */
export type ProcessMarker = "libflutter_engine" | "libqtium-engine";

/**
 * Result of a single `/proc/<pid>/maps` probe.
 *
 * - `match`      – the library is mapped in this process.
 * - `other`      – the maps were readable and the library is absent.
 * - `unreadable` – the maps (or the whole process tree) cannot be inspected
 *                  without root; the caller must fall back, not fail.
 */
export type LibraryProbeState = "match" | "other" | "unreadable";

interface ProbeContext {
  /** Lazily resolved: `false` means "stop trying audb shell --root". */
  rootWorks?: boolean;
}

/**
 * BFS the process tree starting at `rootPid` and return the first pid whose
 * maps contain `marker`. Returns `undefined` both when the library is absent
 * and when the maps are unreadable, so callers can fall back to other
 * detection sources.
 */
export function findProcessWithLibrary(
  client: AuroraClient,
  rootPid: number,
  marker: ProcessMarker,
): number | undefined {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;

  const context: ProbeContext = {};
  const seen = new Set<number>();
  let level: number[] = [rootPid];

  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: number[] = [];
    for (const pid of level) {
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      if (probeProcessLibraryWithContext(client, pid, marker, context) === "match") return pid;
      next.push(...readChildren(client, pid, context));
    }
    level = next;
  }

  return undefined;
}

/**
 * One-shot, privilege-aware probe used by backend detection (`flutter`/`qtium`).
 * Never throws: an unreadable process reports `unreadable`.
 */
export function probeProcessLibrary(
  client: AuroraClient,
  pid: number,
  marker: ProcessMarker,
): LibraryProbeState {
  if (!Number.isInteger(pid) || pid <= 0) return "other";
  return probeProcessLibraryWithContext(client, pid, marker, {});
}

function probeProcessLibraryWithContext(
  client: AuroraClient,
  pid: number,
  marker: ProcessMarker,
  context: ProbeContext,
): LibraryProbeState {
  const command = mapsProbeCommand(pid, marker);

  // Prefer root when it genuinely works: /proc/<pid>/maps of a sandboxed app is
  // unreadable otherwise. `audb shell --root` can also degrade silently to the
  // unprivileged user, hence the explicit uid check.
  if (hasRoot(client, context)) {
    try {
      return parseProbeOutput(client.shellRoot(command));
    } catch {
      context.rootWorks = false;
    }
  }

  try {
    return parseProbeOutput(client.shell(command));
  } catch {
    return "unreadable";
  }
}

function mapsProbeCommand(pid: number, marker: ProcessMarker): string {
  // `pid` is a validated integer and `marker` a fixed union member, so no
  // caller-controlled text reaches the shell.
  //
  // grep exit status is the reliable signal: 0 = match, 1 = library absent,
  // 2 = unreadable (sandboxed maps return "Permission denied" for non-root and
  // `[ -r /proc/<pid>/maps ]` lies because the denial happens on open(), not
  // on stat). `&& echo match || echo other` collapsed both failures into
  // "other", which looked like definitive evidence of a non-Flutter app.
  return [
    `grep -q ${marker} /proc/${pid}/maps;`,
    "case $? in 0) echo match;; 1) echo other;; *) echo unreadable;; esac",
  ].join(" ");
}

function parseProbeOutput(output: string): LibraryProbeState {
  const text = output.toLowerCase();
  if (text.includes("unreadable") || text.includes("not permitted") || text.includes("permission denied")) {
    return "unreadable";
  }
  if (text.includes("match") || text.includes("hooked")) return "match";
  return "other";
}

function hasRoot(client: AuroraClient, context: ProbeContext): boolean {
  if (context.rootWorks !== undefined) return context.rootWorks;
  try {
    context.rootWorks = client.shellRoot("id -u").trim() === "0";
  } catch {
    context.rootWorks = false;
  }
  return context.rootWorks;
}

function readChildren(client: AuroraClient, pid: number, context: ProbeContext): number[] {
  const command = `cat /proc/${pid}/task/${pid}/children 2>/dev/null`;
  let output: string | undefined;
  if (hasRoot(client, context)) {
    try {
      output = client.shellRoot(command);
    } catch {
      context.rootWorks = false;
    }
  }
  if (output === undefined) {
    try {
      output = client.shell(command);
    } catch {
      return [];
    }
  }
  return output
    .trim()
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
