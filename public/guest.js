// Guest controls. Text only: no icons, no images, no external requests.

import { consumeBotCheck, mountBotCheck, placeBotCheck, restoreBotCheck } from "/assets/altcha.js";
import { clearInvalid, markInvalid } from "/assets/ui.js";

const root = document.getElementById("app");
const slug = root.dataset.slug;
const state = {
  view: null,
  session: null,
  acknowledged: false,
  cooldowns: new Map(),
  controlValues: new Map(),
  firstCommandDialog: null,
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

function humanExpiry(sec) {
  if (sec === null) return "no expiry";
  if (sec <= 0) return "expired";
  if (sec < 3600) return `expires in about ${Math.max(1, Math.round(sec / 60))} minutes`;
  if (sec < 86400) return `expires in about ${Math.round(sec / 3600)} hours`;
  return `expires in about ${Math.round(sec / 86400)} days`;
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function loadView() {
  const { status, body } = await api(`/api/s/${slug}`);
  if (status !== 200) {
    root.replaceChildren(el("p", { class: "error", text: "This link is no longer available." }));
    return null;
  }
  state.view = body;
  return body;
}

async function ensureSession(anchor, password = null, preparedAltcha = null) {
  if (state.session) return true;
  const payload = {};
  if (state.view.policy.botCheckRequired) {
    note("Waiting for the bot check to finish...");
    const solution = preparedAltcha ?? await consumeBotCheck(root, anchor);
    if (!solution) {
      markInvalid(document.getElementById("botcheck"));
      note("The bot check did not finish. Reload the page and try again.");
      return false;
    }
    payload.altcha = solution;
  }
  if (state.view.policy.passwordRequired) {
    const input = password ?? document.getElementById("guest-password");
    clearInvalid(input);
    payload.password = input ? input.value : "";
  }
  const { status, body } = await api(`/api/s/${slug}/session`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) {
    if (status === 401) {
      if (body?.type === "invalid_password") markInvalid(password ?? document.getElementById("guest-password"));
      if (body?.type === "invalid_bot_check") markInvalid(document.getElementById("botcheck"));
    }
    note(
      body?.type === "invalid_password"
        ? "That password was not accepted."
        : body?.type === "invalid_bot_check"
          ? "The bot check was not accepted."
          : "Could not start.",
    );
    return false;
  }
  state.session = body.pseudonym;
  openFeed();
  return true;
}

let feedItems = [];
let socket = null;

function openFeed() {
  if (socket) return;
  const url = new URL(`/api/s/${slug}/live`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.t === "activity") {
      feedItems.unshift(frame);
      feedItems = feedItems.slice(0, 20);
      renderFeed();
    } else if (frame.t === "state") {
      const el2 = document.getElementById("guest-count");
      if (el2) el2.textContent = `${frame.guests} here`;
      if (frame.status !== "active") void refresh();
    } else if (frame.t === "dead") {
      void refresh();
    }
  });
  socket.addEventListener("close", () => {
    socket = null;
    setTimeout(() => {
      if (state.session) openFeed();
    }, 5000);
  });
}

function note(text) {
  const box = document.getElementById("notice");
  if (box) {
    box.textContent = text;
    box.className = "error";
  }
}

function showFirstCommandGate() {
  if (state.acknowledged || state.firstCommandDialog || !state.view) return;
  const limits = state.view.devices
    .flatMap((d) => d.shockers)
    .map((s) => `${s.name}: up to ${s.limits.maxIntensity} for ${seconds(s.limits.maxDuration)}`)
    .join("; ");
  const dialog = el("dialog", { class: "site-dialog first-command-dialog" });
  state.firstCommandDialog = dialog;
  const error = el("p", { class: "error", "aria-live": "polite" });
  const password = state.view.policy.passwordRequired
    ? el("input", { type: "password", id: "first-command-password", autocomplete: "current-password", required: true })
    : null;
  const botCheckRequired = state.view.policy.botCheckRequired;
  const accept = el("button", {
    type: "button",
    class: "primary",
    text: "I understand, continue",
  });

  dialog.append(
    el("h2", { text: "Before your first command" }),
    el("p", { text: `Limits on this link: ${limits}.` }),
    el("p", {
      text:
        "The device owner sees, in OpenShock, that someone pressed a button and what was sent. " +
        "This site keeps no logs and no history.",
    }),
  );
  if (password) {
    dialog.append(
      el("label", { for: "first-command-password", text: "This link needs a password" }),
      password,
    );
  }
  dialog.append(
    error,
    el("div", { class: "dialog-actions" }, [accept]),
  );
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  accept.addEventListener("click", async () => {
    if (password && !password.checkValidity()) {
      markInvalid(password);
      error.textContent = "Enter the link password before continuing.";
      return;
    }
    accept.disabled = true;
    accept.textContent = botCheckRequired ? "Open bot check..." : "Starting...";
    error.textContent = "";
    clearInvalid(document.getElementById("botcheck"));
    const botCheckSolution = botCheckRequired ? await consumeBotCheck(root, accept) : null;
    if (botCheckRequired && !botCheckSolution) {
      markInvalid(document.getElementById("botcheck"));
      error.textContent = "The bot check did not finish. Try again.";
      accept.disabled = false;
      accept.textContent = "I understand, continue";
      return;
    }
    const accepted = await ensureSession(accept, password, botCheckSolution);
    if (!accepted) {
      error.textContent = document.getElementById("notice")?.textContent || "Could not start. Try again.";
      accept.disabled = false;
      accept.textContent = "I understand, continue";
      return;
    }
    state.acknowledged = true;
    restoreBotCheck(root);
    dialog.close();
    dialog.remove();
    state.firstCommandDialog = null;
    render();
  });

  document.body.append(dialog);
  if (botCheckRequired) placeBotCheck(dialog);
  dialog.showModal();
  (password ?? accept).focus();
}

