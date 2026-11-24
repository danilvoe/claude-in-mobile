/**
 * Flutter UI-tree backend.
 *
 * Discovery: the Aurora Flutter embedder logs the VM Service URL to the app's
 * journal. We parse it, forward the device-local port over SSH, connect to the
 * VM Service WebSocket, enable semantics through the existing WidgetsBinding
 * singleton, and dump the semantics tree.
 *
 * Only debug/profile builds expose the VM Service. Release AOT builds return a
 * clear `UI_TREE_UNSUPPORTED` error.
 */

import type { AuroraClient } from "../client.js";
import { redactSecrets } from "../flutter/redact.js";
import { findProcessWithLibrary, probeProcessLibrary } from "./process-scan.js";
import { parseSemanticsDump, semanticsToUiNodes } from "./semantics.js";
import { SshTunnel } from "./tunnel.js";
import {
  UiTreeUnavailableError,
  type ScreenGeometry,
  type UiTreeSnapshot,
} from "./types.js";
import { VmServiceClient } from "./vm-service.js";

export interface FlutterUiTreeOptions {
  /** Optional timeout for the whole dump, including tunnel setup. */
  timeoutMs?: number;
}

interface VmServiceLocation {
  port: number;
  token: string;
  pid: number;
}

/** Result of rootless-capable Flutter backend detection. */
export interface FlutterAppEvidence {
  /** Inner process pid the UI tree must be read from. */
  innerPid: number;
  /** Which evidence classified the app. */
  source: "maps" | "vm-service";
  /** Set when the journal VM Service line was readable. */
  vmService?: { pid: number; port: number };
}

interface CachedSession {
  pid: number;
  vmPort: number;
  tunnel: SshTunnel;
  client: VmServiceClient;
  isolateId?: string;
}

const LOG_LINE = /([A-Za-z0-9_.-]+)\[(\d+)\]:.*Dart VM [Ss]ervice is listening on http:\/\/127\.0\.0\.1:(\d+)\/([^/\s]+)\//;

export class FlutterUiTreeBackend {
  private readonly client: AuroraClient;
  private readonly timeoutMs: number;
  private session?: CachedSession;

  constructor(client: AuroraClient, options: FlutterUiTreeOptions = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** True when the running process has the Flutter engine mapped. */
  isFlutterProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return probeProcessLibrary(this.client, pid, "libflutter_engine") === "match";
  }

  /**
   * Resolve the real Flutter process. audb reports the outer firejail pid, and
   * the engine lives in a nested child.
   */
  resolveAppPid(pid: number): number | undefined {
    return findProcessWithLibrary(this.client, pid, "libflutter_engine");
  }

  /**
   * Classify a running app as Flutter without requiring root.
   *
   * `/proc/<pid>/maps` is unreadable for a sandboxed app on a physical device
   * where the SSH user is not root (`audb shell --root` fails), so the journal
   * VM Service line — which only a Flutter debug/profile build emits — is
   * first-class evidence. The line also names the real inner pid, which is what
   * the tunnel and semantics dump need.
   */
  detectApp(packageName: string, rootPid: number): FlutterAppEvidence | undefined {
    const mapsPid = this.resolveAppPid(rootPid);
    if (mapsPid !== undefined) {
      return { innerPid: mapsPid, source: "maps" };
    }
    const vmService = this.findVmService(packageName);
    if (!vmService) return undefined;
    return { innerPid: vmService.pid, source: "vm-service", vmService };
  }

  async getSnapshot(packageName: string, pid: number): Promise<UiTreeSnapshot> {
    // The journal line names the real (inner) pid and needs no privileges, so
    // it is the primary source. `/proc` probing is only a tie-breaker for apps
    // whose VM Service line already rotated out of the journal.
    const location = this.discoverVmService(packageName, pid)
      ?? this.discoverVmService(packageName);
    const resolvedPid = location !== undefined
      ? location.pid
      : this.isFlutterProcess(pid)
        ? pid
        : (this.resolveAppPid(pid) ?? pid);

    // A live VM Service session outlives the journal line that announced it.
    if (this.session && this.session.pid === resolvedPid && this.session.client.connected) {
      try {
        return await this.dumpWithSession(this.session, packageName);
      } catch {
        this.disposeSession();
      }
    }

    try {
      const first = await this.tryGetSnapshot(packageName, resolvedPid, location);
      if (first) return first;
    } catch {
      /* retry once after dropping a stale session */
    }

    // The app may have been restarted between discovery and connect, so the
    // second attempt re-reads the journal instead of reusing the location.
    this.disposeSession();
    const second = await this.tryGetSnapshot(packageName, resolvedPid);
    if (second) return second;

    // Distinguish "journal rotated away" from "not a debug build": the VM
    // Service port stays open even when its auth token is no longer logged.
    const port = this.findVmServicePort(resolvedPid);
    if (port !== undefined) {
      throw new UiTreeUnavailableError(
        `The Flutter VM Service for ${packageName} listens on 127.0.0.1:${port}, but its auth token is no longer in the journal. `
          + "Relaunch the app to re-announce it (this resets app state).",
        "VM_SERVICE_TOKEN_LOST",
        { packageName, pid: resolvedPid, port },
      );
    }

    throw new UiTreeUnavailableError(
      `No Flutter VM Service was found for ${packageName}. Use a debug build, keep the app running, and try again.`,
      "VM_SERVICE_NOT_DISCOVERED",
      { packageName, pid: resolvedPid },
    );
  }

