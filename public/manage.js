// One link's settings. No tabs, no guest list, no log: that data is not kept.

import { markInvalid, siteDialog, validateFields } from "/assets/ui.js";

const root = document.getElementById("manage");
const token = root.dataset.token;

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

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function message(text, cls = "ok") {
  const box = document.getElementById("manage-message");
  if (box) {
    box.textContent = text;
    box.className = cls;
  }
}

function expiryText(at) {
  const secs = Math.floor((at - Date.now()) / 1000);
  if (secs <= 0) return "expired";
  if (secs < 3600) return `expires in about ${Math.max(1, Math.round(secs / 60))} minutes`;
  if (secs < 86400) return `expires in about ${Math.round(secs / 3600)} hours`;
  return `expires in about ${Math.round(secs / 86400)} days`;
}

async function load() {
  const { status, body } = await api(`/api/m/${token}`);
  if (status !== 200) {
    root.replaceChildren(el("p", { class: "error", text: "This manage link is no longer valid." }));
    return;
  }
  render(body);
}

function shockerBlock(shocker, data) {
  const id = shocker.alias;
  return el("div", { class: "card" }, [
    el("h3", { text: shocker.displayName }),
    el("p", { class: "note", text: `Alias ${shocker.alias}. Guests see the name above, never the alias meaning.` }),
    el("label", { for: `n-${id}`, text: "Public name (1 to 64 characters)" }),
    el("input", { type: "text", id: `n-${id}`, value: shocker.displayName, required: true, maxlength: "64" }),
    el("label", { for: `mi-${id}`, text: `Intensity ceiling (min 0, max ${shocker.maxIntensity}; can only be lowered)` }),
    el("input", { type: "number", id: `mi-${id}`, min: "0", max: String(shocker.maxIntensity), value: String(shocker.maxIntensity), required: true }),
    el("label", { for: `md-${id}`, text: `Duration ceiling in ms (min 300, max ${shocker.maxDuration}; can only be lowered)` }),
    el("input", { type: "number", id: `md-${id}`, min: "300", max: String(shocker.maxDuration), step: "100", value: String(shocker.maxDuration), required: true }),
    el("label", { for: `cd-${id}`, text: "Cooldown, ms (min 0, max 600000)" }),
    el("input", { type: "number", id: `cd-${id}`, min: "0", max: "600000", value: String(shocker.cooldownMs), required: true }),
    el("p", {
      class: "note",
      text:
        `Currently allows: ${[shocker.allowVibrate && "Vibrate", shocker.allowSound && "Sound", shocker.allowShock && "Shock"]
          .filter(Boolean)
          .join(", ") || "nothing"}. Permissions can be turned off here; turning one on needs a refresh so it is re-checked upstream.`,
    }),
    ...["Vibrate", "Sound", "Shock"]
      .filter((kind) => shocker[`allow${kind}`])
      .map((kind) =>
        el("div", { class: "row" }, [
          el("input", { type: "checkbox", id: `off-${kind}-${id}` }),
          el("label", { for: `off-${kind}-${id}`, text: `Turn ${kind} off` }),
        ]),
      ),
    el("div", { class: "row" }, [
      el("input", { type: "checkbox", id: `h-${id}`, ...(shocker.hidden ? { checked: true } : {}) }),
      el("label", { for: `h-${id}`, text: "Hidden from guests" }),
    ]),
    el("p", {
      class: "note",
      text: `Binding ceiling: instance allows ${data.instanceMaxIntensity} and ${seconds(data.instanceMaxDuration)}.`,
    }),
  ]);
}

