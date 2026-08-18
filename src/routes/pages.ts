import { Hono } from "hono";
import { botCheckAvailable } from "../config.ts";
import { createChallenge } from "../core/altcha.ts";
import { html, page } from "./http.ts";

export const pages = new Hono();

pages.get("/", (c) =>
  html(
    c,
    page(
      "AnonShock",
      `<h1>AnonShock</h1>
<p>An anonymizing proxy for OpenShock public share links. It re-serves a share as a page where the
owner's username, the hub names, the shocker names, and every upstream identifier are replaced by
aliases that mean nothing anywhere else.</p>

<nav class="home-actions" aria-label="Get started">
  <p class="home-actions-title">Get started</p>
  <div class="home-primary-actions">
    <a class="primary" href="/new">Make a link</a>
    <a href="/links">Links from this browser</a>
  </div>
  <div class="home-reference-actions">
    <span>Before using AnonShock:</span>
    <a href="/safety">Safety</a>
    <a href="/privacy">Privacy</a>
  </div>
</nav>

<h2>What it hides</h2>
<ul>
  <li>The OpenShock username of whoever owns the devices.</li>
  <li>Their avatar, which upstream derives from a hash of their email address.</li>
  <li>The hub and shocker names, which are often intimate or say where someone lives.</li>
  <li>Every upstream identifier, including the share id, so a guest cannot go around this site.</li>
</ul>

<h2>What it does not hide</h2>
<ul>
  <li>You, from the device owner. OpenShock logs every command on their side, whatever this site does.</li>
  <li>You, from the network. This instance and Cloudflare both see your IP address while you are here.</li>
</ul>

<h2>What it keeps</h2>
<p>Link settings, until the link expires. Nothing else: no control history, no audit log, no request
log, no accounts. Who pressed what is a question this software cannot answer.</p>`,
    ),
  ),
);

pages.get("/new", (c) => {
  return html(
    c,
    page(
      "Make a link",
      `<h1>Make a link</h1>
<p class="note">Every setting has to be filled in before the link is created. There are no hidden
defaults: each shocker is configured deliberately, or explicitly hidden.</p>
<div id="create"${botCheckAvailable() ? ' data-botcheck="1"' : ""}>
  <p>Loading...</p>
</div>
<noscript><p>This page needs JavaScript.</p></noscript>`,
      { script: "/assets/create.js" },
    ),
  );
});

pages.get("/safety", (c) =>
  html(
    c,
    page(
      "Safety",
      `<h1>Safety</h1>
<p>These devices are attached to a person. Anonymity is not a reason to be careless with them.</p>
<section class="safety-callout">
  <h2>Read the OpenShock safety rules</h2>
  <p>This page is only an AnonShock-specific overview. Read and follow OpenShock's complete safety
  rules before wearing a device, creating a link, or sending a command.</p>
  <a href="https://wiki.openshock.org/home/safety-rules" rel="noreferrer noopener" target="_blank">Read the OpenShock safety rules</a>
</section>
<h2>Important reminders</h2>
<ul>
  <li>Never place electrodes across the chest, the neck, or the head.</li>
  <li>Do not use on anyone with a heart condition, a pacemaker, epilepsy, or during pregnancy.</li>
  <li>Guests are strangers and cannot see the wearer, which is why link ceilings start low.</li>
</ul>
<h2>Stopping</h2>
<p>Stop is never rate limited and is always accepted, even while a link is paused. If this site is
down or unreachable, the OpenShock app, the share's own pause control, and powering off the hub all
still work. AnonShock is never the only way to stop.</p>`,
    ),
  ),
);

pages.get("/privacy", (c) =>
  html(
    c,
    page(
      "Privacy",
      `<h1>Privacy</h1>
<h2>What is stored</h2>
<p>Link settings only: the slug, the aliases and their display names, the limits, the expiry, and
sealed copies of the upstream identifiers this instance needs to pass a command along. Sealed
values are encrypted with a key that is not kept in the database.</p>
<h2>What is never stored</h2>
<p>There is no control history, no audit log, no request log, and no access log. Guest sessions,
rate-limit counters, and the live feed exist only in memory and are gone when the process restarts.
IP addresses are hashed with keys generated at startup, used for rate limiting, and never written
down. The key behind most limits rotates hourly; a second key, used only by the limits that count
across a day, rotates daily. Both live in memory and are gone at restart.</p>
<h2>Accounts</h2>
<p>There are none. A creator's browser holds an access token; this instance keeps only its hash and
knows nothing else about who they are. There is no email, no password, and no reset.</p>
<h2>Who else sees this</h2>
<p>Cloudflare, which carries the traffic, and OpenShock, which receives the commands and logs them
for the device owner.</p>`,
    ),
  ),
);

pages.get("/acknowledgements", (c) =>
  html(
    c,
    page(
      "Open Source Acknowledgements",
      `<h1>Open Source Acknowledgements</h1>
<p>AnonShock is built with and distributed alongside software created by other open source
communities. Their work is gratefully acknowledged.</p>
<ul class="acknowledgements-list">
  <li><a href="https://github.com/honojs/hono" rel="noreferrer noopener" target="_blank">Hono and Hono Node Server</a> - MIT License</li>
  <li><a href="https://github.com/altcha-org/altcha" rel="noreferrer noopener" target="_blank">ALTCHA and ALTCHA Lib</a> - MIT License</li>
  <li><a href="https://github.com/websockets/ws" rel="noreferrer noopener" target="_blank">ws</a> - MIT License</li>
  <li><a href="https://github.com/0xType/0xProto" rel="noreferrer noopener" target="_blank">0xProto</a> - SIL Open Font License 1.1</li>
  <li><a href="https://github.com/nodejs/node" rel="noreferrer noopener" target="_blank">Node.js</a> - MIT License</li>
  <li><a href="https://github.com/cloudflare/cloudflared" rel="noreferrer noopener" target="_blank">cloudflared</a> - Apache License 2.0</li>
</ul>
<p class="note">Each project remains under its own license. Vendored license notices are included
with the corresponding assets where applicable.</p>`,
    ),
  ),
);

pages.get("/robots.txt", () =>
  new Response("User-agent: *\nDisallow: /s/\nDisallow: /m/\nDisallow: /links\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  }),
);

/**
 * Issues a proof-of-work challenge. Self-hosted: the guest's browser talks to
 * this instance and nowhere else.
 */
pages.get("/api/altcha/challenge", async (c) => {
  if (!botCheckAvailable()) return c.json({ enabled: false });
  return c.json(await createChallenge());
});
