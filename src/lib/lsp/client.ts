// Minimal JSON-RPC client for a language server whose stdio is bridged by
// the Rust side (src-tauri/src/lsp.rs).
import { api, onLspEvent } from "../ipc";

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

export class LspError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const clients = new Map<number, LspClient>();
let routing: Promise<unknown> | null = null;

function startRouting() {
  routing ??= onLspEvent((e) => {
    const c = clients.get(e.server);
    if (!c) return;
    if (e.t === "exit") c.handleExit();
    else c.handleMessage(e.message as RpcMessage);
  });
  return routing;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private exitHandlers: (() => void)[] = [];
  alive = true;

  private constructor(readonly serverId: number) {}

  static async attach(serverId: number): Promise<LspClient> {
    await startRouting();
    const c = new LspClient(serverId);
    clients.set(serverId, c);
    return c;
  }

  onRequest(method: string, h: RequestHandler): void {
    this.requestHandlers.set(method, h);
  }

  onNotification(method: string, h: NotificationHandler): void {
    this.notificationHandlers.set(method, h);
  }

  onExit(h: () => void): void {
    this.exitHandlers.push(h);
  }

  request<T>(method: string, params: unknown, token?: { onCancellationRequested(cb: () => void): unknown }): Promise<T> {
    if (!this.alive) return Promise.reject(new LspError("language server stopped", -32099));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      token?.onCancellationRequested(() => {
        if (this.pending.has(id)) void this.notify("$/cancelRequest", { id });
      });
      api.lspSend(this.serverId, { jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (!this.alive) return Promise.resolve();
    return api.lspSend(this.serverId, { jsonrpc: "2.0", method, params }).catch(() => {});
  }

  handleMessage(m: RpcMessage): void {
    if (m.method !== undefined && m.id !== undefined) {
      void this.answer(m);
    } else if (m.method !== undefined) {
      this.notificationHandlers.get(m.method)?.(m.params);
    } else if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new LspError(m.error.message, m.error.code));
      else p.resolve(m.result ?? null);
    }
  }

  private async answer(m: RpcMessage) {
    const h = this.requestHandlers.get(m.method!);
    let reply: RpcMessage;
    try {
      // Unknown server requests get `null`, which servers treat as "not supported".
      reply = { jsonrpc: "2.0", id: m.id, result: h ? ((await h(m.params)) ?? null) : null };
    } catch (e) {
      reply = { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
    await api.lspSend(this.serverId, reply).catch(() => {});
  }

  handleExit(): void {
    this.alive = false;
    clients.delete(this.serverId);
    for (const p of this.pending.values()) p.reject(new LspError("language server exited", -32099));
    this.pending.clear();
    this.exitHandlers.forEach((h) => h());
  }

  async shutdown(): Promise<void> {
    if (this.alive) {
      await Promise.race([this.request("shutdown", null).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      await this.notify("exit", null);
    }
    await api.lspStop(this.serverId).catch(() => {});
    this.handleExit();
  }
}
