import { randomBytes } from "node:crypto";
import { config, HARD } from "../config.ts";
import { logError } from "../log.ts";
import * as q from "../store/queries.ts";
import { isPaused } from "../store/db.ts";
import { ShareHub } from "../upstream/signalr.ts";
import { getPublicShare, sendControl, UpstreamError } from "../upstream/rest.ts";
import {
  buildGuestView,
  effectiveDuration,
  effectiveIntensity,
  emptyUpstreamState,
  upstreamStateFromShare,
  type GuestView,
  type UpstreamState,
} from "./cloak.ts";
import { makeBucket, retryAfter, take, type TokenBucket } from "./limits.ts";
import { newPseudonym } from "./pseudonyms.ts";
import type { ControlCommand, ControlType, LinkDef, ShockerDef } from "../types.ts";

export interface GuestSession {
  id: string;
  pseudonym: string;
  createdAt: number;
  lastSeen: number;
}

export interface ActivityFrame {
  at: number;
  pseudonym: string;
  alias: string;
  type: ControlType;
  intensity: number;
  duration: number;
  ok: boolean;
}

export interface LiveSocket {
  send(data: string): void;
  close(): void;
}

export type DispatchResult =
  | { ok: true; applied: { alias: string; intensity: number; duration: number; clamped: boolean }[] }
  | {
      ok: false;
      status: number;
      type:
        | "invalid_command"
        | "not_permitted"
        | "shocker_paused"
        | "link_dead"
        | "rate_limited"
        | "upstream_unavailable"
        | "instance_paused";
      retryAfter?: number;
    };

const UPSTREAM_REFRESH_MS = 30_000;
/**
 * A stop is never refused and never rate limited: that rule is a safety rule,
 * not a throughput rule. It does mean a guest can ask for the same stop as fast
 * as it can send, so an identical stop repeated inside this window is answered
 * from the one already delivered instead of becoming another upstream call.
 * Nothing is rejected and the guest still gets ok.
 */
const STOP_COALESCE_MS = 250;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const ACTIVITY_RING = 20;

export class LinkRoom {
  link: LinkDef;
  killed: boolean;
  sessions = new Map<string, GuestSession>();
  #buckets = new Map<string, TokenBucket>();
  #lastFire = new Map<string, number>();
  #lastStop = new Map<string, number>();
  #sockets = new Set<LiveSocket>();
  #recent: ActivityFrame[] = [];
  #upstream: UpstreamState = emptyUpstreamState();
  #upstreamFetchedAt = 0;
  #upstreamInflight: Promise<void> | null = null;
  #hub: ShareHub | null = null;
  #breaker = { openUntil: 0, failures: 0 };
  lastTouched = Date.now();

  constructor(link: LinkDef) {
    this.link = link;
    this.killed = link.status === "killed";
  }

  get id(): string {
    return this.link.id;
  }

  touch(): void {
    this.lastTouched = Date.now();
  }

  get guestCount(): number {
    return this.sessions.size;
  }

  /* ------------------------------------------------------------ sessions */

  createSession(): GuestSession {
    if (this.sessions.size >= config.maxSessionsPerRoom) this.#evictOldestSession();
    const taken = new Set([...this.sessions.values()].map((s) => s.pseudonym));
    const session: GuestSession = {
      id: randomBytes(16).toString("base64url"),
      pseudonym: newPseudonym(taken),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.broadcastState();
    return session;
  }

  getSession(id: string | undefined): GuestSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    s.lastSeen = Date.now();
    return s;
  }

