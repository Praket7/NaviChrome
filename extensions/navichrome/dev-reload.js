// Self-service reload for the unpacked extension.
//
// Chrome keeps the previously loaded background service worker and modules in
// memory until the extension itself is reloaded. There is no CDP or native
// messaging path into stale code, so the only bootstrap that always works is an
// extension page: pages are served from disk, and `chrome.runtime.reload()`
// re-reads background.js, lib/*, and the manifest.
//
// Open chrome-extension://<id>/dev-reload.html to reload.
//   ?auto=0  render the button instead of reloading immediately
//   ?close=1 close this tab once the reload request is accepted
//
// The page is deliberately idempotent: a reload that completes within
// LOOP_GUARD_MS leaves a "complete" marker in session storage, so a reload that
// is itself restored by Chrome does not start another one.

const KEY = "navichrome_dev_reload_v1";
const LOOP_GUARD_MS = 20_000;

const params = new URLSearchParams(location.search);
const statusNode = document.getElementById("status");
const detailNode = document.getElementById("detail");
const button = document.getElementById("reload");

function render(state, text, detail = "") {
  document.title = `navichrome-dev-reload:${state}`;
  if (statusNode) {
    statusNode.dataset.state = state;
    statusNode.textContent = text;
  }
  if (detailNode) detailNode.textContent = detail;
}

async function readMarker() {
  try {
    const stored = await chrome.storage.session.get(KEY);
    return stored?.[KEY] ?? null;
  } catch {
    return null;
  }
}

async function writeMarker(marker) {
  try {
    await chrome.storage.session.set({ [KEY]: marker });
    return true;
  } catch {
    return false;
  }
}

async function reloadNow() {
  render("reloading", "Reloading extension…");
  try {
    await chrome.storage.session.remove("nativeReconnectAttempts").catch(() => {});
    chrome.runtime.reload();
    return true;
  } catch (error) {
    render("error", "Reload failed.", String(error?.message ?? error));
    return false;
  }
}

if (button) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    if (await reloadNow() && params.get("close") === "1") window.close();
  });
}

const marker = await readMarker();
const age = Date.now() - Number(marker?.requested_at ?? 0);
const justReloaded = marker?.pending === true && age >= 0 && age < LOOP_GUARD_MS;

if (justReloaded) {
  const completed = {
    pending: false,
    count: Number(marker.count ?? 0) + 1,
    requested_at: marker.requested_at,
    completed_at: Date.now(),
  };
  await writeMarker(completed);
  render(
    "complete",
    `Reload complete (#${completed.count}).`,
    `background.js and lib/* were re-read from disk ${Math.round(age / 1000)}s ago. Rediscover tabs before acting.`,
  );
} else if (params.get("auto") === "0") {
  render("ready", "Ready to reload.", "Automatic reload is disabled by ?auto=0.");
} else {
  render("ready", "Reloading extension…", "Waiting for chrome.runtime.reload().");
  const requested = await writeMarker({
    pending: true,
    count: Number(marker?.count ?? 0),
    requested_at: Date.now(),
  });
  // A failed marker write only costs the loop guard, not the reload.
  if (!requested) detailNode && (detailNode.textContent = "Session marker unavailable; reload still requested.");
  if (!(await reloadNow())) {
    // Nothing else to do: surface the error and leave the button usable.
    if (button) button.disabled = false;
  } else if (params.get("close") === "1") {
    window.close();
  }
}
