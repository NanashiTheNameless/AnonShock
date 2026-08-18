// Create form. Every setting is stated before the link exists: no hidden
// defaults, and every discovered shocker must be configured or hidden.

import { consumeBotCheck, mountBotCheck } from "/assets/altcha.js";
import { markInvalid, validateFields } from "/assets/ui.js";

const root = document.getElementById("create");
const state = { mode: "share", shareUrl: "", token: "", devices: null, step: 1, maxStep: 1 };

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

const seconds = (ms) => (ms / 1000).toFixed(1) + "s";

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function message(text, cls = "error") {
  const box = document.getElementById("create-message");
  if (box) {
    box.textContent = text;
    box.className = cls;
  }
}

function nonblank(controls) {
  const invalid = [...controls].filter((control) => control.value.trim() === "");
  return invalid.length === 0 || markInvalid(invalid);
}

function highlightServerField(field) {
  const direct = {
    title: "#title",
    author: "#author",
    ttlSeconds: "#ttl",
    requireBotCheck: "#link-botcheck",
    guestPassword: "#guest-password",
    rateLimitPerMin: "#rate",
    linkRateLimitPerMin: "#link-rate",
    acknowledgements: "#ack-saved",
  }[field];
  if (direct) return markInvalid(root.querySelector(direct));
  if (field?.includes("displayName")) return markInvalid(root.querySelectorAll('input[id^="dn-"], input[id^="n-"]'));
  if (field?.includes("maxIntensity")) return markInvalid(root.querySelectorAll('input[id^="mi-"]'));
  if (field?.includes("maxDuration")) return markInvalid(root.querySelectorAll('input[id^="md-"]'));
  if (field?.includes("cooldownMs")) return markInvalid(root.querySelectorAll('input[id^="cd-"]'));
  return false;
}

