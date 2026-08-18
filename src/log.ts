import { config } from "./config.ts";

/**
 * There is no request log, no access log, and no audit log. Only process-level
 * failures are emitted, and the message must never contain a slug, alias,
 * upstream identifier, pseudonym, token, or IP.
 */
export function logError(event: string, detail?: string): void {
  if (config.logLevel === "off") return;
  process.stderr.write(JSON.stringify({ level: "error", event, detail }) + "\n");
}
