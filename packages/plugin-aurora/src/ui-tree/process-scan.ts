/**
 * Resolve the real application process behind sailjail/firejail wrappers.
 *
 * `audb app list-running` reports the outer `firejail` process, while the
 * Flutter engine / qtium hook lives in a nested child (sometimes two levels
 * down). Both the VM Service log line and `/proc/<pid>/maps` refer to the
 * inner pid, so backend detection and hook probing must follow the tree.
 */

import type { AuroraClient } from "../client.js";

const MAX_DEPTH = 4;

/** Well-known library markers; callers never pass user input here. */
export type ProcessMarker = "libflutter_engine" | "libqtium-engine";

/**
 * BFS the process tree starting at `rootPid` and return the first pid whose
 * maps contain `marker`.
 */
export function findProcessWithLibrary(
  client: AuroraClient,
  rootPid: number,
  marker: ProcessMarker,
): number | undefined {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;

  const seen = new Set<number>();
  let level: number[] = [rootPid];

  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: number[] = [];
    for (const pid of level) {
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      if (hasLibrary(client, pid, marker)) return pid;
      next.push(...readChildren(client, pid));
    }
    level = next;
  }

  return undefined;
}

function hasLibrary(client: AuroraClient, pid: number, marker: ProcessMarker): boolean {
  const command = `grep -q ${marker} /proc/${pid}/maps && echo match || echo other`;
  // /proc/<pid>/maps of a sandboxed app is not readable by defaultuser.
  try {
    if (client.shellRoot(command).includes("match")) return true;
  } catch {
    /* fall through to the unprivileged probe */
  }
  try {
    return client.shell(command).includes("match");
  } catch {
    return false;
  }
}

function readChildren(client: AuroraClient, pid: number): number[] {
  const command = `cat /proc/${pid}/task/${pid}/children 2>/dev/null`;
  let output = "";
  try {
    output = client.shellRoot(command);
  } catch {
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
