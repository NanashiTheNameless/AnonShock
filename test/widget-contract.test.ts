import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The widget accepts `challenge` and a `configuration` JSON blob. Invalid
 * element attributes fail silently in the browser, so this suite verifies the
 * integration against the installed package's declarations.
 */

const client = readFileSync(new URL("../public/altcha.js", import.meta.url), "utf8");
const createClient = readFileSync(new URL("../public/create.js", import.meta.url), "utf8");
const manageClient = readFileSync(new URL("../public/manage.js", import.meta.url), "utf8");
const guestClient = readFileSync(new URL("../public/guest.js", import.meta.url), "utf8");
const linksClient = readFileSync(new URL("../public/links.js", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
const httpRoute = readFileSync(new URL("../src/routes/http.ts", import.meta.url), "utf8");
const declared = readFileSync(
  new URL("../node_modules/altcha/dist/types/generic.d.ts", import.meta.url),
  "utf8",
);
const configuration = readFileSync(
  new URL("../node_modules/altcha/dist/types/index.d.ts", import.meta.url),
  "utf8",
);
const pkg = JSON.parse(
  readFileSync(new URL("../node_modules/altcha/package.json", import.meta.url), "utf8"),
) as { version: string };

/** Only attributes set on the widget element itself, not on our own nodes. */
function attributesSetByClient(): string[] {
  return [...client.matchAll(/widget\.setAttribute\(\s*"([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("altcha widget contract", () => {
  it("is pinned to a v3 widget", () => {
    assert.match(pkg.version, /^3\./, "the client is written against the v3 widget API");
  });

  it("only sets attributes the v3 element declares", () => {
    for (const attribute of attributesSetByClient()) {
      const re = new RegExp(`^\\s+${attribute}\\??:`, "m");
      assert.match(declared, re, `altcha-widget v3 does not declare the attribute "${attribute}"`);
    }
  });

  it("does not use the v2 attribute names", () => {
    for (const gone of ["challengeurl", "hidelogo", "hidefooter"]) {
      assert.ok(!client.includes(`"${gone}"`), `"${gone}" is a v2 attribute and is ignored by v3`);
    }
  });

  it("does no work until an action asks, and appears as a popup on that button", () => {
    assert.match(client, /setAttribute\("auto", "off"\)/, "the check must not run on page load");
    assert.match(client, /setAttribute\("type", "checkbox"\)/, "the floating check uses checkbox mode");
    assert.match(client, /display: "floating"/, "the widget shows as a popup, not inline");
    assert.match(client, /floatingAnchor: anchor/, "the popup attaches to the pressed button");
    assert.doesNotMatch(client, /display: "standard"/, "protected actions never embed the widget inline");
    for (const key of ["display", "floatingAnchor", "floatingPersist", "auto"]) {
      assert.match(configuration, new RegExp(`^\\s+${key}:`, "m"), `Configuration lacks ${key}`);
    }
  });

  it("uses the vendored official Business theme", () => {
    assert.match(client, /setAttribute\("theme", "business"\)/);
    assert.match(httpRoute, /altcha-business\.min\.css/);
    const vendored = readFileSync(
      new URL("../public/vendor/altcha-business.min.css", import.meta.url),
      "utf8",
    );
    const installed = readFileSync(
      new URL("../node_modules/altcha/dist/themes/business.min.css", import.meta.url),
      "utf8",
    );
    assert.equal(vendored, installed, "run `yarn vendor` to refresh the Business theme");
  });

  it("passes hide options through the configuration object, where v3 keeps them", () => {
    // The logo is an inline SVG, so it goes. The footer is text, so it stays.
    assert.match(client, /hideLogo:\s*true/);
    assert.match(client, /hideFooter:\s*false/);
    for (const key of ["hideLogo", "hideFooter", "humanInteractionSignature"]) {
      assert.match(configuration, new RegExp(`^\\s+${key}:`, "m"), `Configuration lacks ${key}`);
    }
  });

  it("drives verification through the v3 methods it declares", () => {
    // The client asks for a solution on demand rather than listening for an
    // on-load event, so the methods it calls must exist on the element.
    for (const method of ["verify", "reset", "configure"]) {
      assert.match(declared, new RegExp(`^\\s+${method}:`, "m"), `v3 does not declare ${method}()`);
      assert.ok(client.includes(`${method}`), `the client never calls ${method}()`);
    }
    assert.match(client, /await widget\.verify\(\)/);
    assert.match(
      configuration,
      /VerifyResult/,
      "verify() resolves to a VerifyResult, whose payload the client returns",
    );
  });

  it("is vendored at the version installed", () => {
    const vendored = readFileSync(new URL("../public/vendor/altcha.min.js", import.meta.url), "utf8");
    const installed = readFileSync(
      new URL("../node_modules/altcha/dist/main/altcha.min.js", import.meta.url),
      "utf8",
    );
    assert.equal(vendored, installed, "run `yarn vendor` to refresh public/vendor");
  });

  it("vendors the standalone workers, so no blob: worker is ever built", () => {
    for (const [file, source] of [
      ["altcha-pbkdf2.worker.js", "pbkdf2.js"],
      ["altcha-sha.worker.js", "sha.js"],
    ]) {
      const vendored = readFileSync(new URL(`../public/vendor/${file}`, import.meta.url), "utf8");
      const installed = readFileSync(
        new URL(`../node_modules/altcha/dist/workers/${source}`, import.meta.url),
        "utf8",
      );
      assert.equal(vendored, installed, `run \`yarn vendor\` to refresh public/vendor/${file}`);
    }
  });

  it("registers a worker for every algorithm the server can issue", () => {
    // Every server-issued algorithm needs a same-origin worker override;
    // otherwise the widget falls back to a blob: worker rejected by the policy.
    const core = readFileSync(new URL("../src/core/altcha.ts", import.meta.url), "utf8");
    const algorithm = /algorithm: "([^"]+)"/.exec(core)?.[1];
    assert.ok(algorithm, "the server names an algorithm");
    assert.ok(
      client.includes(`"${algorithm}":`),
      `public/altcha.js does not register a same-origin worker for ${algorithm}`,
    );
  });
});

describe("create source contract", () => {
  it("makes the API token replace the share link", () => {
    assert.match(createClient, /hidden: state\.mode !== "share"/);
    assert.match(createClient, /hidden: state\.mode !== "token"/);
    assert.match(createClient, /if \(state\.mode === "share"\) payload\.shareUrl = state\.shareUrl/);
    assert.match(createClient, /else payload\.token = state\.token/);
    assert.doesNotMatch(createClient, /mode: state\.mode, shareUrl:/);
  });

  it("renders five discrete stages with explicit navigation", () => {
    for (const step of [1, 2, 3, 4, 5]) {
      assert.match(createClient, new RegExp(`"data-step": "${step}"`));
    }
    assert.match(createClient, /\.wizard-step/);
    assert.match(createClient, /section\.hidden = Number\(section\.dataset\.step\) !== step/);
    assert.match(createClient, /step > state\.maxStep/);
    assert.match(createClient, /disabled: !available/);
    assert.match(createClient, /onclick: \(\) => goToStep\(step\)/);
    assert.match(createClient, /state\.maxStep = Math\.max\(state\.maxStep, nextStep\)/);
  });

  it("renders a read-only review of every setting before creation", () => {
    assert.match(createClient, /id: "configuration-preview"/);
    assert.match(createClient, /function renderReadOnlyPreview\(\)/);
    assert.match(createClient, /"Intensity ceiling"/);
    assert.match(createClient, /"Guest password"/);
    assert.match(createClient, /secret not displayed/);
  });

  it("keeps the link bot-check setting distinct from the ALTCHA widget", () => {
    assert.match(createClient, /id: "link-botcheck"/);
    assert.match(createClient, /getElementById\("link-botcheck"\)\.value === "on"/);
    assert.doesNotMatch(createClient, /id: "botcheck"/);
  });

  it("allows zero to select unlimited command rates", () => {
    for (const source of [createClient, manageClient]) {
      assert.match(source, /id: "rate", min: "0", max: "120"/);
      assert.match(source, /id: "link-rate", min: "0", max: "600"/);
      assert.match(source, /Set to 0 for unlimited commands per guest/);
      assert.match(source, /Set to 0 for unlimited commands across the whole link/);
    }
    assert.match(createClient, /settings\.rateLimitPerMin === 0 \? "Unlimited"/);
    assert.match(createClient, /settings\.linkRateLimitPerMin === 0 \? "Unlimited"/);
  });

  it("shows the accepted minimum and maximum beside constrained fields", () => {
    for (const source of [createClient, manageClient]) {
      assert.match(source, /Commands per minute, per guest \(min 0, max 120\)/);
      assert.match(source, /Commands per minute, whole link \(min 0, max 600\)/);
      assert.match(source, /Cooldown[^\n]*\(min 0, max 600000\)/);
      assert.match(source, /Title \(1 to 64 characters\)/);
      assert.match(source, /Shown as \(1 to 32 characters/);
    }
    assert.match(guestClient, /Minimum 0, maximum/);
    assert.match(guestClient, /minimum \$\{shocker\.limits\.minDuration\}, maximum/);
  });

  it("does not render control features that are not allowed", () => {
    assert.doesNotMatch(createClient, /not allowed upstream/);
    assert.match(createClient, /shocker\.upstreamAllowVibrate \? perm\("Vibrate", true\) : null/);
    assert.match(createClient, /shocker\.upstreamAllowSound \? perm\("Sound", true\) : null/);
    assert.match(createClient, /shocker\.upstreamAllowShock \? perm\("Shock", false\) : null/);
    assert.match(guestClient, /shocker\.permissions\.vibrate \? "Vibrate" : null/);
    assert.doesNotMatch(guestClient, /type === "Vibrate" && !shocker\.permissions\.vibrate/);
    assert.match(guestClient, /const controls = allowedTypes\.length === 0 \? \[\] : \[/);
  });

  it("puts an embedded copy button beside every created-link field", () => {
    assert.match(createClient, /function copyField\(label, value, id\)/);
    assert.match(createClient, /navigator\.clipboard\.writeText\(value\)/);
    for (const id of ["created-guest-link", "created-manage-link", "created-recovery"]) {
      assert.match(createClient, new RegExp(`"${id}"`));
    }
    assert.doesNotMatch(createClient, /body\.recovery\s*\?/);
  });
});

describe("site dialog contract", () => {
  it("uses site-native dialogs instead of browser prompts, confirms, or alerts", () => {
    const files = readdirSync(new URL("../public", import.meta.url)).filter((name) => name.endsWith(".js"));
    for (const file of files) {
      const source = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\s*\(/, file);
    }
    const ui = readFileSync(new URL("../public/ui.js", import.meta.url), "utf8");
    assert.match(ui, /document\.createElement\("dialog"\)/);
    assert.match(ui, /dialog\.showModal\(\)/);
  });

  it("blocks guest controls behind the first-command disclosure and bot check", () => {
    assert.match(guestClient, /dialog\.showModal\(\)/);
    assert.match(guestClient, /dialog\.addEventListener\("cancel", \(event\) => event\.preventDefault\(\)\)/);
    assert.match(guestClient, /await ensureSession\(accept, password, botCheckSolution\)/);
    assert.match(guestClient, /if \(botCheckRequired\) placeBotCheck\(dialog\)/);
    assert.match(guestClient, /botCheckRequired \? await consumeBotCheck\(root, accept\) : null/);
    assert.doesNotMatch(guestClient, /runEmbeddedBotCheck/);
    assert.doesNotMatch(guestClient, /embedded-botcheck/);
  });

  it("highlights rejected user input and clears the state when it is edited", () => {
    const ui = readFileSync(new URL("../public/ui.js", import.meta.url), "utf8");
    assert.match(ui, /setAttribute\("aria-invalid", "true"\)/);
    assert.match(ui, /addEventListener\(event, \(\) => clearInvalid\(control\)/);
    assert.match(appCss, /\[aria-invalid="true"\]/);
    assert.match(createClient, /markInvalid\(document\.getElementById\("share-url"\)\)/);
  });

  it("keeps slider values in state and provides synchronized number inputs", () => {
    assert.match(guestClient, /controlValues: new Map\(\)/);
    assert.match(guestClient, /class: "control-value"/);
    assert.match(guestClient, /couple\(intensity, intensityNumber/);
    assert.match(guestClient, /couple\(duration, durationNumber/);
  });

  it("offers pause and resume directly from the holder's links menu", () => {
    assert.match(linksClient, /function togglePause\(link\)/);
    assert.match(linksClient, /resume \? "resume" : "pause"/);
    assert.match(linksClient, /link\.status === "killed" \? "Resume" : "Pause"/);
  });
});

describe("site theme contract", () => {
  it("uses the red, #16161D, and white palette", () => {
    assert.match(appCss, /--bg: #16161d;/i);
    assert.match(appCss, /--fg: #ffffff;/i);
    assert.match(appCss, /--accent: #ff4555;/i);
    assert.doesNotMatch(appCss, /#8ab4ff|#a8c7ff|#1c2740/i);
  });

  it("renders action links as buttons and informational links inline", () => {
    assert.match(appCss, /a \{[\s\S]*?display: inline-flex;/);
    assert.match(appCss, /a \{[\s\S]*?border: 1px solid var\(--line-bright\);/);
    assert.match(appCss, /a \{[\s\S]*?text-decoration: none;/);
    assert.match(appCss, /a:hover \{[\s\S]*?background: var\(--panel-raised\);/);
    assert.match(appCss, /\.acknowledgements-list a,\s*footer a \{[\s\S]*?display: inline;/);
    assert.match(appCss, /\.acknowledgements-list a,\s*footer a \{[\s\S]*?border: 0;/);
    assert.match(appCss, /\.acknowledgements-list a,\s*footer a \{[\s\S]*?text-decoration: underline;/);
  });

  it("never gives a button or button-style link a red background", () => {
    const redBackground = /background(?:-color)?\s*:[^;]*(?:--accent|--danger|#ff4555|#ff6875)/i;
    for (const match of appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1] ?? "";
      if (!/(?:^|[\s>+~,])(?:a|button)(?=[.:\[\s]|$)/.test(selector)) continue;
      assert.doesNotMatch(match[2] ?? "", redBackground, selector.trim());
    }
  });
});
