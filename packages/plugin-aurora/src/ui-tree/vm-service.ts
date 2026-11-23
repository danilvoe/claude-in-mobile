/**
 * Minimal Dart VM Service client (JSON-RPC over WebSocket).
 *
 * Only the calls needed by the Flutter UI-tree backend are implemented:
 * isolate discovery, enabling semantics through the existing `WidgetsBinding`
 * singleton, and the semantics-tree dump service extension.
 *
 * We intentionally do not use `evaluate`: apps launched outside `flutter run`
 * have no expression compiler ("No compilation service available"), while
 * `invoke` works because it calls an already-compiled method.
 */

import WebSocket from "ws";

import { UiTreeUnavailableError } from "./types.js";

interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: RpcErrorPayload;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface VmServiceClientOptions {
  url: string;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

export class VmServiceClient {
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private socket?: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;
  private bindingInstanceId?: string;

  constructor(options: VmServiceClientOptions) {
    this.url = options.url;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.socket) this.close();

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new UiTreeUnavailableError(
          "Timed out connecting to the Flutter VM Service.",
          "VM_SERVICE_CONNECT_TIMEOUT",
        ));
      }, this.connectTimeoutMs);

      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      // Keep a persistent listener: an `error` after `open` would otherwise be
      // an unhandled EventEmitter error and crash the server.
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(new UiTreeUnavailableError(
          `Flutter VM Service connection failed: ${error.message}`,
          "VM_SERVICE_CONNECT_FAILED",
        ));
      });
      socket.on("message", (data) => this.onMessage(data.toString()));
      socket.on("close", () => this.onClose());
    });
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new UiTreeUnavailableError(
        "Flutter VM Service connection closed.",
        "VM_SERVICE_CLOSED",
      ));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        /* best effort */
      }
    }
    this.closed = false;
  }

  private onMessage(payload: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(payload) as RpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new UiTreeUnavailableError(
        `Flutter VM Service RPC failed: ${message.error.message}`,
        "VM_SERVICE_RPC_FAILED",
        { code: message.error.code },
      ));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private onClose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new UiTreeUnavailableError(
        "Flutter VM Service connection closed.",
        "VM_SERVICE_CLOSED",
      ));
    }
    this.pending.clear();
  }

  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.rpcTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (!this.connected) {
      throw new UiTreeUnavailableError(
        "Flutter VM Service is not connected.",
        "VM_SERVICE_NOT_CONNECTED",
      );
    }
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UiTreeUnavailableError(
          `Flutter VM Service RPC timed out: ${method}`,
          "VM_SERVICE_RPC_TIMEOUT",
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(payload, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new UiTreeUnavailableError(
          `Flutter VM Service send failed: ${error.message}`,
          "VM_SERVICE_SEND_FAILED",
        ));
      });
    });
  }

  /** Find the main isolate; worker isolates are ignored. */
  async getMainIsolateId(): Promise<string> {
    const vm = await this.rpc("getVM");
    const isolates = Array.isArray(vm.isolates) ? vm.isolates : [];
    const entries = isolates.filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null
    );
    const main = entries.find((entry) =>
      typeof entry.name === "string" && entry.name.toLowerCase().includes("main")
    ) ?? entries[0];
    const id = main?.id;
    if (typeof id !== "string") {
      throw new UiTreeUnavailableError(
        "Flutter VM Service returned no isolates.",
        "VM_SERVICE_NO_ISOLATE",
      );
    }
    return id;
  }

  /**
   * Enable the Flutter semantics tree by invoking `ensureSemantics()` on the
   * existing `WidgetsBinding` singleton. The returned handle is kept alive by
   * the VM Service object id (we never dispose it).
   */
  async ensureSemantics(isolateId: string): Promise<void> {
    if (!this.bindingInstanceId) {
      const classes = await this.rpc("getClassList", { isolateId });
      const classEntries = Array.isArray(classes.classes) ? classes.classes : [];
      const candidates = classEntries.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null
      );
      const bindingClass = candidates.find((entry) => entry.name === "WidgetsBinding")
        ?? candidates.find((entry) => entry.name === "WidgetsFlutterBinding")
        ?? candidates.find((entry) => entry.name === "SemanticsBinding");
      const classId = bindingClass?.id;
      if (typeof classId !== "string") {
        throw new UiTreeUnavailableError(
          "Flutter binding class not found; semantics cannot be enabled.",
          "VM_SERVICE_NO_BINDING",
        );
      }
      const instance = await this.rpc("invoke", {
        isolateId,
        targetId: classId,
        selector: "get:instance",
        argumentIds: [],
      });
      const instanceId = instance.id;
      if (typeof instanceId !== "string") {
        throw new UiTreeUnavailableError(
          "Flutter binding instance not found; semantics cannot be enabled.",
          "VM_SERVICE_NO_BINDING_INSTANCE",
        );
      }
      this.bindingInstanceId = instanceId;
    }

    await this.rpc("invoke", {
      isolateId,
      targetId: this.bindingInstanceId,
      selector: "ensureSemantics",
      argumentIds: [],
    });
  }

  /** Dump the semantics tree, enabling semantics first if needed. */
  async dumpSemantics(isolateId: string): Promise<string> {
    const first = await this.semanticsDump(isolateId);
    if (!first.startsWith("Semantics not generated")) return first;

    await this.ensureSemantics(isolateId);
    const second = await this.semanticsDump(isolateId);
    if (!second.startsWith("Semantics not generated")) return second;

    throw new UiTreeUnavailableError(
      "Flutter did not generate a semantics tree. The app may use a release build or semantics are disabled.",
      "SEMANTICS_NOT_GENERATED",
    );
  }

  private async semanticsDump(isolateId: string): Promise<string> {
    const response = await this.rpc(
      "ext.flutter.debugDumpSemanticsTreeInTraversalOrder",
      { isolateId },
    );
    const data = response.data;
    if (typeof data === "string") return data;
    throw new UiTreeUnavailableError(
      "Flutter semantics extension returned no data (release build?).",
      "SEMANTICS_EXTENSION_UNAVAILABLE",
    );
  }
}
