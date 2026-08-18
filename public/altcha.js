// Official ALTCHA v3 widget, served from this instance (public/vendor), so the
// page makes no third-party request.
//
// It does no work on load. The widget sits idle and invisible until an action
// actually needs a solution, then appears as a popup anchored to the button
// that was pressed, does its proof of work, and goes away again. Nobody who
// only reads a page ever pays for hashing.

let loaded = null;
let widget = null;
let statusLine = null;

/**
 * The widget ships workers built from blob: URLs, which would need a
 * `worker-src blob:` exception. ALTCHA publishes the same worker code as
 * standalone files, so they are served from this origin and registered over the
 * defaults, and the policy stays `worker-src 'self'`.
 */
function useSameOriginWorkers() {
  const registry = globalThis.$altcha?.algorithms;
  if (!registry) return;
  const workers = {
    "PBKDF2/SHA-256": "/assets/vendor/altcha-pbkdf2.worker.js",
    "PBKDF2/SHA-384": "/assets/vendor/altcha-pbkdf2.worker.js",
    "PBKDF2/SHA-512": "/assets/vendor/altcha-pbkdf2.worker.js",
    "SHA-256": "/assets/vendor/altcha-sha.worker.js",
    "SHA-384": "/assets/vendor/altcha-sha.worker.js",
    "SHA-512": "/assets/vendor/altcha-sha.worker.js",
  };
  for (const [algorithm, url] of Object.entries(workers)) {
    registry.set(algorithm, () => new Worker(url));
  }
}

async function loadWidget() {
  loaded ??= import("/assets/vendor/altcha.min.js").then(async (module) => {
    useSameOriginWorkers();
    await customElements.whenDefined("altcha-widget");
    return module;
  });
  return loaded;
}

function status(text) {
  const line = document.getElementById("botcheck-status");
  if (!line) return;
  line.textContent = text ?? "";
  line.hidden = !text;
}

/**
 * Places the widget on the page without starting it. Returns false when this
 * page does not need a check at all.
 */
export function mountBotCheck(container) {
  if (!container?.dataset?.botcheck) return false;

  // Our own words, shown only while the check is actually running: the widget's
  // text explains its state, but not what it is or where the work goes.
  statusLine = document.createElement("p");
  statusLine.className = "note";
  statusLine.id = "botcheck-status";
  statusLine.setAttribute("aria-live", "polite");
  statusLine.hidden = true;
  container.before(statusLine);

  widget = document.createElement("altcha-widget");
  widget.id = "botcheck";
  widget.setAttribute("challenge", "/api/altcha/challenge");
  // Nothing runs until an action asks for it.
  widget.setAttribute("auto", "off");
  widget.setAttribute("type", "checkbox");
  widget.setAttribute("theme", "business");
  widget.setAttribute(
    "configuration",
    JSON.stringify({
      // Page-level checks use a popup anchored to the action that requested it.
      display: "floating",
      floatingPersist: false,
      // Remove the inline-SVG logo while preserving the widget's textual status
      // and attribution.
      hideLogo: true,
      hideFooter: false,
      humanInteractionSignature: false,
    }),
  );
  container.before(widget);

  // Preload the widget code so the first protected action can begin immediately.
  void loadWidget();
  return true;
}

/** Move the widget into a modal's top layer without starting the check. */
export function placeBotCheck(container) {
  if (!container || !widget) return;
  if (statusLine) container.append(statusLine);
  container.append(widget);
}

/** Return the widget beside its page root so later session renewals can use it. */
export function restoreBotCheck(container) {
  if (!container || !widget) return;
  if (statusLine) container.before(statusLine);
  container.before(widget);
}

/**
 * Runs the check for one action and returns its solution, or undefined if the
 * page needs no check. Each solution is spent server-side on first use, so this
 * always earns a fresh one rather than reusing the last.
 *
 * `anchor` is the element the popup attaches to: pass the button that was
 * pressed.
 */
export async function consumeBotCheck(container, anchor) {
  if (!container?.dataset?.botcheck) return undefined;

  try {
    await loadWidget();
    if (!widget) return undefined;

    await widget.configure?.({ display: "floating", floatingAnchor: anchor ?? null });
    widget.reset?.();

    status("Bot check: your browser is solving a small puzzle here, on this site. Nothing is sent to anyone else.");
    const result = await widget.verify();
    status(null);
    return result?.payload ?? undefined;
  } catch {
    status("Bot check failed. Reload the page and try again.");
    return undefined;
  }
}