function goToStep(step) {
  if (step < 1 || step > state.maxStep) return;
  state.step = step;
  for (const section of root.querySelectorAll(".wizard-step")) {
    section.hidden = Number(section.dataset.step) !== step;
  }
  for (const item of root.querySelectorAll(".stepper li")) {
    const current = Number(item.dataset.step) === step;
    const itemStep = Number(item.dataset.step);
    item.className = [
      current ? "current" : "",
      itemStep < state.maxStep ? "complete" : "",
      itemStep <= state.maxStep ? "available" : "",
    ].filter(Boolean).join(" ");
    const button = item.querySelector("button");
    if (button) button.disabled = itemStep > state.maxStep;
    if (current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  message("");
  root.querySelector(`.wizard-step[data-step="${step}"] h2`)?.focus();
}

function stepper() {
  const names = ["Source", "Review", "Shockers", "Settings", "Create"];
  return el("nav", { class: "stepper", "aria-label": "Create link progress" }, [
    el("ol", {}, names.map((name, index) => {
      const step = index + 1;
      const available = step <= state.maxStep;
      return el("li", {
        "data-step": String(step),
        class: [
          step === state.step ? "current" : "",
          step < state.maxStep ? "complete" : "",
          available ? "available" : "",
        ].filter(Boolean).join(" "),
        ...(step === state.step ? { "aria-current": "step" } : {}),
      }, [
        el("button", {
          type: "button",
          text: `${step}. ${name}`,
          disabled: !available,
          onclick: () => goToStep(step),
        }),
      ]);
    })),
  ]);
}

function actions(backStep, nextStep, nextText = "Continue", beforeNext) {
  return el("div", { class: "wizard-actions" }, [
    el("button", { type: "button", text: "Back", onclick: () => goToStep(backStep) }),
    el("button", {
      type: "button",
      class: "primary",
      text: nextText,
      onclick: () => {
        if (!beforeNext || beforeNext()) {
          state.maxStep = Math.max(state.maxStep, nextStep);
          goToStep(nextStep);
        }
      },
    }),
  ]);
}

/* ------------------------------------------------------------- step one */

function renderSource() {
  const shareInput = el("input", { type: "text", id: "share-url", value: state.shareUrl, placeholder: "https://openshock.app/s/..." });
  const tokenInput = el("input", { type: "password", id: "api-token", value: state.token, placeholder: "OpenShock API token" });

  const modeShare = el("input", { type: "radio", name: "mode", id: "mode-share", checked: state.mode === "share" });
  const modeToken = el("input", { type: "radio", name: "mode", id: "mode-token", checked: state.mode === "token" });
  const shareBlock = el("div", { hidden: state.mode !== "share" }, [
    el("label", { for: "share-url", text: "Share link" }),
    shareInput,
  ]);
  const tokenBlock = el("div", { hidden: state.mode !== "token" }, [
    el("p", {
      class: "note",
      text:
        "Mint a dedicated OpenShock token carrying only shockers.use. This instance stores it sealed " +
        "for the life of the link, and the store plus the key would give it up together.",
    }),
    el("label", { for: "api-token", text: "API token" }),
    tokenInput,
  ]);
  const selectMode = (mode) => {
    state.shareUrl = shareInput.value.trim();
    state.token = tokenInput.value.trim();
    state.mode = mode;
    state.devices = null;
    state.step = 1;
    state.maxStep = 1;
    render();
  };
  modeShare.addEventListener("change", () => selectMode("share"));
  modeToken.addEventListener("change", () => selectMode("token"));

  return el("section", { class: "wizard-step", "data-step": "1", hidden: state.step !== 1 }, [
    el("h2", { text: "Step 1. Source" }),
    el("div", { class: "row" }, [
      modeShare,
      el("label", { for: "mode-share", text: "I have a share link" }),
      modeToken,
      el("label", { for: "mode-token", text: "I have an API token" }),
    ]),
    shareBlock,
    tokenBlock,
    el("button", { type: "button", text: "Look up", onclick: (e) => void lookup(e.currentTarget) }),
  ]);
}

async function lookup(anchor) {
  state.shareUrl = (document.getElementById("share-url")?.value ?? "").trim();
  state.token = (document.getElementById("api-token")?.value ?? "").trim();
  if (state.mode === "share" && !state.shareUrl) {
    markInvalid(document.getElementById("share-url"));
    message("Paste the share link first.");
    return;
  }
  if (state.mode === "token" && !state.token) {
    markInvalid(document.getElementById("api-token"));
    message("Paste the API token first.");
    return;
  }

  if (root.dataset.botcheck) message("Waiting for the bot check to finish...", "note");
  // Each solution is good for exactly one request, so take one and queue another.
  const solution = await consumeBotCheck(root, anchor);
  if (root.dataset.botcheck && !solution) {
    message("The bot check did not finish. Reload the page and try again.");
    return;
  }
  message("Looking up...", "note");

  const payload = { mode: state.mode };
  if (state.mode === "share") payload.shareUrl = state.shareUrl;
  else payload.token = state.token;
  if (solution) payload.altcha = solution;

  const { status, body } = await api("/api/links/inspect", payload);
  if (status !== 200) {
    if (status === 400) markInvalid(document.getElementById(state.mode === "token" ? "api-token" : "share-url"));
    message(
      body?.type === "invalid_bot_check"
        ? "The bot check has not finished, or its answer expired. Wait a moment and try again."
        : body?.type === "invalid_token" || body?.type?.startsWith("token_")
          ? "That token was not accepted, or it does not carry shockers.use."
          : body?.type === "no_shockers"
            ? "That token does not have any controllable shockers."
          : body?.type === "rate_limited"
            ? "Too many lookups from here. Try again later."
            : state.mode === "token"
              ? "The shockers available to that token could not be read."
              : "That share could not be read. Check the link.",
    );
    return;
  }
  state.devices = body.devices;
  state.step = 2;
  state.maxStep = 2;
  message("");
  render();
}

/* ---------------------------------------------------- steps two to five */

function shockerBlock(device, shocker) {
  const id = shocker.upstreamId;
  const nameInput = el("input", { type: "text", id: `n-${id}`, value: shocker.suggestedName, required: true, maxlength: "64" });
  const intensityInput = el("input", {
    type: "number",
    id: `mi-${id}`,
    min: "0",
    max: String(shocker.upstreamMaxIntensity),
    value: String(Math.min(30, shocker.upstreamMaxIntensity)),
    required: true,
  });
  const durationInput = el("input", {
    type: "number",
    id: `md-${id}`,
    min: "300",
    max: String(shocker.upstreamMaxDuration),
    step: "100",
    value: String(Math.min(3000, shocker.upstreamMaxDuration)),
    required: true,
  });
  const cooldownInput = el("input", { type: "number", id: `cd-${id}`, min: "0", max: "600000", value: "1500", required: true });

  const perm = (kind, defaultOn) => {
    const box = el("input", { type: "checkbox", id: `p-${kind}-${id}` });
    box.checked = defaultOn;
    return el("span", { class: "row" }, [
      box,
      el("label", { for: `p-${kind}-${id}`, text: kind }),
    ]);
  };

  const permissions = [
    shocker.upstreamAllowVibrate ? perm("Vibrate", true) : null,
    shocker.upstreamAllowSound ? perm("Sound", true) : null,
    shocker.upstreamAllowShock ? perm("Shock", false) : null,
  ].filter(Boolean);

  const hidden = el("input", { type: "checkbox", id: `h-${id}` });
  const confirmed = el("input", { type: "checkbox", id: `c-${id}` });

  return el("div", { class: "card" }, [
    el("h3", { text: shocker.upstreamName }),
    el("p", {
      class: "note",
      text: `Upstream allows intensity up to ${shocker.upstreamMaxIntensity} and ${seconds(
        shocker.upstreamMaxDuration,
      )}.`,
    }),
    el("label", { for: `n-${id}`, text: "Public name (1 to 64 characters; guests see this exact text)" }),
    nameInput,
    el("label", { for: `mi-${id}`, text: `Intensity ceiling (min 0, max ${shocker.upstreamMaxIntensity})` }),
    intensityInput,
    el("label", { for: `md-${id}`, text: `Duration ceiling in ms (min 300, max ${shocker.upstreamMaxDuration})` }),
    durationInput,
    el("label", { for: `cd-${id}`, text: "Cooldown between commands, ms (min 0, max 600000)" }),
    cooldownInput,
    el("div", { class: "row" }, permissions),
    el("div", { class: "row" }, [hidden, el("label", { for: `h-${id}`, text: "Hide this shocker from the link" })]),
    el("div", { class: "row" }, [
      confirmed,
      el("label", { for: `c-${id}`, text: "I have set these limits deliberately" }),
    ]),
  ]);
}

function readSettings() {
  const val = (id) => document.getElementById(id).value.trim();
  const num = (id) => Number.parseInt(document.getElementById(id).value, 10);
  const checked = (id) => document.getElementById(id)?.checked ?? false;
  const passwordMode = document.getElementById("password-mode").value;

  return {
    title: val("title"),
    author: val("author"),
    ttlSeconds: num("ttl"),
    requireBotCheck: document.getElementById("link-botcheck").value === "on",
    guestPassword: passwordMode === "set" ? val("guest-password") : null,
    rateLimitPerMin: num("rate"),
    linkRateLimitPerMin: num("link-rate"),
    devices: state.devices.map((device) => ({
      upstreamId: device.upstreamId,
      displayName: val(`dn-${device.upstreamId}`),
      shockers: device.shockers.map((shocker) => ({
        upstreamId: shocker.upstreamId,
        displayName: val(`n-${shocker.upstreamId}`),
        maxIntensity: num(`mi-${shocker.upstreamId}`),
        maxDuration: num(`md-${shocker.upstreamId}`),
        cooldownMs: num(`cd-${shocker.upstreamId}`),
        allowShock: checked(`p-Shock-${shocker.upstreamId}`),
        allowVibrate: checked(`p-Vibrate-${shocker.upstreamId}`),
        allowSound: checked(`p-Sound-${shocker.upstreamId}`),
        hidden: checked(`h-${shocker.upstreamId}`),
      })),
    })),
  };
}

function previewList(items) {
  return el("dl", { class: "preview-list" }, items.flatMap(([term, description]) => [
    el("dt", { text: term }),
    el("dd", { text: description }),
  ]));
}

function renderReadOnlyPreview() {
  const target = document.getElementById("configuration-preview");
  if (!target) return;

  const settings = readSettings();
  const ttl = {
    3600: "1 hour",
    28800: "8 hours",
    86400: "24 hours",
    604800: "7 days",
  }[settings.ttlSeconds] ?? `${settings.ttlSeconds} seconds`;
  const source = state.mode === "share"
    ? [["Source type", "OpenShock share link"], ["Share link", state.shareUrl]]
    : [["Source type", "OpenShock API token"], ["API token", "Stored securely; secret not displayed"]];

  const devices = settings.devices.map((device) => el("div", { class: "card preview-device" }, [
    el("h4", { text: `Hub: ${device.displayName}` }),
    ...device.shockers.map((shocker) => {
      const controls = [
        shocker.allowVibrate ? "Vibrate" : null,
        shocker.allowSound ? "Sound" : null,
        shocker.allowShock ? "Shock" : null,
      ].filter(Boolean).join(", ") || "None";
      return el("div", { class: "preview-shocker" }, [
        el("h5", { text: shocker.displayName }),
        previewList([
          ["Visibility", shocker.hidden ? "Hidden" : "Visible"],
          ["Allowed controls", controls],
          ["Intensity ceiling", String(shocker.maxIntensity)],
          ["Duration ceiling", `${shocker.maxDuration} ms (${seconds(shocker.maxDuration)})`],
          ["Cooldown", `${shocker.cooldownMs} ms`],
        ]),
      ]);
    }),
  ]));

  target.replaceChildren(
    el("h3", { text: "Source" }),
    previewList(source),
    el("h3", { text: "Link settings" }),
    previewList([
      ["Title", settings.title],
      ["Shown as", settings.author],
      ["Expires in", ttl],
      ["Commands per minute, per guest", settings.rateLimitPerMin === 0 ? "Unlimited" : String(settings.rateLimitPerMin)],
      ["Commands per minute, whole link", settings.linkRateLimitPerMin === 0 ? "Unlimited" : String(settings.linkRateLimitPerMin)],
      ["Bot check", settings.requireBotCheck ? "On" : "Off"],
      ["Guest password", settings.guestPassword === null ? "Off" : "On (secret not displayed)"],
    ]),
    el("h3", { text: "Hubs and shockers" }),
    ...devices,
  );
}

function copyField(label, value, id) {
  const input = el("input", {
    type: "text",
    id,
    value,
    readonly: true,
    autocomplete: "off",
    spellcheck: "false",
  });
  const button = el("button", { type: "button", text: "Copy text", "aria-label": `Copy ${label}` });
  button.addEventListener("click", async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      input.focus();
      input.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
    }
    button.textContent = copied ? "Copied" : "Copy failed";
    window.setTimeout(() => (button.textContent = "Copy text"), 1800);
  });
  return el("div", { class: "created-field" }, [
    el("label", { for: id, text: label }),
    el("div", { class: "copy-field" }, [input, button]),
  ]);
}

