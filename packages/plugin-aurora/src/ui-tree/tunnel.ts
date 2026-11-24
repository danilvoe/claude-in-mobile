/**
 * SSH local-port forwarding for device-local services (Flutter VM Service on
 * 127.0.0.1, qtium-bridge on 8888).
 *
 * audb does not expose a generic `forward` command, so the plugin owns a short
 * lived `ssh -N -L` child process. Arguments are passed as an argv vector (no
 * shell), and every numeric/path input is validated before spawning.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

import { UiTreeUnavailableError } from "./types.js";

export interface SshTunnelOptions {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  remoteHost?: string;
  remotePort: number;
  connectTimeoutMs?: number;
}

export class SshTunnel {
  readonly localPort: number;
  private readonly child: ChildProcess;
  private closed = false;

  private constructor(localPort: number, child: ChildProcess) {
    this.localPort = localPort;
    this.child = child;
  }

  static async open(options: SshTunnelOptions): Promise<SshTunnel> {
    validateOptions(options);
    const localPort = await findFreePort();
    const remoteHost = options.remoteHost ?? "127.0.0.1";
    const args = [
      "-N",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ExitOnForwardFailure=yes",
      "-L", `127.0.0.1:${localPort}:${remoteHost}:${options.remotePort}`,
      "-p", String(options.port),
      "-i", options.keyPath,
      `${options.user}@${options.host}`,
    ];

    const child = spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });

    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    // Without this handler a missing/failed ssh binary is an unhandled
    // 'error' event and takes the whole MCP server down.
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });

    const deadline = Date.now() + (options.connectTimeoutMs ?? 8_000);
    while (Date.now() < deadline) {
      if (spawnError) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        throw new UiTreeUnavailableError(
          `Failed to start ssh: ${spawnError.message}`,
          "SSH_TUNNEL_SPAWN_FAILED",
        );
      }
      if (exited) {
        throw new UiTreeUnavailableError(
          `SSH tunnel to ${options.host} exited before becoming ready${stderr ? `: ${stderr.trim()}` : "."}`,
          "SSH_TUNNEL_FAILED",
        );
      }
      if (await canConnect(localPort)) {
        return new SshTunnel(localPort, child);
      }
      await sleep(50);
    }

    child.kill("SIGTERM");
    throw new UiTreeUnavailableError(
      `Timed out opening an SSH tunnel to ${options.host}:${options.port}.`,
      "SSH_TUNNEL_TIMEOUT",
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }
}

function validateOptions(options: SshTunnelOptions): void {
  if (!/^[A-Za-z0-9._-]+$/.test(options.host) && net.isIP(options.host) === 0) {
    throw new UiTreeUnavailableError("Invalid SSH host.", "SSH_TUNNEL_INVALID_HOST");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new UiTreeUnavailableError("Invalid SSH port.", "SSH_TUNNEL_INVALID_PORT");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.user)) {
    throw new UiTreeUnavailableError("Invalid SSH user.", "SSH_TUNNEL_INVALID_USER");
  }
  if (!existsSync(options.keyPath)) {
    throw new UiTreeUnavailableError(
      `SSH key not found: ${options.keyPath}`,
      "SSH_TUNNEL_KEY_NOT_FOUND",
    );
  }
  if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65_535) {
    throw new UiTreeUnavailableError("Invalid remote port.", "SSH_TUNNEL_INVALID_REMOTE_PORT");
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new UiTreeUnavailableError("Could not allocate a local tunnel port.", "SSH_TUNNEL_NO_PORT"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