  /**
   * Find the localhost port the Dart VM Service listens on. Used only for
   * diagnostics when the auth token cannot be recovered from the journal.
   */
  findVmServicePort(pid: number): number | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
      const output = this.client.shellRoot(`ss -tlnp 2>/dev/null | grep 'pid=${pid},'`);
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)/);
        if (match) return Number(match[1]);
      }
    } catch {
      /* ss is unavailable or lacks permissions */
    }
    return undefined;
  }

  invalidate(): void {
    this.disposeSession();
  }

  close(): void {
    this.disposeSession();
  }

  private async tryGetSnapshot(
    packageName: string,
    pid: number,
    known?: VmServiceLocation,
  ): Promise<UiTreeSnapshot | undefined> {
    // Prefer the wrapper pid, but fall back to the package-only log match: the
    // VM Service log line carries the real (inner) pid, which is what matters.
    const location = known
      ?? this.discoverVmService(packageName, pid)
      ?? this.discoverVmService(packageName);
    if (!location) return undefined;

    try {
      const session = await this.ensureSession(location.pid, location);
      return await this.dumpWithSession(session, packageName);
    } catch (error) {
      // A stale VM Service port/token after an app restart is the common case.
      this.disposeSession();
      if (error instanceof UiTreeUnavailableError) {
        const redacted = redactSecrets(error.message);
        if (redacted !== error.message) {
          throw new UiTreeUnavailableError(redacted, error.code, error.details);
        }
        throw error;
      }
      throw new UiTreeUnavailableError(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        "FLUTTER_UI_TREE_FAILED",
      );
    }
  }

  private async dumpWithSession(session: CachedSession, packageName: string): Promise<UiTreeSnapshot> {
    const isolateId = session.isolateId ?? await this.withTimeout(
      session.client.getMainIsolateId(),
      "Flutter VM Service isolate discovery timed out.",
    );
    session.isolateId = isolateId;

    const dump = await this.withTimeout(
      session.client.dumpSemantics(isolateId),
      "Flutter semantics dump timed out.",
    );
    const semantics = parseSemanticsDump(dump);
    if (semantics.length === 0) {
      throw new UiTreeUnavailableError(
        "Flutter returned an empty semantics tree.",
        "SEMANTICS_EMPTY",
      );
    }

    const screen = this.client.getScreenshotGeometry();
    const nodes = semanticsToUiNodes(semantics, screen, packageName);
    if (nodes.length === 0) {
      throw new UiTreeUnavailableError(
        "Flutter semantics contained no actionable nodes.",
        "SEMANTICS_NO_ACTIONABLE_NODES",
      );
    }

    return {
      backend: "flutter",
      packageName,
      screen,
      nodes,
      metadata: {
        vmServicePort: session.vmPort,
        semanticsNodes: semantics.length,
      },
    };
  }

  private async ensureSession(pid: number, location: VmServiceLocation): Promise<CachedSession> {
    if (
      this.session
      && this.session.pid === pid
      && this.session.vmPort === location.port
      && this.session.client.connected
    ) {
      return this.session;
    }

    this.disposeSession();

    const device = this.client.getDeviceRecord();
    const tunnel = await SshTunnel.open({
      host: device.host,
      port: device.sshPort,
      user: device.sshUser,
      keyPath: device.sshKey,
      remoteHost: "127.0.0.1",
      remotePort: location.port,
    });

    const client = new VmServiceClient({
      url: `ws://127.0.0.1:${tunnel.localPort}/${location.token}/ws`,
    });

    try {
      await client.connect();
    } catch (error) {
      tunnel.close();
      client.close();
      throw error;
    }

    this.session = { pid, vmPort: location.port, tunnel, client };
    return this.session;
  }

  /** Public, token-free VM Service lookup for backend selection. */
  findVmService(packageName: string): { pid: number; port: number } | undefined {
    const location = this.discoverVmService(packageName);
    return location ? { pid: location.pid, port: location.port } : undefined;
  }

  private discoverVmService(packageName: string, pid?: number): VmServiceLocation | undefined {
    let logs = "";
    try {
      logs = this.client.getLogs({ lines: 5_000, grep: "Dart VM" });
    } catch {
      return undefined;
    }

    let match: VmServiceLocation | undefined;
    for (const line of logs.split(/\r?\n/)) {
      const parsed = line.match(LOG_LINE);
      if (!parsed) continue;
      const linePackage = parsed[1];
      const linePid = Number(parsed[2]);
      if (linePackage !== packageName) continue;
      if (pid !== undefined && linePid !== pid) continue;
      match = { port: Number(parsed[3]), token: parsed[4], pid: linePid };
    }
    return match;
  }

  private async withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new UiTreeUnavailableError(message, "FLUTTER_UI_TREE_TIMEOUT"));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private disposeSession(): void {
    if (!this.session) return;
    this.session.client.close();
    this.session.tunnel.close();
    this.session = undefined;
  }
}

/** Exported for tests; keeps the regex next to its only consumer. */
export { LOG_LINE as FLUTTER_VM_SERVICE_LOG_LINE };

export type { ScreenGeometry };