async function send(shocker, type, anchor) {
  if (type !== "Stop" && !state.acknowledged) {
    showFirstCommandGate();
    return;
  }
  if (!(await ensureSession(anchor))) return;

  const intensity = type === "Stop" ? 0 : Number(document.getElementById(`i-${shocker.alias}`).value);
  const duration =
    type === "Stop" ? shocker.limits.minDuration : Number(document.getElementById(`d-${shocker.alias}`).value);

  const { status, body } = await api(`/api/s/${slug}/control`, {
    method: "POST",
    body: JSON.stringify({ commands: [{ alias: shocker.alias, type, intensity, duration }] }),
  });

  if (status === 200) {
    // Share mode gets no acknowledgement from upstream, so this says sent.
    note("");
    const applied = body.applied?.[0];
    if (applied?.clamped) note(`Sent, reduced to ${applied.intensity} for ${seconds(applied.duration)}.`);
    if (type !== "Stop" && shocker.cooldownMs > 0) {
      state.cooldowns.set(shocker.alias, Date.now() + shocker.cooldownMs);
      render();
    }
  } else if (status === 429) {
    note(`Rate limited. Try again in ${body?.retryAfter ?? 10} seconds.`);
  } else if (status === 409) {
    note("That shocker is paused.");
  } else if (status === 403) {
    note("That is not allowed on this link.");
  } else if (status === 410) {
    note("This link has ended.");
    void refresh();
  } else if (status === 401) {
    state.session = null;
    note("Session expired. Press again to restart it.");
  } else {
    note("Could not reach the device. Try again shortly.");
  }
}

async function stopAll(anchor) {
  if (!state.view) return;
  if (!(await ensureSession(anchor))) return;
  const all = state.view.devices
    .flatMap((d) => d.shockers)
    .map((s) => ({ alias: s.alias, type: "Stop", intensity: 0, duration: s.limits.minDuration }));
  if (all.length === 0) return;

  // The API accepts at most 8 commands per request, and a stop must reach
  // every shocker, so send in chunks rather than truncating.
  const chunks = [];
  for (let i = 0; i < all.length; i += 8) chunks.push(all.slice(i, i + 8));
  const results = await Promise.all(
    chunks.map((commands) =>
      api(`/api/s/${slug}/control`, { method: "POST", body: JSON.stringify({ commands }) }),
    ),
  );
  const failed = results.filter((r) => r.status !== 200).length;
  note(failed === 0 ? "Stop sent." : `Stop sent, but ${failed} batch(es) failed. Try again.`);
}