function render(data) {
  const killed = data.status === "killed";

  const shockers = data.devices.flatMap((device) => [
    el("h2", { text: device.displayName }),
    ...device.shockers.map((s) => shockerBlock(s, data)),
  ]);

  root.replaceChildren(
    el("div", { id: "manage-message" }),
    el("section", {}, [
      el("h2", { text: "Guest link" }),
      el("p", { class: "copy", text: data.guestUrl }),
      el("p", { class: "note", text: `${data.status}, ${expiryText(data.expiresAt)}, ${data.guests} here now` }),
    ]),
    el("button", {
      type: "button",
      class: "stop-all",
      text: killed ? "RESUME THIS LINK" : "STOP ALL AND PAUSE THIS LINK",
      onclick: async () => {
        const { status } = await api(`/api/m/${token}/${killed ? "resume" : "kill"}`, "POST");
        message(status === 200 ? (killed ? "Resumed." : "Stopped and paused.") : "That did not work.", status === 200 ? "ok" : "error");
        void load();
      },
    }),
    el("section", {}, [
      el("h2", { text: "Link settings" }),
      el("label", { for: "title", text: "Title (1 to 64 characters)" }),
      el("input", { type: "text", id: "title", value: data.title, required: true, maxlength: "64" }),
      el("label", { for: "author", text: "Shown as (1 to 32 characters)" }),
      el("input", { type: "text", id: "author", value: data.author, required: true, maxlength: "32" }),
      el("label", { for: "rate", text: "Commands per minute, per guest (min 0, max 120)" }),
      el("input", { type: "number", id: "rate", min: "0", max: "120", value: String(data.rateLimitPerMin), required: true }),
      el("p", { class: "note", text: "Set to 0 for unlimited commands per guest." }),
      el("label", { for: "link-rate", text: "Commands per minute, whole link (min 0, max 600)" }),
      el("input", { type: "number", id: "link-rate", min: "0", max: "600", value: String(data.linkRateLimitPerMin), required: true }),
      el("p", { class: "note", text: "Set to 0 for unlimited commands across the whole link. Per-shocker cooldowns still apply." }),
    ]),
    el("section", {}, shockers),
    el("section", {}, [
      el("h2", { text: "Save" }),
      el("button", { type: "button", text: "Save changes", onclick: () => void save(data) }),
    ]),
    el("section", {}, [
      el("h2", { text: "Rotate and end" }),
      el("button", {
        type: "button",
        text: "Refresh from upstream",
        onclick: async () => {
          const { status } = await api(`/api/m/${token}/refresh`, "POST");
          message(status === 200 ? "Refreshed. New shockers arrive hidden." : "Upstream could not be read.", status === 200 ? "ok" : "error");
          void load();
        },
      }),
      el("button", {
        type: "button",
        text: "New aliases",
        onclick: async () => {
          await api(`/api/m/${token}/rotate-aliases`, "POST");
          message("Aliases rotated.");
          void load();
        },
      }),
      el("button", {
        type: "button",
        text: "New guest link",
        onclick: async () => {
          const { status, body } = await api(`/api/m/${token}/rotate-slug`, "POST");
          message(status === 200 ? `New guest link: ${body.guestUrl}` : "That did not work.");
          void load();
        },
      }),
      el("button", {
        type: "button",
        class: "danger",
        text: "Delete this link",
        onclick: async () => {
          const confirmed = await siteDialog({
            title: "Delete this link?",
            message: "This permanently removes the link and all of its stored settings.",
            confirmText: "Delete link permanently",
            danger: true,
            requiredText: data.title,
          });
          if (!confirmed) return;
          const { status } = await api(`/api/m/${token}`, "DELETE");
          if (status === 200) {
            root.replaceChildren(el("p", { text: "Deleted. Nothing about it remains." }));
          }
        },
      }),
    ]),
  );
}

async function save(data) {
  const val = (id) => document.getElementById(id).value.trim();
  const num = (id) => Number.parseInt(document.getElementById(id).value, 10);
  const checked = (id) => document.getElementById(id)?.checked ?? false;

  const controls = root.querySelectorAll('input[type="text"], input[type="number"]');
  const blank = [...root.querySelectorAll('input[type="text"]')].filter((input) => input.value.trim() === "");
  if (!validateFields(controls) || (blank.length > 0 && !markInvalid(blank))) {
    message("Correct the highlighted settings before saving.", "error");
    return;
  }

  const shockers = data.devices.flatMap((device) =>
    device.shockers.map((s) => {
      const patch = {
        alias: s.alias,
        displayName: val(`n-${s.alias}`),
        maxIntensity: num(`mi-${s.alias}`),
        maxDuration: num(`md-${s.alias}`),
        cooldownMs: num(`cd-${s.alias}`),
        hidden: checked(`h-${s.alias}`),
      };
      if (checked(`off-Shock-${s.alias}`)) patch.allowShock = false;
      if (checked(`off-Vibrate-${s.alias}`)) patch.allowVibrate = false;
      if (checked(`off-Sound-${s.alias}`)) patch.allowSound = false;
      return patch;
    }),
  );

  const { status, body } = await api(`/api/m/${token}`, "PATCH", {
    title: val("title"),
    author: val("author"),
    rateLimitPerMin: num("rate"),
    linkRateLimitPerMin: num("link-rate"),
    shockers,
  });
  if (status !== 200 && body?.field) {
    const selector = {
      title: "#title",
      author: "#author",
      rateLimitPerMin: "#rate",
      linkRateLimitPerMin: "#link-rate",
      maxIntensity: 'input[id^="mi-"]',
      maxDuration: 'input[id^="md-"]',
      cooldownMs: 'input[id^="cd-"]',
    }[body.field] ?? (body.field.includes("maxIntensity")
      ? 'input[id^="mi-"]'
      : body.field.includes("maxDuration")
        ? 'input[id^="md-"]'
        : body.field.includes("cooldownMs")
          ? 'input[id^="cd-"]'
          : null);
    if (selector) markInvalid(root.querySelectorAll(selector));
  }
  message(status === 200 ? "Saved." : `Not saved: ${body?.type ?? "error"}.`, status === 200 ? "ok" : "error");
  void load();
}

void load();
