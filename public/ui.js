// Site-native dialogs keep warnings legible and visually consistent throughout
// the application, including confirmation flows for destructive actions.

export function clearInvalid(control) {
  control?.removeAttribute("aria-invalid");
}

export function markInvalid(...controls) {
  const invalid = controls.flatMap((control) =>
    control && !control.setAttribute && typeof control !== "string" && Symbol.iterator in Object(control)
      ? [...control]
      : [control],
  ).filter(Boolean);
  for (const control of invalid) {
    control.setAttribute("aria-invalid", "true");
    const event = control.matches?.('input[type="checkbox"], input[type="radio"], select') ? "change" : "input";
    control.addEventListener(event, () => clearInvalid(control), { once: true });
  }
  invalid[0]?.focus();
  return false;
}

export function validateFields(controls) {
  const invalid = [...controls].filter((control) => !control.checkValidity());
  return invalid.length === 0 || markInvalid(invalid);
}

export function siteDialog({
  title,
  message,
  confirmText = "Continue",
  cancelText = "Cancel",
  danger = false,
  requiredText = null,
  value = null,
}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "site-dialog";

    const heading = document.createElement("h2");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = message;
    dialog.append(heading, copy);

    let input = null;
    if (requiredText !== null) {
      const label = document.createElement("label");
      label.htmlFor = "dialog-confirm-text";
      label.textContent = `Type "${requiredText}" to confirm`;
      input = document.createElement("input");
      input.id = "dialog-confirm-text";
      input.type = "text";
      input.autocomplete = "off";
      dialog.append(label, input);
    }
    if (value !== null) {
      const field = document.createElement("div");
      field.className = "copy-field";
      const shown = document.createElement("input");
      shown.type = "text";
      shown.readOnly = true;
      shown.value = value;
      shown.setAttribute("aria-label", "Recovery string");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy text";
      copy.addEventListener("click", async () => {
        let copied = false;
        try {
          await navigator.clipboard.writeText(value);
          copied = true;
        } catch {
          shown.focus();
          shown.select();
          try {
            copied = document.execCommand("copy");
          } catch {
            copied = false;
          }
        }
        copy.textContent = copied ? "Copied" : "Copy failed";
        window.setTimeout(() => (copy.textContent = "Copy text"), 1800);
      });
      field.append(shown, copy);
      dialog.append(field);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    if (cancelText !== null) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = cancelText;
      cancel.addEventListener("click", () => dialog.close("cancel"));
      actions.append(cancel);
    }
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = confirmText;
    accept.className = danger ? "danger" : "primary";
    accept.disabled = input !== null;
    input?.addEventListener("input", () => {
      accept.disabled = input.value !== requiredText;
    });
    accept.addEventListener("click", () => dialog.close("accept"));
    actions.append(accept);
    dialog.append(actions);

    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "accept";
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    (input ?? accept).focus();
  });
}

export function notice(title, message, value = null) {
  return siteDialog({ title, message, value, confirmText: "Close", cancelText: null });
}