function renderConfigured() {
  const blocks = [];
  const summary = [];
  for (const device of state.devices) {
    summary.push(el("div", { class: "card" }, [
      el("h3", { text: device.upstreamName }),
      el("ul", {}, device.shockers.map((shocker) => el("li", { text: shocker.upstreamName }))),
    ]));
    blocks.push(el("h2", { text: `Hub: ${device.upstreamName}` }));
    blocks.push(
      el("label", { for: `dn-${device.upstreamId}`, text: "Public hub name (1 to 64 characters)" }),
      el("input", { type: "text", id: `dn-${device.upstreamId}`, value: device.suggestedName, required: true, maxlength: "64" }),
    );
    for (const shocker of device.shockers) blocks.push(shockerBlock(device, shocker));
  }

  const ttl = el("select", { id: "ttl" }, [
    el("option", { value: "3600", text: "1 hour" }),
    el("option", { value: "28800", text: "8 hours" }),
    el("option", { value: "86400", text: "24 hours", selected: true }),
    el("option", { value: "604800", text: "7 days" }),
  ]);

  const passwordMode = el("select", { id: "password-mode" }, [
    el("option", { value: "none", text: "No password" }),
    el("option", { value: "set", text: "Set a password" }),
  ]);
  const passwordInput = el("input", { type: "password", id: "guest-password", hidden: true });
  passwordMode.addEventListener("change", () => {
    passwordInput.hidden = passwordMode.value !== "set";
    passwordInput.required = passwordMode.value === "set";
  });

  const botCheck = el("select", { id: "link-botcheck" }, [
    el("option", { value: "on", text: "Bot check on", selected: true }),
    el("option", { value: "off", text: "Bot check off" }),
  ]);

  const ackAliases = el("input", { type: "checkbox", id: "ack-aliases" });
  const ackSaved = el("input", { type: "checkbox", id: "ack-saved" });

  const shockersReady = () => {
    const step = root.querySelector('.wizard-step[data-step="3"]');
    const fields = step.querySelectorAll('input[type="text"], input[type="number"]');
    if (!validateFields(fields) || !nonblank(step.querySelectorAll('input[type="text"]'))) {
      message("Correct the highlighted shocker settings before continuing.");
      return false;
    }
    const unconfirmed = state.devices
      .flatMap((device) => device.shockers)
      .filter((shocker) =>
        !document.getElementById(`c-${shocker.upstreamId}`).checked &&
        !document.getElementById(`h-${shocker.upstreamId}`).checked
      );
    if (unconfirmed.length > 0) {
      markInvalid(unconfirmed.map((shocker) => document.getElementById(`c-${shocker.upstreamId}`)));
      message("Confirm the limits for every visible shocker before continuing.");
      return false;
    }
    return true;
  };

  const settingsReady = () => {
    const step = root.querySelector('.wizard-step[data-step="4"]');
    const fields = step.querySelectorAll('input:not([type="checkbox"]), select');
    if (!validateFields(fields) || !nonblank([document.getElementById("title"), document.getElementById("author")])) {
      message("Correct the highlighted link settings before continuing.");
      return false;
    }
    const title = document.getElementById("title").value.trim();
    const author = document.getElementById("author").value.trim();
    const rate = Number.parseInt(document.getElementById("rate").value, 10);
    const linkRate = Number.parseInt(document.getElementById("link-rate").value, 10);
    if (!title || !author || !Number.isInteger(rate) || !Number.isInteger(linkRate)) {
      message("Fill in the title, author, and both rate limits before continuing.");
      return false;
    }
    if (!document.getElementById("ack-aliases").checked) {
      markInvalid(document.getElementById("ack-aliases"));
      message("Confirm that the public names and title will be visible to guests.");
      return false;
    }
    renderReadOnlyPreview();
    return true;
  };

  return [
    el("section", { class: "wizard-step", "data-step": "2", hidden: state.step !== 2 }, [
      el("h2", { tabindex: "-1", text: "Step 2. Review what was found" }),
      el("p", { class: "note", text: "These are real upstream names. Only you see them during setup." }),
      ...summary,
      actions(1, 3),
    ]),
    el("section", { class: "wizard-step", "data-step": "3", hidden: state.step !== 3 }, [
      el("h2", { tabindex: "-1", text: "Step 3. Configure every shocker" }),
      ...blocks,
      actions(2, 4, "Continue to link settings", shockersReady),
    ]),
    el("section", { class: "wizard-step", "data-step": "4", hidden: state.step !== 4 }, [
      el("h2", { tabindex: "-1", text: "Step 4. Link settings" }),
      el("label", { for: "title", text: "Title (1 to 64 characters)" }),
      el("input", { type: "text", id: "title", value: "Shared controls", required: true, maxlength: "64" }),
      el("label", { for: "author", text: "Shown as (1 to 32 characters; text only, there is no avatar)" }),
      el("input", { type: "text", id: "author", value: "Anonymous", required: true, maxlength: "32" }),
      el("label", { for: "ttl", text: "Expires in" }),
      ttl,
      el("label", { for: "rate", text: "Commands per minute, per guest (min 0, max 120)" }),
      el("input", { type: "number", id: "rate", min: "0", max: "120", value: "6", required: true }),
      el("p", { class: "note", text: "Set to 0 for unlimited commands per guest." }),
      el("label", { for: "link-rate", text: "Commands per minute, whole link (min 0, max 600)" }),
      el("input", { type: "number", id: "link-rate", min: "0", max: "600", value: "30", required: true }),
      el("p", { class: "note", text: "Set to 0 for unlimited commands across the whole link. Per-shocker cooldowns still apply." }),
      el("label", { for: "link-botcheck", text: "Bot check" }),
      botCheck,
      el("label", { for: "password-mode", text: "Guest password" }),
      passwordMode,
      passwordInput,
      el("div", { class: "check-row" }, [
        ackAliases,
        el("label", { for: "ack-aliases", text: "I understand the public names and title are shown to everyone" }),
      ]),
      actions(3, 5, "Review and create", settingsReady),
    ]),
    el("section", { class: "wizard-step", "data-step": "5", hidden: state.step !== 5 }, [
      el("h2", { tabindex: "-1", text: "Step 5. Before creating" }),
      el("p", { text: "Review every setting below. Creating the link stores this configuration until it expires." }),
      el("div", { id: "configuration-preview", class: "configuration-preview", "aria-label": "Read-only configuration preview" }),
      el("div", { class: "check-row" }, [
        ackSaved,
        el("label", {
          for: "ack-saved",
          text:
            "I will save the manage link now. It cannot be recovered by email, account, or support, " +
            "and this browser is the only other copy.",
        }),
      ]),
      el("div", { class: "wizard-actions" }, [
        el("button", { type: "button", text: "Back", onclick: () => goToStep(4) }),
        el("button", { type: "button", class: "primary", text: "Create link", onclick: (e) => void submit(e.currentTarget) }),
      ]),
    ]),
  ];
}

