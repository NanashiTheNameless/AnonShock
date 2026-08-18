// This browser's links, from the holder cookie. Definitions and status only:
// there is no activity, no guest detail, and no history to show.

import { markInvalid, notice, siteDialog } from "/assets/ui.js";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

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

function expiryText(at) {
  const secs = Math.floor((at - Date.now()) / 1000);
  if (secs <= 0) return "expired";
  if (secs < 3600) return `expires in about ${Math.max(1, Math.round(secs / 60))} minutes`;
  if (secs < 86400) return `expires in about ${Math.round(secs / 3600)} hours`;
  return `expires in about ${Math.round(secs / 86400)} days`;
}

async function openManage(id) {
  const { status, body } = await api(`/api/holder/links/${id}/manage-url`);
  if (status !== 200) {
    await notice("Manage link unavailable", "A manage link could not be issued. Try again in a moment.");
    return;
  }
  location.href = body.manageUrl;
}

async function cancel(id, title) {
  const confirmed = await siteDialog({
    title: "Cancel this link?",
    message: "This permanently removes the link and cannot be undone.",
    confirmText: "Cancel link permanently",
    danger: true,
    requiredText: title,
  });
  if (!confirmed) return;
  // Cancelling goes through a freshly issued manage token for that one link.
  const issued = await api(`/api/holder/links/${id}/manage-url`);
  if (issued.status !== 200) {
    await notice("Link not cancelled", "A manage link could not be issued. Nothing was deleted.");
    return;
  }
  const token = issued.body.manageUrl.split("/m/")[1];
  await api(`/api/m/${token}`, "DELETE");
  void load();
}

async function togglePause(link) {
  const resume = link.status === "killed";
  const { status } = await api(`/api/holder/links/${link.id}/${resume ? "resume" : "pause"}`, "POST");
  if (status !== 200) {
    await notice(
      resume ? "Link not resumed" : "Link not paused",
      resume
        ? "This link cannot be resumed right now. Open Manage for more details."
        : "This link could not be stopped and paused. Try again in a moment.",
    );
  }
  void load();
}

async function load() {
  const box = document.getElementById("links");
  if (!box) return;
  const { status, body } = await api("/api/holder/links");
  if (status !== 200) {
    box.replaceChildren(el("p", { text: "This browser does not hold an access token." }));
    return;
  }
  if (body.links.length === 0) {
    box.replaceChildren(
      el("p", { text: "No links yet." }),
      el("p", {}, [el("a", { href: "/new", text: "Make one" })]),
    );
    return;
  }
  box.replaceChildren(
    ...body.links.map((link) =>
      el("div", { class: "card" }, [
        el("h3", { text: link.title }),
        el("p", { class: "note", text: `${link.status}, ${expiryText(link.expiresAt)}, ${link.shockerCount} shocker(s)` }),
        el("p", { class: "copy", text: link.guestUrl }),
        el("div", { class: "row" }, [
          el("a", { href: `/s/${link.slug}`, text: "Open" }),
          ...(["active", "killed"].includes(link.status)
            ? [el("button", {
                type: "button",
                class: link.status === "active" ? "danger" : "",
                text: link.status === "killed" ? "Resume" : "Pause",
                onclick: () => void togglePause(link),
              })]
            : []),
          el("button", { type: "button", text: "Manage", onclick: () => void openManage(link.id) }),
          el("button", {
            type: "button",
            class: "danger",
            text: "Cancel",
            onclick: () => void cancel(link.id, link.title),
          }),
        ]),
      ]),
    ),
  );
}

document.getElementById("import-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("recovery");
  const value = input.value.trim();
  if (!value) {
    markInvalid(input);
    return;
  }
  const { status } = await api("/api/holder/import", "POST", { recovery: value });
  if (status === 200) location.reload();
  else {
    markInvalid(input);
    await notice("Recovery failed", "That recovery string was not accepted.");
  }
});

document.getElementById("rotate")?.addEventListener("click", async () => {
  const confirmed = await siteDialog({
    title: "Rotate browser access?",
    message: "Every other browser that imported the old recovery string will lose access.",
    confirmText: "Rotate access",
    danger: true,
  });
  if (!confirmed) return;
  const { status, body } = await api("/api/holder/rotate", "POST");
  if (status === 200) {
    await notice("New recovery string", "Save this now. It is shown only once.", body.recovery);
  } else {
    await notice("Access not rotated", "The access token could not be rotated.");
  }
});

document.getElementById("cancel-all")?.addEventListener("click", async () => {
  const confirmed = await siteDialog({
    title: "Cancel every link?",
    message: "Every link held by this browser will be permanently removed.",
    confirmText: "Cancel every link",
    danger: true,
    requiredText: "cancel all",
  });
  if (!confirmed) return;
  const { status } = await api("/api/holder", "DELETE");
  if (status === 200) location.reload();
  else await notice("Links not cancelled", "Nothing was deleted. Try again in a moment.");
});

void load();
