import { WebSocket as WsClient } from "ws";
import { config, HARD } from "../config.ts";
import type { ControlType } from "../types.ts";

/**
 * Minimal SignalR client for the OpenShock public share hub:
 *   {base}/1/hubs/share/link/{publicShareId}
 *
 * Guest connections must supply ?name= (max 32 chars) or the server aborts the
 * connection. The hub's Control method returns no acknowledgement, so a send
 * here means "accepted for delivery", never "delivered".
 */

/** SignalR record separator, 0x1E. */
const RS = "\u001e";

export interface HubControl {
  id: string;
  type: ControlType;
  intensity: number;
  duration: number;
  exclusive: boolean;
}

export type HubEvent = { t: "welcome"; guest: boolean } | { t: "updated" } | { t: "closed" };

export interface ShareHubOptions {
  base: string;
  shareId: string;
  name: string;
  onEvent?: (event: HubEvent) => void;
}

interface NegotiateResponse {
  connectionToken?: string;
  connectionId?: string;
  availableTransports?: { transport: string }[];
  error?: string;
}

export class ShareHub {
  #opts: ShareHubOptions;
  #ws: WsClient | null = null;
  #ready: Promise<void> | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #closed = false;
  lastUsed = Date.now();

  constructor(opts: ShareHubOptions) {
    this.#opts = { ...opts, name: opts.name.slice(0, HARD.maxHubName) };
  }

  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WsClient.OPEN;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("hub closed");
    if (this.connected) return;
    if (this.#ready) return this.#ready;
    this.#ready = this.#doConnect().finally(() => {
      this.#ready = null;
    });
    return this.#ready;
  }

  async #doConnect(): Promise<void> {
    const hubUrl = `${this.#opts.base.replace(/\/+$/, "")}/1/hubs/share/link/${this.#opts.shareId}`;
    const name = encodeURIComponent(this.#opts.name);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    let negotiated: NegotiateResponse;
    try {
      const res = await fetch(`${hubUrl}/negotiate?negotiateVersion=1&name=${name}`, {
        method: "POST",
        headers: { "user-agent": config.upstreamUserAgent, "content-length": "0" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`negotiate status ${res.status}`);
      negotiated = (await res.json()) as NegotiateResponse;
    } finally {
      clearTimeout(timer);
    }

    const transports = (negotiated.availableTransports ?? []).map((t) => t.transport);
    if (transports.length > 0 && !transports.includes("WebSockets")) {
      throw new Error("upstream hub does not offer the WebSockets transport");
    }
    const token = negotiated.connectionToken ?? negotiated.connectionId;
    if (!token) throw new Error("negotiate returned no connection token");

    const wsUrl =
      hubUrl.replace(/^http/, "ws") + `?id=${encodeURIComponent(token)}&name=${name}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WsClient(wsUrl, { headers: { "user-agent": config.upstreamUserAgent } });
      const failed = (err: Error) => {
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          // already closing
        }
        reject(err);
      };
      const openTimer = setTimeout(
        () => failed(new Error("hub handshake timed out")),
        config.upstreamTimeoutMs,
      );

      ws.on("open", () => {
        ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      });

      ws.on("message", (raw) => {
        for (const frame of String(raw).split(RS)) {
          if (frame.length === 0) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(frame) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (Object.keys(msg).length === 0) {
            // Empty object is the handshake response: the connection is usable.
            clearTimeout(openTimer);
            this.#ws = ws;
            this.#startPing();
            resolve();
            continue;
          }
          if (msg["error"]) {
            clearTimeout(openTimer);
            failed(new Error("hub handshake rejected"));
            continue;
          }
          if (msg["type"] === 1) {
            const target = String(msg["target"] ?? "");
            const args = (msg["arguments"] ?? []) as unknown[];
            if (target === "Welcome") {
              this.#opts.onEvent?.({ t: "welcome", guest: Number(args[0] ?? 1) === 1 });
            } else if (target === "Updated") {
              this.#opts.onEvent?.({ t: "updated" });
            }
          }
        }
      });

      ws.on("error", () => {
        clearTimeout(openTimer);
        if (this.#ws === ws) this.#ws = null;
        failed(new Error("hub connection error"));
      });

      ws.on("close", () => {
        clearTimeout(openTimer);
        if (this.#ws === ws) {
          this.#ws = null;
          this.#stopPing();
          this.#opts.onEvent?.({ t: "closed" });
        }
      });
    });
  }

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (this.connected) this.#ws!.send(JSON.stringify({ type: 6 }) + RS);
    }, 15_000);
    this.#pingTimer.unref?.();
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  /**
   * Fire-and-forget invocation of the hub's Control method. Upstream sends no
   * completion message, so there is nothing to await beyond the socket write.
   */
  async control(shocks: HubControl[]): Promise<void> {
    await this.connect();
    if (!this.connected) throw new Error("hub not connected");
    this.lastUsed = Date.now();
    this.#ws!.send(JSON.stringify({ type: 1, target: "Control", arguments: [shocks] }) + RS);
  }

  close(): void {
    this.#closed = true;
    this.#stopPing();
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // already closing
      }
      this.#ws = null;
    }
  }
}
