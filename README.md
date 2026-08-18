# AnonShock

> **Fork disclosure:** Any modified deployment exposed to the open internet must set
> `IS_FORK=true` and set `GIT_REPO_URL` to its public source repository.

An anonymizing proxy for [OpenShock](https://openshock.app) public share links and API control.

AnonShock sits between a **link owner** (who controls one or more OpenShock hubs/shockers) and
**guests** (people the owner hands a link to). It re-serves the share as a cloaked page where
every identifying string from OpenShock - the owner's username and avatar, the hub name, the
shocker names, and every upstream UUID - is replaced by a per-link alias that leaks nothing.

Guests get the same control surface. They never learn who they are shocking, what the hardware
is called, or which OpenShock share the link is backed by.

## Documentation

| Doc | Contents |
| --- | --- |
| [Overview](docs/overview.md) | What AnonShock does |
| [Usage](docs/usage.md) | Creating, managing, and using links |
| [Deployment](docs/deployment.md) | Production and local Docker setup |
| [Security](docs/security.md) | Privacy boundaries and safeguards |

## Reference material

`reference/version-1.{json,yaml}` and `reference/version-2.{json,yaml}` are the upstream OpenShock
OpenAPI documents this spec was written against (servers: `https://api.openshock.app`,
`https://api.openshock.dev`). Every upstream endpoint, schema, and limit cited in the specs is
traceable to those files or to the OpenShock source tree (`github.com/OpenShock/API`, `master`).

## Shape

One Docker Compose stack on a machine you control: a single **Node 26** service plus a
`cloudflared` sidecar that publishes it through a **Cloudflare Tunnel**. No inbound ports, no public
IP, no TLS to manage, no paid services. See the [deployment overview](docs/deployment.md).

Four properties are structural rather than configurable:

- **No accounts.** No signup, no login, no email, no password, for guests or creators. A creator's
  browser holds an `HttpOnly` access token that lets it list, edit, and cancel the links it made,
  plus a one-time recovery string to move that access to another device. The server keeps only a
  hash and has nothing to reset.
- **No history.** The store holds link *definitions* and nothing else - no control log, no audit
  log, no request log, no sessions, no IP columns. Who pressed what is a question AnonShock
  structurally cannot answer.
- **No admin panel.** The host gets exactly three powers, CLI-only on the machine: pause and resume
  the instance, delete all links, wipe the store. No HTTP admin route exists, and nothing anywhere
  can list the links on an instance or resolve one to its creator.
- **Everything filled in up front.** The create form has no silent defaults: every shocker's limits
  and permissions, the expiry, the rate limits, and the bot check must all be set before a link
  exists. The schema enforces the same rule.

There are also **no icons, avatars, or images anywhere** in the UI - enforced by `img-src 'none'` in
the CSP and by a CI job that fails if an image asset is committed. Every control and every state is
a word.

Storage is a **named Docker volume**, and the image is published to **GHCR** as
`ghcr.io/nanashithenameless/anonshock:latest` - `latest` is the only tag.

## License

[Nameless Nanashi Code License (NNCL) v1.5](LICENSE.md). NNCL permits use, study, sharing, and
modification under its noncommercial, ethical-use, attribution, source-availability, and
share-alike conditions. Network use counts as sharing. Read the complete license before using or
deploying AnonShock.

### NNCL v1.5 TL;DR

**This summary does not replace the full license terms.**

- **You may:** use, study, modify, share, and deploy AnonShock for ethical, noncommercial purposes,
  and accept non-rewarded donations as defined by NNCL.
- **You must:** credit the licensor, include the complete license, publish corresponding source for
  compiled distributions and network deployments, identify changes, and keep adaptations under
  NNCL v1.5 or later with its ethical policy intact.
- **You may not:** use it commercially; train commercial AI or ML models with it; enable bigotry,
  discrimination, violence, or human-rights abuses; use it for law enforcement, carceral,
  immigration-enforcement, or military purposes; or weaken or remove the license terms.
- **Also:** patent action terminates the license, the licensor may revoke rights with seven days'
  notice, deployments serving more than 100 users require public compliance documentation, and the
  work has no warranty.

Bottom line: ethical, noncommercial use is allowed when you share the source and preserve the full
license.

## Running it

```bash
git clone https://github.com/NanashiTheNameless/AnonShock && cd AnonShock
cp .env.example .env
printf 'STORE_KEY=%s\n'       "$(openssl rand -base64 32)" >> .env
printf 'TOKEN_PEPPER=%s\n'    "$(openssl rand -base64 32)" >> .env
printf 'ALTCHA_HMAC_KEY=%s\n' "$(openssl rand -base64 32)" >> .env   # omit to disable the bot check
chmod 600 .env
# Cloudflare Zero Trust -> Networks -> Tunnels -> create one, put its token in .env,
# and route anonshock.namelessnanashi.dev -> unix:/run/anonshock/anonshock.sock
docker compose up -d
```

The main Compose file pulls `ghcr.io/nanashithenameless/anonshock:latest`. To build and run the
current checkout locally instead, apply the local override:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

The local file is a standalone `anonshock-local` Compose project with separate containers and
volumes; it does not extend or share state with the GHCR-backed stack.

One hostname, no published ports, no public IP, no certificates to manage. The store lives in a
named Docker volume; the rest of the container filesystem is read only.

### Host control

Three powers, CLI only, on the machine itself. There is no HTTP admin route.

```bash
docker compose exec app anonshock status
docker compose exec app anonshock pause      # freeze the instance; Stop is still delivered
docker compose exec app anonshock resume
docker compose exec app anonshock purge-links --yes-i-mean-it
docker compose exec app anonshock nuke --yes-i-mean-it
```

### Development

```bash
corepack enable && yarn install
yarn typecheck
yarn test              # full test suite, including the anonymity gate
yarn test:anonymity    # the release blocker on its own
yarn build && node dist/server.js
```

Tests run against a mock OpenShock built from `reference/`, whose every string is a sentinel the
anonymity suite greps for across the entire guest surface.

## Layout

```
src/
  config.ts            environment, hard limits
  types.ts             shared shapes
  store/               SQLite schema, sealed columns, queries
  core/                aliasing, cloaking, limits, rooms, links, pseudonyms, altcha, scrub
  upstream/            OpenShock REST client and the SignalR share hub client
  routes/              guest, create, holder, manage, pages, shared HTTP helpers
  cli/                 the three host commands
public/                CSS and a few small scripts, no images
  vendor/              the official ALTCHA widget, served from this origin
test/                  mock upstream, flow, host, and anonymity suites
```

## Status

Implemented and tested: share-link and API-token creation, guest controls, holder and management
surfaces, recovery, host CLI controls, Docker deployment, and CI publishing to GHCR.
