import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const http = readFileSync(new URL("../src/routes/http.ts", import.meta.url), "utf8");
const deployment = readFileSync(new URL("../docs/deployment.md", import.meta.url), "utf8");

describe("production transport", () => {
  it("has no app TCP ingress and connects cloudflared over a Unix socket", () => {
    assert.doesNotMatch(compose, /^\s+(?:ports|expose):/m);
    assert.match(compose, /SOCKET_PATH: \/run\/anonshock\/anonshock\.sock/);
    assert.match(compose, /anonshock-run:\/run\/anonshock/g);
    assert.match(server, /server\.listen\(config\.socketPath/);
  });

  it("refuses insecure production origins", () => {
    assert.match(config, /PUBLIC_ORIGIN must use https:\/\/ in production/);
    assert.match(config, /UPSTREAM_BASE must use https:\/\/ in production/);
    assert.match(config, /SOCKET_PATH must be an absolute Unix-socket path in production/);
  });

  it("accepts only true or false for boolean environment values", () => {
    assert.match(config, /normalized === "true"/);
    assert.match(config, /normalized === "false"/);
    assert.match(config, /must be true or false/);
    assert.doesNotMatch(config, /v === "1"/);
  });

  it("builds the upstream User-Agent from only the app version and public origin", () => {
    assert.match(config, /str\("APP_VERSION", "0\.0\.1"\)/);
    assert.match(config, /`AnonShock\/\$\{appVersion\} \(\+\$\{publicOrigin\}\)`/);
    assert.doesNotMatch(config, /str\("UPSTREAM_USER_AGENT"/);
  });

  it("supports explicit fork disclosure and a configurable source repository", () => {
    assert.match(config, /bool\("IS_FORK", false\)/);
    assert.match(config, /str\("GIT_REPO_URL", OFFICIAL_REPOSITORY\)/);
    assert.match(config, /GIT_REPO_URL must use https:\/\/ in production/);
    assert.match(http, /config\.isFork \? "Fork source" : "GitHub"/);
    assert.match(http, /View this fork's source/);
    assert.match(http, /View the original repository/);
    assert.match(deployment, /Any modified deployment exposed to the open internet must declare itself as/);
  });
});
