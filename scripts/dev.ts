import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Local development runner.
 *
 * Starts a mock OpenShock and the app together, so the whole flow (create a
 * link, open it as a guest, press a button) can be exercised without a real
 * share, real hardware, or a tunnel.
 *
 *   yarn dev            against the mock upstream (default)
 *   yarn dev --real     against api.openshock.app, for a real share link
 *
 * Dev keys are generated once into .env.dev and reused, because changing
 * STORE_KEY makes an existing store unreadable.
 */

const useReal = process.argv.includes("--real");
const port = Number(process.env["PORT"] ?? 8080);
const mockPort = 4010;

function devEnv(): Record<string, string> {
  if (!existsSync(".env.dev")) {
    const generated = [
      `STORE_KEY=${randomBytes(32).toString("base64")}`,
      `TOKEN_PEPPER=${randomBytes(32).toString("base64")}`,
      `ALTCHA_HMAC_KEY=${randomBytes(32).toString("base64")}`,
      "",
    ].join("\n");
    writeFileSync(".env.dev", generated, { mode: 0o600 });
    process.stdout.write("generated .env.dev with fresh dev keys\n");
  }
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(".env.dev", "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

mkdirSync("data", { recursive: true });
Object.assign(process.env, devEnv());
process.env["DB_PATH"] ??= "data/dev.db";
process.env["PUBLIC_ORIGIN"] ??= `http://localhost:${port}`;
process.env["PORT"] = String(port);
process.env["LOG_LEVEL"] ??= "error";
// Local requests carry no CF-Connecting-IP; keep the dev limits out of the way.
process.env["MAX_LINKS_PER_IP_PER_DAY"] ??= "1000";
process.env["MAX_SESSIONS_PER_IP_PER_10MIN"] ??= "1000";
// Keep the proof of work quick on a laptop.
process.env["ALTCHA_COST"] ??= "2000";

let shareUrl = "";

if (useReal) {
  process.env["UPSTREAM_BASE"] ??= "https://api.openshock.app";
} else {
  const { startMockUpstream, SENTINEL } = await import("../test/mock-upstream.ts");
  const mock = await startMockUpstream();
  process.env["UPSTREAM_BASE"] = mock.url;
  shareUrl = `https://openshock.app/public/shares/links/${SENTINEL.shareId}`;
  process.stdout.write(`mock OpenShock listening on ${mock.url}\n`);
  void mockPort;
}

const { start } = await import("../src/server.ts");
start();

const origin = process.env["PUBLIC_ORIGIN"];
process.stdout.write(
  [
    "",
    `AnonShock is running at ${origin}`,
    "",
    useReal
      ? "Upstream: api.openshock.app. Paste a real public share link at /new."
      : [
          "Upstream: the mock, so nothing real gets shocked.",
          "",
          "Paste this into the share field at /new:",
          `  ${shareUrl}`,
          "",
          "The mock offers one hub with two shockers:",
          "  ZZSHOCKERAZZ  vibrate, sound, shock   up to intensity 60, 10.0s",
          "  ZZSHOCKERBZZ  vibrate only            up to intensity 100, 5.0s",
        ].join("\n"),
    "",
    `Pages: ${origin}/  ${origin}/new  ${origin}/links`,
    "Stop with Ctrl-C. Delete data/dev.db to start over.",
    "",
  ].join("\n"),
);