/* ------------------------------------------------------------- submit */

async function submit(anchor) {
  const checked = (id) => document.getElementById(id).checked;

  const unconfirmed = state.devices
    .flatMap((d) => d.shockers)
    .filter((s) => !checked(`c-${s.upstreamId}`) && !checked(`h-${s.upstreamId}`));
  if (unconfirmed.length > 0) {
    markInvalid(unconfirmed.map((shocker) => document.getElementById(`c-${shocker.upstreamId}`)));
    message("Every shocker must be confirmed or hidden before the link can be made.");
    return;
  }
  if (!checked("ack-aliases") || !checked("ack-saved")) {
    markInvalid(["ack-aliases", "ack-saved"].filter((id) => !checked(id)).map((id) => document.getElementById(id)));
    message("Both acknowledgements are required.");
    return;
  }

  const payload = {
    mode: state.mode,
    settings: readSettings(),
    acknowledgements: { limitsReviewed: true, aliasesArePublic: true, manageLinkSaved: true },
  };
  if (state.mode === "share") payload.shareUrl = state.shareUrl;
  else payload.token = state.token;
  // Creating needs its own solution, separate from the lookup's.
  if (root.dataset.botcheck) {
    message("Waiting for the bot check...", "note");
    const fresh = await consumeBotCheck(root, anchor);
    if (!fresh) {
      message("The bot check did not finish. Reload the page and try again.");
      return;
    }
    payload.altcha = fresh;
  }

  message("Creating...", "note");
  const { status, body } = await api("/api/links", payload);
  if (status !== 201) {
    if (body?.field) highlightServerField(body.field);
    message(
      body?.type === "invalid_bot_check"
        ? "The bot check answer expired. Reload the page and try again."
        : body?.field
          ? `That is not accepted: ${body.type} (${body.field}).`
          : `That is not accepted: ${body?.type ?? "unknown error"}.`,
    );
    return;
  }

  root.replaceChildren(
    el("h2", { text: "Link created" }),
    copyField("Guest link - hand this out", body.guestUrl, "created-guest-link"),
    copyField("Manage link - keep this; it is shown once", body.manageUrl, "created-manage-link"),
    el("h3", { text: "Recovery string" }),
    el("p", {
      class: "note",
      text:
        "This browser can see its links at /links. Save this string to move that access to another browser.",
    }),
    copyField("Recovery string - save this", body.recovery, "created-recovery"),
    el("p", {}, [el("a", { href: "/links", text: "See the links this browser made" })]),
  );
}

/* ---------------------------------------------------------------- render */

function render() {
  root.replaceChildren(
    el("div", { id: "create-message" }),
    stepper(),
    renderSource(),
    ...(state.devices ? renderConfigured() : []),
  );
}

mountBotCheck(root);
render();