function shockerCard(shocker) {
  const disabledReason = () => {
    if (state.view.status !== "active") return "link paused";
    if (shocker.paused) return "paused";
    const until = state.cooldowns.get(shocker.alias) ?? 0;
    if (until > Date.now()) return `cooling down ${Math.ceil((until - Date.now()) / 1000)}s`;
    return null;
  };

  const allowedTypes = [
    shocker.permissions.vibrate ? "Vibrate" : null,
    shocker.permissions.sound ? "Sound" : null,
    shocker.permissions.shock ? "Shock" : null,
  ].filter(Boolean);
  const buttons = allowedTypes.map((type) => {
    const reason = disabledReason();
    const button = el("button", {
      type: "button",
      text: type,
      onclick: (e) => void send(shocker, type, e.currentTarget),
    });
    if (reason) {
      button.disabled = true;
      button.title = reason;
      button.append(document.createTextNode(` (${reason})`));
    }
    return button;
  });

  let values = state.controlValues.get(shocker.alias);
  if (!values) {
    values = {
      intensity: Math.min(5, shocker.limits.maxIntensity),
      duration: shocker.limits.minDuration,
    };
    state.controlValues.set(shocker.alias, values);
  }
  values.intensity = Math.max(0, Math.min(shocker.limits.maxIntensity, values.intensity));
  values.duration = Math.max(
    shocker.limits.minDuration,
    Math.min(shocker.limits.maxDuration, values.duration),
  );

  const intensity = el("input", {
    type: "range",
    id: `i-${shocker.alias}`,
    min: "0",
    max: String(shocker.limits.maxIntensity),
    value: String(values.intensity),
    "aria-label": `${shocker.name} intensity`,
  });
  const intensityNumber = el("input", {
    type: "number",
    class: "control-value",
    min: "0",
    max: String(shocker.limits.maxIntensity),
    value: String(values.intensity),
    "aria-label": `${shocker.name} intensity value`,
  });

  const duration = el("input", {
    type: "range",
    id: `d-${shocker.alias}`,
    min: String(shocker.limits.minDuration),
    max: String(shocker.limits.maxDuration),
    step: "100",
    value: String(values.duration),
    "aria-label": `${shocker.name} duration`,
  });
  const durationNumber = el("input", {
    type: "number",
    class: "control-value",
    min: String(shocker.limits.minDuration),
    max: String(shocker.limits.maxDuration),
    step: "100",
    value: String(values.duration),
    "aria-label": `${shocker.name} duration in milliseconds`,
  });

  const couple = (range, number, key, min, max) => {
    range.addEventListener("input", () => {
      values[key] = Number(range.value);
      number.value = range.value;
    });
    number.addEventListener("input", () => {
      const next = Number(number.value);
      if (Number.isInteger(next) && next >= min && next <= max) {
        values[key] = next;
        range.value = String(next);
      }
    });
    number.addEventListener("change", () => {
      const entered = Number(number.value);
      const next = Number.isFinite(entered) ? Math.round(Math.max(min, Math.min(max, entered))) : values[key];
      values[key] = next;
      range.value = String(next);
      number.value = String(next);
    });
  };
  couple(intensity, intensityNumber, "intensity", 0, shocker.limits.maxIntensity);
  couple(duration, durationNumber, "duration", shocker.limits.minDuration, shocker.limits.maxDuration);

  const status = disabledReason();
  const controls = allowedTypes.length === 0 ? [] : [
    el("label", { for: `i-${shocker.alias}`, text: "Intensity" }),
    el("div", { class: "control-inputs" }, [intensity, intensityNumber]),
    el("p", { class: "limits", text: `Minimum 0, maximum ${shocker.limits.maxIntensity}` }),
    el("label", { for: `d-${shocker.alias}`, text: "Duration" }),
    el("div", { class: "control-inputs" }, [duration, durationNumber]),
    el("p", {
      class: "limits",
      text: `Milliseconds; minimum ${shocker.limits.minDuration}, maximum ${shocker.limits.maxDuration}`,
    }),
    el("div", { class: "row" }, buttons),
    el("p", { class: `state ${status ? "blocked" : "ready"}`, text: status ?? "ready" }),
  ];
  return el("div", { class: "card" }, [el("h3", { text: shocker.name }), ...controls]);
}

function renderFeed() {
  const list = document.getElementById("feed");
  if (!list) return;
  list.replaceChildren(
    ...feedItems.map((f) =>
      el("li", {
        class: f.ok ? "" : "failed",
        text: `${f.pseudonym === state.session ? "You" : f.pseudonym} ${f.type} ${f.intensity} ${seconds(
          f.duration,
        )} ${f.ok ? "sent" : "failed"}`,
      }),
    ),
  );
}

function render() {
  const view = state.view;
  if (!view) return;

  const header = el("div", { class: "row" }, [
    el("span", { text: humanExpiry(view.expiresIn) }),
    el("span", { id: "guest-count", text: `${view.guests} here` }),
  ]);

  const gate = [];
  if (!state.session && view.policy.passwordRequired) {
    gate.push(el("label", { for: "guest-password", text: "This link needs a password" }));
    gate.push(el("input", { type: "password", id: "guest-password" }));
  }

  const cards = view.devices.flatMap((device) => [
    el("h2", { text: device.name }),
    ...device.shockers.map(shockerCard),
  ]);

  const banner =
    view.status === "active"
      ? []
      : [
          el("p", {
            class: "error",
            text:
              view.status === "paused"
                ? "This link is paused by whoever made it. Stop still works."
                : "This link has ended.",
          }),
        ];

  root.replaceChildren(
    header,
    ...banner,
    el("div", { id: "notice" }),
    ...gate,
    ...cards,
    el("button", { type: "button", class: "stop-all", text: "STOP ALL", onclick: (e) => void stopAll(e.currentTarget) }),
    el("h2", { text: "Recent" }),
    el("p", { class: "note", text: "Live only, never recorded." }),
    el("ul", { class: "feed", id: "feed", "aria-live": "polite" }),
  );
  renderFeed();
  showFirstCommandGate();
}

async function refresh() {
  await loadView();
  render();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !state.firstCommandDialog) void stopAll();
});

setInterval(() => {
  if (state.cooldowns.size > 0) {
    for (const [alias, until] of state.cooldowns) {
      if (until <= Date.now()) state.cooldowns.delete(alias);
    }
    render();
  }
}, 1000);

setInterval(() => void refresh(), 30_000);

void refresh();

mountBotCheck(root);
