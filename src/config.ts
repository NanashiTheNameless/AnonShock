import { randomBytes } from "node:crypto";

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`environment variable ${name} is not an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const normalized = v.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`environment variable ${name} must be true or false`);
}

function key32(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) {
    if (process.env.NODE_ENV === "test") return randomBytes(32);
    throw new Error(`missing required secret ${name} (generate with: openssl rand -base64 32)`);
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return buf;
}

const publicOrigin = str("PUBLIC_ORIGIN", "http://localhost:8080").replace(/\/+$/, "");
const appVersion = str("APP_VERSION", "0.0.1").trim();
export const OFFICIAL_REPOSITORY = "https://github.com/NanashiTheNameless/AnonShock";
const isFork = bool("IS_FORK", false);
const gitRepoUrl = str("GIT_REPO_URL", OFFICIAL_REPOSITORY).replace(/\/+$/, "");
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(appVersion)) {
  throw new Error("APP_VERSION must contain only letters, numbers, dots, underscores, or hyphens");
}
let repositoryUrl: URL;
try {
  repositoryUrl = new URL(gitRepoUrl);
} catch {
  throw new Error("GIT_REPO_URL must be a complete http:// or https:// URL");
}
if (!["http:", "https:"].includes(repositoryUrl.protocol)) {
  throw new Error("GIT_REPO_URL must be a complete http:// or https:// URL");
}

export const config = {
  port: int("PORT", 8080),
  socketPath: str("SOCKET_PATH", ""),
  publicOrigin,
  isFork,
  gitRepoUrl,
  trustProxy: str("TRUST_PROXY", "cloudflare"),

  upstreamBase: str("UPSTREAM_BASE", "https://api.openshock.app").replace(/\/+$/, ""),
  upstreamUserAgent: `AnonShock/${appVersion} (+${publicOrigin})`,
  upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 5000),

  dbPath: str("DB_PATH", "/data/anonshock.db"),
  storeKey: key32("STORE_KEY"),
  tokenPepper: key32("TOKEN_PEPPER"),

  logLevel: str("LOG_LEVEL", "error"),
  holderCookieDays: int("HOLDER_COOKIE_DAYS", 90),

  maxLinkTtlSeconds: int("MAX_LINK_TTL_SECONDS", 604800),
  roomIdleTtlSeconds: int("ROOM_IDLE_TTL_SECONDS", 3600),
  upstreamIdleTimeoutMs: int("UPSTREAM_IDLE_TIMEOUT_MS", 120_000),

  maxRooms: int("MAX_ROOMS", 500),
  maxLinks: int("MAX_LINKS", 2000),
  maxLinksPerHolder: int("MAX_LINKS_PER_HOLDER", 20),
  maxLinksPerIpPerDay: int("MAX_LINKS_PER_IP_PER_DAY", 10),
  maxSessionsPerIpPer10Min: int("MAX_SESSIONS_PER_IP_PER_10MIN", 5),
  maxShockersPerLink: int("MAX_SHOCKERS_PER_LINK", 128),
  maxSessionsPerRoom: int("MAX_SESSIONS_PER_ROOM", 200),
  maxSocketsPerRoom: int("MAX_SOCKETS_PER_ROOM", 200),

  instanceMaxIntensity: int("INSTANCE_MAX_INTENSITY", 100),
  instanceMaxDuration: int("INSTANCE_MAX_DURATION", 30_000),

  allowTokenMode: bool("ALLOW_TOKEN_MODE", true),

  // Altcha is a self-hosted proof-of-work bot check: the challenge is issued and
  // verified by this instance, so no third party is contacted and the content
  // security policy needs no exception. Without a key the check is disabled.
  altchaHmacKey: str("ALTCHA_HMAC_KEY", ""),
  altchaCost: int("ALTCHA_COST", 10_000),
  altchaExpirySeconds: int("ALTCHA_EXPIRY_SECONDS", 300),
} as const;

if (process.env.NODE_ENV === "production") {
  if (new URL(config.publicOrigin).protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use https:// in production");
  }
  if (new URL(config.upstreamBase).protocol !== "https:") {
    throw new Error("UPSTREAM_BASE must use https:// in production");
  }
  if (repositoryUrl.protocol !== "https:") {
    throw new Error("GIT_REPO_URL must use https:// in production");
  }
  if (!config.socketPath.startsWith("/")) {
    throw new Error("SOCKET_PATH must be an absolute Unix-socket path in production");
  }
}

export function botCheckAvailable(): boolean {
  return config.altchaHmacKey !== "";
}

export const HARD = {
  minIntensity: 0,
  maxIntensity: 100,
  minDuration: 300,
  maxDuration: 65535,
  maxCustomName: 64,
  maxHubName: 32,
} as const;
