// Bounded console and failed-network diagnostics for one paired tab.
// The service worker supplies the command transport and document observer.

const MAX_ENTRIES = 32;
const MAX_TEXT = 240;

export function createPageDiagnostics({ sendCommand, documentIdForTab }) {
  const states = new Map();

  function stateFor(tabId) {
    let state = states.get(tabId);
    if (!state) {
      state = { entries: [], requests: new Map(), dropped: 0, documentId: undefined, frameId: undefined,
        domains: { runtime: "not_enabled", log: "not_enabled", network: "not_enabled" }, captureErrors: [], enablePromise: undefined };
      states.set(tabId, state);
    }
    return state;
  }

  function reset(state, documentId) {
    state.entries = [];
    state.requests.clear();
    state.dropped = 0;
    state.documentId = documentId;
  }

  function record(tabId, method, params) {
    if (!states.has(tabId) && !documentIdForTab(tabId)) return;
    const state = stateFor(tabId);
    if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
      reset(state, documentIdForTab(tabId));
      state.frameId = params?.frame?.id;
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const url = boundedUrl(params?.request?.url), requestId = params?.requestId;
      if (!url || typeof requestId !== "string" || typeof params?.request?.method !== "string") return;
      if (state.requests.size >= 64) state.requests.delete(state.requests.keys().next().value);
      state.requests.set(requestId, { ...url, method: boundedText(params.request.method, 16) });
      return;
    }
    if (method === "Network.responseReceived") {
      const request = state.requests.get(params?.requestId);
      if (!request) return;
      state.requests.delete(params.requestId);
      const status = Number(params?.response?.status);
      if (Number.isFinite(status) && status >= 400) {
        push(state, { kind: "network", ...request, status,
          ...(params.response?.statusText ? { status_text: boundedText(params.response.statusText, 80) } : {}) });
      }
      return;
    }
    if (method === "Network.loadingFailed") {
      const request = state.requests.get(params?.requestId);
      if (!request) return;
      state.requests.delete(params.requestId);
      push(state, { kind: "network", ...request,
        ...(params?.errorText ? { error: boundedText(params.errorText, 120) } : {}),
        ...(params?.blockedReason ? { blocked_reason: boundedText(params.blockedReason, 80) } : {}),
        ...(params?.corsErrorStatus?.corsError ? { cors_error: boundedText(params.corsErrorStatus.corsError, 80) } : {}) });
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const level = params?.type;
      if (!["error", "warning", "assert"].includes(level)) return;
      const text = (Array.isArray(params?.args) ? params.args : []).slice(0, 8).map(argument => {
        if (typeof argument?.value === "string") return argument.value;
        if (["number", "boolean"].includes(typeof argument?.value)) return String(argument.value);
        return typeof argument?.description === "string" ? argument.description : `[${argument?.type || "value"}]`;
      }).join(" ");
      if (text) push(state, { kind: "console", level, source: "runtime", text: boundedText(text) });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const text = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || "uncaught exception";
      push(state, { kind: "exception", level: "error", source: "runtime", text: boundedText(text) });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params?.entry || {};
      if (!["error", "warning"].includes(entry.level)) return;
      const url = boundedUrl(entry.url);
      push(state, { kind: "log", level: entry.level, source: entry.source || "browser", text: boundedText(entry.text || "browser log entry"),
        ...(url ? { scheme: url.scheme, host: url.host, path: url.path } : {}) });
    }
  }

  async function ensure(tabId) {
    const state = stateFor(tabId);
    if (state.enablePromise) return state.enablePromise;
    state.enablePromise = (async () => {
      for (const [key, method] of [["runtime", "Runtime.enable"], ["log", "Log.enable"], ["network", "Network.enable"]]) {
        if (state.domains[key] === "enabled") continue;
        try {
          await sendCommand({ tabId }, method, {});
          state.domains[key] = "enabled";
        } catch (error) {
          state.domains[key] = "unavailable";
          if (state.captureErrors.length < 4) state.captureErrors.push(`${key}: ${String(error).slice(0, 120)}`);
        }
      }
    })();
    try { await state.enablePromise; } finally { state.enablePromise = undefined; }
  }

  async function snapshot(tabId, expectedDocumentId, limit, clear) {
    const state = stateFor(tabId);
    if (state.documentId && expectedDocumentId && state.documentId !== expectedDocumentId) reset(state, expectedDocumentId);
    state.documentId = expectedDocumentId || state.documentId;
    await ensure(tabId);
    const total = state.entries.length, returned = Math.min(total, limit);
    const entries = state.entries.slice(-returned);
    const dropped = state.dropped, omittedByLimit = total - returned;
    const result = { status: "observed", document_id: state.documentId, entries, captured: total, returned,
      omitted_by_limit: omittedByLimit, dropped, truncated: dropped > 0, cleared: clear,
      capture: { ...state.domains, capture_errors: state.captureErrors },
      bounds: { max_entries: MAX_ENTRIES, max_text_chars: MAX_TEXT } };
    if (clear) reset(state, state.documentId);
    return result;
  }

  function clear(tabId) { states.delete(tabId); }

  function warm(tabId) { return ensure(tabId); }

  function warmSoon(tabIds, delayMs = 10) {
    setTimeout(() => { for (const tabId of tabIds) if (documentIdForTab(tabId)) void warm(tabId).catch(() => {}); }, delayMs);
  }

  async function handleCommand(request, tabId, expectedDocumentId, respond) {
    if (request.method !== "Controlla.pageDiagnostics") return false;
    const limit = request.params?.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || (request.params?.clear !== undefined && typeof request.params.clear !== "boolean")) throw new Error("Page diagnostics require limit 1..32 and a boolean clear flag.");
    const result = await snapshot(tabId, expectedDocumentId, limit, request.params.clear === true);
    respond({ type: "result", id: request.id, result });
    return true;
  }

  return { record, snapshot, clear, warm, warmSoon, handleCommand };
}

export function boundedUploadUrl(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)(google\.com|googleapis\.com|googleusercontent\.com)$/.test(url.hostname)) return null;
    return { host: url.hostname, path: url.pathname.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 160) };
  } catch { return null; }
}

function push(state, entry) {
  if (state.entries.length >= MAX_ENTRIES) { state.entries.shift(); state.dropped++; }
  state.entries.push(entry);
}

function boundedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    return { scheme: url.protocol.slice(0, -1), host: url.hostname.slice(0, 255), path: (url.pathname || "/").slice(0, 160) };
  } catch { return null; }
}

function redactToken(token) {
  const lower = token.toLowerCase();
  if (["password=", "password:", "passwd=", "passwd:", "token=", "token:", "secret=", "secret:",
    "authorization:", "authorization=", "api_key=", "api_key:", "apikey=", "apikey:", "cookie=", "cookie:", "bearer"]
    .some(prefix => lower.startsWith(prefix))) return "<redacted>";
  const url = boundedUrl(token);
  return url ? `${url.scheme}://${url.host}${url.path}` : token;
}

function boundedText(value, limit = MAX_TEXT) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.split(" ").map(redactToken).join(" ").slice(0, limit);
}
