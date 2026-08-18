import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { config, OFFICIAL_REPOSITORY } from "../config.ts";
import { containsUpstreamIdentifier } from "../core/scrub.ts";
import { hashIp } from "../core/limits.ts";
import { logError } from "../log.ts";

export const GUEST_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "permissions-policy": "geolocation=(), camera=(), microphone=()",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "strict-transport-security": "max-age=31536000",
};

/**
 * Nothing this page loads comes from anywhere else, and nothing inline is
 * blanket-allowed. The vendored ALTCHA widget needs two things that would
 * normally force an exception, and both are avoided rather than permitted:
 *
 *  - it injects one <style> element, so it is handed a per-response nonce
 *    (it reads `meta[name="csp-nonce"]` itself) instead of 'unsafe-inline';
 *  - it would build its hashing workers from blob: URLs, so public/altcha.js
 *    registers same-origin worker files over the defaults instead of blob:.
 */
export function csp(nonce?: string): string {
  return [
    "default-src 'self'",
    "img-src 'none'",
    "script-src 'self'",
    nonce ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self'",
    "font-src 'self'",
    "worker-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Slot that `page()` writes and `html()` fills with the response's nonce. */
export const NONCE_SLOT = "__CSP_NONCE__";

export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The real client IP arrives from the tunnel as CF-Connecting-IP.
 * X-Forwarded-For is ignored: it is spoofable if anything else reaches the port.
 */
export function clientIpHash(c: Context): string {
  const ip = c.req.header("cf-connecting-ip") ?? (config.trustProxy === "cloudflare" ? "" : "direct");
  return hashIp(ip || "unknown");
}

/**
 * Final filter on every guest-facing body. A handler should never build a body
 * containing an upstream identifier; if one ever does, this turns a
 * deanonymization into a 500.
 */
export function guestJson(c: Context, body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  if (containsUpstreamIdentifier(text)) {
    logError("scrub_blocked_response");
    return new Response(JSON.stringify({ type: "server_error" }), {
      status: 500,
      headers: { ...GUEST_HEADERS, "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(text, {
    status,
    headers: {
      ...GUEST_HEADERS,
      "content-security-policy": csp(),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function problem(
  c: Context,
  status: number,
  type: string,
  extra?: Record<string, unknown>,
): Response {
  const headers: Record<string, string> = {
    ...GUEST_HEADERS,
    "content-type": "application/problem+json; charset=utf-8",
  };
  if (extra?.["retryAfter"] !== undefined) headers["retry-after"] = String(extra["retryAfter"]);
  return new Response(JSON.stringify({ type, status, ...extra }), { status, headers });
}

export function html(c: Context, markup: string, status = 200): Response {
  // One fresh nonce per response. Pages are no-store, so nothing caches it.
  const nonce = newNonce();
  return new Response(markup.replaceAll(NONCE_SLOT, nonce), {
    status,
    headers: {
      ...GUEST_HEADERS,
      "content-security-policy": csp(nonce),
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** Unknown, expired, killed, and deleted slugs are indistinguishable. */
export function deadLinkPage(c: Context): Response {
  return html(
    c,
    page(
      "Link not found",
      `<h1>Link not found</h1>
       <p>This link does not exist, or it has expired, or the person who made it ended it.</p>
       <p>Nothing else can be said about it from here.</p>`,
    ),
    404,
  );
}

export function cookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(c: Context, name: string): string | undefined {
  const raw = c.req.header("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Server-rendered shell. No images, no icons, no external assets. */
export function page(title: string, body: string, opts?: { script?: string }): string {
  const repository = escapeHtml(config.gitRepoUrl);
  const sourceCredit = config.isFork
    ? `This instance runs a fork. <a href="${repository}" rel="noreferrer noopener" target="_blank">View this fork's source</a>. <a href="${OFFICIAL_REPOSITORY}" rel="noreferrer noopener" target="_blank">View the original repository</a>.`
    : `<a href="${repository}" rel="noreferrer noopener" target="_blank">View the AnonShock repository on GitHub</a>.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="csp-nonce" content="${NONCE_SLOT}">
<meta name="theme-color" content="#16161D">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${escapeHtml(title === "AnonShock" ? title : `${title} - AnonShock`)}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/vendor/altcha-business.min.css">
</head>
<body>
<header class="site-header">
  <a class="site-brand" href="/">AnonShock</a>
  <nav aria-label="Site navigation">
    <a href="/">Home</a>
    <a href="/new">Make a link</a>
    <a href="/links">Your links</a>
    <a href="/safety">Safety</a>
    <a href="${repository}" rel="noreferrer noopener" target="_blank">${config.isFork ? "Fork source" : "GitHub"}</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
<p>AnonShock hides who owns these devices. It does not hide you. No logs, no history, no accounts.</p>
<p>Created by <a href="https://github.com/NanashiTheNameless" rel="noreferrer noopener" target="_blank">NanashiTheNameless</a>. ${sourceCredit}</p>
<p><a href="/acknowledgements">Open Source Acknowledgements</a></p>
</footer>
${opts?.script ? `<script type="module" src="${opts.script}"></script>` : ""}
</body>
</html>`;
}