  #dropSession(id: string): void {
    this.sessions.delete(id);
    // The bucket outlived the session it belonged to, so the map only ever grew.
    this.#buckets.delete(`s:${id}`);
  }

  #evictOldestSession(): void {
    let oldest: GuestSession | null = null;
    for (const s of this.sessions.values()) {
      if (!oldest || s.lastSeen < oldest.lastSeen) oldest = s;
    }
    if (oldest) this.#dropSession(oldest.id);
  }

  pruneSessions(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS) this.#dropSession(id);
    }
  }

  /* ----------------------------------------------------------- live feed */

  addSocket(socket: LiveSocket): boolean {
    if (this.#sockets.size >= config.maxSocketsPerRoom) return false;
    this.#sockets.add(socket);
    socket.send(JSON.stringify({ t: "state", status: this.publicStatus(), guests: this.guestCount }));
    for (const frame of this.#recent) socket.send(JSON.stringify({ t: "activity", ...frame }));
    return true;
  }

  removeSocket(socket: LiveSocket): void {
    this.#sockets.delete(socket);
  }

  #broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const socket of this.#sockets) {
      try {
        socket.send(data);
      } catch {
        this.#sockets.delete(socket);
      }
    }
  }

  broadcastState(): void {
    this.#broadcast({ t: "state", status: this.publicStatus(), guests: this.guestCount });
  }

  publicStatus(): string {
    if (this.link.expiresAt <= Date.now()) return "expired";
    if (this.killed) return "paused";
    return this.link.status === "active" ? "active" : "dead";
  }

  /* ------------------------------------------------------------- upstream */

  async refreshUpstream(force = false): Promise<void> {
    if (this.link.mode !== "share" || !this.link.upstreamShareId) return;
    const fresh = Date.now() - this.#upstreamFetchedAt < UPSTREAM_REFRESH_MS;
    if (!force && fresh) return;
    if (this.#upstreamInflight) return this.#upstreamInflight;

    this.#upstreamInflight = (async () => {
      try {
        const share = await getPublicShare(this.link.upstreamShareId!, this.link.upstreamBase);
        this.#upstream = upstreamStateFromShare(share);
        this.#upstreamFetchedAt = Date.now();
        this.#breaker = { openUntil: 0, failures: 0 };
      } catch (err) {
        if (err instanceof UpstreamError && err.kind === "not_found") {
          this.link.status = "dead_upstream";
          q.setLinkStatus(this.link.id, "dead_upstream");
          this.#upstream = { byId: new Map(), dead: true };
          this.#broadcast({ t: "dead", reason: "upstream" });
        } else {
          this.#tripBreaker();
        }
      } finally {
        this.#upstreamInflight = null;
      }
    })();
    return this.#upstreamInflight;
  }

  #tripBreaker(): void {
    this.#breaker.failures += 1;
    if (this.#breaker.failures >= 3) this.#breaker.openUntil = Date.now() + 30_000;
  }

  #breakerOpen(): boolean {
    return Date.now() < this.#breaker.openUntil;
  }

  /* -------------------------------------------------------------- control */

  #bucket(key: string, perMinute: number, burst?: number): TokenBucket {
    let b = this.#buckets.get(key);
    if (!b) {
      b = makeBucket(perMinute, burst);
      this.#buckets.set(key, b);
    }
    return b;
  }

  #shocker(alias: string): ShockerDef | undefined {
    return this.link.shockers.find((s) => s.alias === alias && !s.hidden);
  }

  #allows(shocker: ShockerDef, type: ControlType): boolean {
    if (type === "Stop") return true;
    const up = this.#upstream.byId.get(shocker.upstreamId);
    if (type === "Shock") return shocker.allowShock && (up?.allowShock ?? true);
    if (type === "Vibrate") return shocker.allowVibrate && (up?.allowVibrate ?? true);
    return shocker.allowSound && (up?.allowSound ?? true);
  }

  /**
   * Every rejection path runs before the upstream call, so a hostile guest
   * cannot use AnonShock to fan out load onto OpenShock.
   */
  async dispatch(session: GuestSession, commands: ControlCommand[]): Promise<DispatchResult> {
    this.touch();
    const now = Date.now();
    const allStop = commands.every((c) => c.type === "Stop");

    if (isPaused() && !allStop) return { ok: false, status: 503, type: "instance_paused" };
    if (this.link.expiresAt <= now) return { ok: false, status: 410, type: "link_dead" };
    if (this.link.status === "dead_upstream" || this.link.status === "needs_reauth") {
      return { ok: false, status: 410, type: "link_dead" };
    }
    // A stop must always be deliverable, so it bypasses the kill latch and the limits.
    if (this.killed && !allStop) return { ok: false, status: 410, type: "link_dead" };

    await this.refreshUpstream();

    const resolved: { shocker: ShockerDef; cmd: ControlCommand; clamped: boolean }[] = [];
    for (const cmd of commands) {
      const shocker = this.#shocker(cmd.alias);
      // Unknown, hidden, and forbidden aliases are indistinguishable by design.
      if (!shocker) return { ok: false, status: 403, type: "not_permitted" };
      if (!this.#allows(shocker, cmd.type)) return { ok: false, status: 403, type: "not_permitted" };

      const up = this.#upstream.byId.get(shocker.upstreamId);
      if (cmd.type !== "Stop" && (up?.paused ?? 0) !== 0) {
        return { ok: false, status: 409, type: "shocker_paused" };
      }

      const maxI = effectiveIntensity(shocker, up?.maxIntensity ?? null);
      const maxD = effectiveDuration(shocker, up?.maxDuration ?? null);
      const intensity = Math.max(HARD.minIntensity, Math.min(cmd.intensity, maxI));
      const duration = Math.max(HARD.minDuration, Math.min(cmd.duration, maxD));
      const clamped = intensity !== cmd.intensity || duration !== cmd.duration;
      resolved.push({ shocker, cmd: { ...cmd, intensity, duration }, clamped });
    }

    if (!allStop) {
      if (this.link.rlPerGuestPerMin > 0) {
        const guestBucket = this.#bucket(`s:${session.id}`, this.link.rlPerGuestPerMin, 3);
        if (!take(guestBucket, now)) {
          return { ok: false, status: 429, type: "rate_limited", retryAfter: retryAfter(guestBucket, now) };
        }
      }
      if (this.link.rlPerLinkPerMin > 0) {
        const linkBucket = this.#bucket("__link__", this.link.rlPerLinkPerMin);
        if (!take(linkBucket, now)) {
          return { ok: false, status: 429, type: "rate_limited", retryAfter: retryAfter(linkBucket, now) };
        }
      }
      for (const { shocker } of resolved) {
        const last = this.#lastFire.get(shocker.alias) ?? 0;
        if (shocker.cooldownMs > 0 && now - last < shocker.cooldownMs) {
          return {
            ok: false,
            status: 429,
            type: "rate_limited",
            retryAfter: Math.ceil((shocker.cooldownMs - (now - last)) / 1000),
          };
        }
      }
    }

    if (this.#breakerOpen()) return { ok: false, status: 503, type: "upstream_unavailable" };

    // An identical stop that upstream already has is not sent twice.
    const outgoing = allStop
      ? resolved.filter((r) => now - (this.#lastStop.get(r.shocker.alias) ?? 0) >= STOP_COALESCE_MS)
      : resolved;
    if (allStop) {
      for (const { shocker } of resolved) this.#lastStop.set(shocker.alias, now);
      if (outgoing.length === 0) {
        this.#record(session, resolved, true);
        return {
          ok: true,
          applied: resolved.map((r) => ({
            alias: r.shocker.alias,
            intensity: r.cmd.intensity,
            duration: r.cmd.duration,
            clamped: r.clamped,
          })),
        };
      }
    }

    try {
      await this.#send(outgoing.map((r) => ({ ...r.cmd, upstreamId: r.shocker.upstreamId })));
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (err.kind === "unauthorized") {
          this.link.status = "needs_reauth";
          q.setLinkStatus(this.link.id, "needs_reauth");
        }
        // Token mode has no share document to read pause state from, so an
        // upstream 412 is the first and only sign that a shocker is paused.
        if (err.kind === "paused") {
          this.#record(session, resolved, false);
          return { ok: false, status: 409, type: "shocker_paused" };
        }
        if (err.kind === "forbidden") {
          this.#record(session, resolved, false);
          return { ok: false, status: 403, type: "not_permitted" };
        }
      }
      this.#tripBreaker();
      this.#record(session, resolved, false);
      return { ok: false, status: 503, type: "upstream_unavailable" };
    }

    if (!allStop) for (const { shocker } of resolved) this.#lastFire.set(shocker.alias, now);
    this.#record(session, resolved, true);

    return {
      ok: true,
      applied: resolved.map((r) => ({
        alias: r.shocker.alias,
        intensity: r.cmd.intensity,
        duration: r.cmd.duration,
        clamped: r.clamped,
      })),
    };
  }

  async #send(items: (ControlCommand & { upstreamId: string })[]): Promise<void> {
    const shocks = items.map((i) => ({
      id: i.upstreamId,
      type: i.type,
      intensity: i.intensity,
      duration: i.duration,
      exclusive: false,
    }));

    if (this.link.mode === "token") {
      if (!this.link.upstreamToken) throw new UpstreamError("unauthorized", 401, "no token");
      await sendControl(this.link.upstreamToken, shocks, "AnonShock", this.link.upstreamBase);
      return;
    }

    if (!this.link.upstreamShareId) throw new UpstreamError("server", 0, "no share id");
    if (!this.#hub) {
      this.#hub = new ShareHub({
        base: this.link.upstreamBase,
        shareId: this.link.upstreamShareId,
        // A per-link constant, never a guest-supplied value: the owner's
        // upstream control log must not become a guest identity leak.
        name: "AnonShock",
        onEvent: (event) => {
          if (event.t === "updated") void this.refreshUpstream(true);
        },
      });
    }
    await this.#hub.control(shocks);
  }

  #record(
    session: GuestSession,
    resolved: { shocker: ShockerDef; cmd: ControlCommand }[],
    ok: boolean,
  ): void {
    // Memory only. There is no control_log table and no history endpoint.
    for (const { shocker, cmd } of resolved) {
      const frame: ActivityFrame = {
        at: Date.now(),
        pseudonym: session.pseudonym,
        alias: shocker.alias,
        type: cmd.type,
        intensity: cmd.intensity,
        duration: cmd.duration,
        ok,
      };
      this.#recent.push(frame);
      if (this.#recent.length > ACTIVITY_RING) this.#recent.shift();
      this.#broadcast({ t: "activity", ...frame });
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  async view(): Promise<GuestView> {
    this.touch();
    await this.refreshUpstream();
    return buildGuestView(this.link, this.#upstream, this.guestCount);
  }

  /** Kill latch: stop everything, then refuse further control. */
  async kill(): Promise<void> {
    this.killed = true;
    this.link.status = "killed";
    q.setLinkStatus(this.link.id, "killed");
    await this.stopAll();
    this.#broadcast({ t: "state", status: "paused", guests: this.guestCount });
  }

  /** Only a killed link resumes. A dead or unauthorised one needs a refresh. */
  resume(): boolean {
    if (this.link.status !== "killed") return false;
    this.killed = false;
    this.link.status = "active";
    q.setLinkStatus(this.link.id, "active");
    this.broadcastState();
    return true;
  }

  async stopAll(): Promise<void> {
    const targets = this.link.shockers.filter((s) => !s.hidden);
    if (targets.length === 0) return;
    try {
      await this.#send(
        targets.map((s) => ({
          alias: s.alias,
          type: "Stop" as const,
          intensity: 0,
          duration: HARD.minDuration,
          exclusive: false,
          upstreamId: s.upstreamId,
        })),
      );
    } catch {
      logError("stop_all_failed");
    }
  }

  /** Called by the sweeper: drop an upstream socket nobody is using. */
  closeIdleUpstream(now = Date.now()): void {
    if (!this.#hub) return;
    const idle = now - this.#hub.lastUsed > config.upstreamIdleTimeoutMs;
    if (idle && this.guestCount === 0) {
      this.#hub.close();
      this.#hub = null;
    }
  }

  reload(link: LinkDef): void {
    if (this.link.rlPerGuestPerMin !== link.rlPerGuestPerMin) {
      for (const key of this.#buckets.keys()) {
        if (key.startsWith("s:")) this.#buckets.delete(key);
      }
    }
    if (this.link.rlPerLinkPerMin !== link.rlPerLinkPerMin) this.#buckets.delete("__link__");
    this.link = link;
    this.killed = link.status === "killed";
    this.#upstreamFetchedAt = 0;
  }

  dispose(): void {
    this.#hub?.close();
    this.#hub = null;
    for (const socket of this.#sockets) {
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
    this.#sockets.clear();
    this.sessions.clear();
    this.#buckets.clear();
    this.#lastStop.clear();
    this.#recent = [];
    // The token is decrypted only into room memory; drop the reference on eviction.
    if (this.link.upstreamToken) this.link.upstreamToken = undefined;
  }
}
