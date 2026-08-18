import { config, HARD } from "../config.ts";
import type { ControlType, UpstreamDevice, UpstreamShare } from "../types.ts";

/**
 * Allowlist of upstream paths. AnonShock is read-plus-control only: it never
 * creates, edits, or deletes upstream shares, shockers, or tokens. Any path not
 * matched here throws before the fetch.
 */
const ALLOWED: RegExp[] = [
  /^\/1$/,
  /^\/1\/public\/shares\/links\/[0-9a-fA-F-]{36}$/,
  /^\/1\/tokens\/self$/,
  /^\/2\/tokens\/self$/,
  /^\/1\/shockers\/own$/,
  /^\/2\/shockers\/control$/,
  /^\/1\/shockers\/control$/,
];

export class UpstreamError extends Error {
  readonly status: number;
  readonly kind: "not_found" | "paused" | "forbidden" | "unauthorized" | "server" | "network";

  constructor(kind: UpstreamError["kind"], status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function classify(status: number): UpstreamError["kind"] {
  if (status === 404) return "not_found";
  if (status === 412) return "paused";
  if (status === 403) return "forbidden";
  if (status === 401) return "unauthorized";
  return "server";
}

interface CallOptions {
  base?: string;
  method?: "GET" | "POST";
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

async function call(opts: CallOptions): Promise<unknown> {
  if (!ALLOWED.some((re) => re.test(opts.path))) {
    throw new Error(`upstream path not allowlisted: ${opts.path.replace(/[0-9a-fA-F-]{36}/, "...")}`);
  }
  const base = (opts.base ?? config.upstreamBase).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    // openshock.app rejects an empty User-Agent with 403.
    "user-agent": config.upstreamUserAgent,
    accept: "application/json",
  };
  if (opts.token) headers["OpenShockToken"] = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.upstreamTimeoutMs);
  let res: Response;
  try {
    res = await fetch(base + opts.path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new UpstreamError("network", 0, "upstream unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Upstream problem bodies carry ids and detail strings. They are never read
    // into anything guest-facing, and never logged.
    throw new UpstreamError(classify(res.status), res.status, `upstream status ${res.status}`);
  }
  const text = await res.text();
  return text.length === 0 ? null : JSON.parse(text);
}

/** GET /1/public/shares/links/{id} -> LegacyDataResponse<PublicShareResponse> */
export async function getPublicShare(shareId: string, base?: string): Promise<UpstreamShare> {
  const json = (await call({ path: `/1/public/shares/links/${shareId}`, base })) as {
    data?: Record<string, unknown>;
  };
  const data = json?.data;
  if (!data) throw new UpstreamError("server", 200, "malformed upstream share payload");

  const devices = Array.isArray(data["devices"]) ? (data["devices"] as Record<string, unknown>[]) : [];
  return {
    id: String(data["id"]),
    name: String(data["name"] ?? ""),
    createdOn: String(data["createdOn"] ?? ""),
    expiresOn: data["expiresOn"] === null || data["expiresOn"] === undefined
      ? null
      : String(data["expiresOn"]),
    devices: devices.map((d) => ({
      id: String(d["id"]),
      name: String(d["name"] ?? ""),
      shockers: (Array.isArray(d["shockers"]) ? (d["shockers"] as Record<string, unknown>[]) : []).map(
        (s) => {
          const perms = (s["permissions"] ?? {}) as Record<string, unknown>;
          const limits = (s["limits"] ?? {}) as Record<string, unknown>;
          return {
            id: String(s["id"]),
            name: String(s["name"] ?? ""),
            permissions: {
              shock: perms["shock"] === true,
              vibrate: perms["vibrate"] === true,
              sound: perms["sound"] === true,
              live: perms["live"] === true,
            },
            limits: {
              intensity: limits["intensity"] === null || limits["intensity"] === undefined
                ? null
                : Number(limits["intensity"]),
              duration: limits["duration"] === null || limits["duration"] === undefined
                ? null
                : Number(limits["duration"]),
            },
            paused: Number(s["paused"] ?? 0),
          };
        },
      ),
    })),
  };
}

export interface TokenSelf {
  permissions: string[];
  paused: boolean;
}

/** GET /1/tokens/self, used to validate a token carries shockers.use. */
export async function getTokenSelf(token: string, base?: string): Promise<TokenSelf> {
  const json = (await call({ path: "/1/tokens/self", token, base })) as Record<string, unknown>;
  const data = (json?.["data"] ?? json) as Record<string, unknown>;
  const perms = Array.isArray(data?.["permissions"]) ? (data["permissions"] as unknown[]) : [];
  return {
    permissions: perms.map(String),
    paused:
      data?.["shockerControlPaused"] === true ||
      data?.["paused"] === true,
  };
}

/** Enumerates only shockers owned by the API-token holder. */
export async function getTokenDevices(token: string, base?: string): Promise<UpstreamDevice[]> {
  const ownJson = await call({ path: "/1/shockers/own", token, base });
  const ownData = ((ownJson as Record<string, unknown>)?.["data"] ?? []) as unknown;
  const devices = new Map<string, UpstreamDevice>();

  const addDevice = (raw: Record<string, unknown>) => {
    const id = String(raw["id"] ?? "");
    if (!id) return;
    const target = devices.get(id) ?? {
      id,
      name: String(raw["name"] ?? ""),
      shockers: [],
    };
    const known = new Set(target.shockers.map((shocker) => shocker.id));
    const shockers = Array.isArray(raw["shockers"])
      ? (raw["shockers"] as Record<string, unknown>[])
      : [];
    for (const shocker of shockers) {
      const shockerId = String(shocker["id"] ?? "");
      if (!shockerId || known.has(shockerId)) continue;
      target.shockers.push({
        id: shockerId,
        name: String(shocker["name"] ?? ""),
        permissions: {
          shock: true,
          vibrate: true,
          sound: true,
          live: true,
        },
        limits: {
          intensity: HARD.maxIntensity,
          duration: HARD.maxDuration,
        },
        paused: shocker["isPaused"] === true ? 1 : 0,
      });
      known.add(shockerId);
    }
    devices.set(id, target);
  };

  if (Array.isArray(ownData)) {
    for (const device of ownData) addDevice(device as Record<string, unknown>);
  }
  return [...devices.values()].filter((device) => device.shockers.length > 0);
}

export interface UpstreamControl {
  id: string;
  type: ControlType;
  intensity: number;
  duration: number;
  exclusive: boolean;
}

/** POST /2/shockers/control, token mode. Falls back to the deprecated v1 shape on 404. */
export async function sendControl(
  token: string,
  shocks: UpstreamControl[],
  customName: string,
  base?: string,
): Promise<void> {
  try {
    await call({
      method: "POST",
      path: "/2/shockers/control",
      token,
      base,
      body: { shocks, customName: customName.slice(0, 64) },
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "not_found" && err.status === 404) {
      await call({ method: "POST", path: "/1/shockers/control", token, base, body: shocks });
      return;
    }
    throw err;
  }
}

export async function upstreamReachable(base?: string): Promise<boolean> {
  try {
    await call({ path: "/1", base, timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}
