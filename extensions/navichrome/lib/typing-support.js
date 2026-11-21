// Readback and pacing helpers shared by the text transaction paths.

import { CONNECTED_PROBE } from "./input-scripts.js";

// Canvas editors keep their text outside the editable element, but the page
// still renders it. A before/after read of the document text is the only
// verification these surfaces can honestly offer.
export async function pageText(ctx, target) {
  try {
    const response = await ctx.send(target, "Runtime.evaluate", {
      // Same-origin frames are part of the visible page: an editor may render
      // its text in a child document (Google Docs) rather than the top one.
      expression: "(()=>{const parts=[],seen=new Set();const walk=doc=>{if(!doc||seen.has(doc))return;seen.add(doc);try{parts.push(doc.body?(doc.body.innerText||''):'')}catch(_){}let frames=[];try{frames=Array.from(doc.querySelectorAll('iframe,frame'))}catch(_){frames=[]}for(const f of frames){try{if(f.contentDocument)walk(f.contentDocument)}catch(_){}}};walk(document);return parts.join('\\n').slice(0,200000)})()",
      returnByValue: true,
    });
    const value = response?.result?.value;
    return typeof value === "string" ? value.replace(/\u00a0/g, " ") : null;
  } catch {
    return null;
  }
}

export function verificationNeedle(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  const line = normalized.split("\n").map(part => part.trim()).find(part => part.length >= 8);
  const needle = line ?? normalized.trim();
  return needle.length >= 8 && needle.length <= 400 ? needle : null;
}

export async function stillConnected(ctx, target, objectId, index) {
  try {
    const response = await ctx.send(target, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: CONNECTED_PROBE,
      arguments: [{ value: index }],
      returnByValue: true,
    });
    return response?.result?.value?.ok === true;
  } catch {
    return false;
  }
}

export function expectedProgress(transaction, dispatched, baseValue = "") {
  if (transaction.operation === "append") return { kind: "exact_value", value: baseValue + dispatched };
  if (transaction.operation === "replace") return { kind: "exact_value", value: dispatched };
  return { kind: "contains", value: dispatched };
}

export async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

// A human types, on average, about 40 words per minute, which is roughly 200
// characters per minute or 300 ms per character. Real typing is not metronomic:
// letter-to-letter intervals vary by more than half again, and the pauses grow
// at word boundaries and after sentence punctuation. `pacingMs` is the mean
// interval; this maps it to one plausible pause for the character just typed.
export function humanPacingMs(meanMs, character) {
  if (!(meanMs > 0)) return 0;
  const jitter = 0.55 + Math.random() * 1.1; // 0.55x .. 1.65x
  let factor = jitter / 1.1; // keep the long-run mean at 1x
  if (character === " ") factor *= 1.2;
  else if (character === "," || character === ";" || character === ":") factor *= 1.7;
  else if (character === "." || character === "!" || character === "?") factor *= 2.3;
  else if (character === "\n") factor *= 2.1;
  return Math.min(1500, Math.max(18, Math.round(meanMs * factor)));
}

// On an unreadable surface, the only honest completed-character count is what
// the page text proves landed. A trusted key can be queued and never applied
// when the tab hides, so the dispatched count can be one or more ahead of the
// editor. Walking back a bounded number of characters distinguishes "sent" from
// "present" without pretending the editor gave a real readback.
export function landedPrefix(typed, pageBefore, pageAfter, maxChecks = 8) {
  if (typeof pageAfter !== "string" || typeof typed !== "string" || !typed) return null;
  const before = typeof pageBefore === "string" ? pageBefore : "";
  const floor = Math.max(1, typed.length - Math.max(1, maxChecks));
  for (let end = typed.length; end >= floor; end -= 1) {
    const candidate = typed.slice(0, end);
    if (candidate.trim().length >= 4 && pageAfter.includes(candidate) && !before.includes(candidate)) {
      return end;
    }
  }
  return null;
}

// Keep the guard/key loop on the extension side of the native bridge. The
// retained renderer function carries the editor and collapsed caret binding.
export async function canvasHumanBatch(tabId, params, { send, isAuthorized, now = () => performance.now(), sleep = delay }) {
  const { object_id: objectId, text, delay_ms: pace, more, budget_ms: budget } = params ?? {};
  const characters = typeof text === "string" ? Array.from(text) : [];
  let completed = 0, keys = 0, commands = 0, attempted = false;
  const receipt = (status, reason) => ({
    status, reason_code: reason, completed_chars: completed, key_events: keys,
    cdp_commands: commands, dispatch_may_have_occurred: attempted,
  });
  if (typeof objectId !== "string" || !objectId || objectId.length > 1024 ||
      characters.length < 1 || characters.length > 32 ||
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text) ||
      !Number.isInteger(pace) || pace < 0 || pace > 600 || typeof more !== "boolean" ||
      !Number.isInteger(budget) || budget < 1 || budget > 8000) {
    return receipt("not_dispatched", "canvas_batch_invalid");
  }
  const deadline = now() + budget;
  const current = () => isAuthorized(tabId) && now() < deadline;
  const call = async (method, args) => {
    if (!current()) throw new Error("canvas batch no longer authorized or within deadline");
    commands++;
    return send({ tabId }, method, args, Math.max(1, Math.ceil(deadline - now())));
  };
  const guard = async (phase, fallback) => {
    const value = (await call("Runtime.callFunctionOn", {
      objectId, functionDeclaration: "function(phase){return this(phase)}",
      arguments: [{ value: phase }], returnByValue: true,
    })).result?.value;
    return value === true ? null : typeof value === "string" ? value : fallback;
  };
  const sendKey = async event => {
    if (!current()) throw new Error("canvas batch authorization changed");
    attempted = true;
    await call("Input.dispatchKeyEvent", event);
    keys++;
  };
  try {
    for (const [index, character] of characters.entries()) {
      const started = now();
      const before = await guard("check", "canvas_caret_changed");
      if (before) return receipt(attempted ? "unknown" : "not_dispatched", before);
      const enter = character === "\n";
      const identity = enter ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 } : { key: character };
      const up = { ...identity, type: "keyUp" };
      try {
        await sendKey({ ...identity, type: "keyDown", ...(enter ? { text: "\r", unmodifiedText: "\r" } : {}) });
        if (!enter) {
          const afterDown = await guard("check", "canvas_focus_changed");
          if (afterDown) return receipt("unknown", afterDown);
          await sendKey({ ...identity, type: "char", text: character, unmodifiedText: character });
        }
        const beforeUp = await guard("focus", "canvas_focus_changed");
        if (beforeUp) return receipt("unknown", beforeUp);
      } catch {
        if (attempted && await guard("focus", "canvas_focus_changed").catch(() => "canvas_focus_changed") === null) await sendKey(up).catch(() => {});
        return receipt(attempted ? "unknown" : "not_dispatched", "canvas_key_delivery_unknown");
      }
      await sendKey(up);
      const after = await guard("stamp", "canvas_caret_changed");
      if (after) return receipt("unknown", after);
      completed++;
      if (index + 1 < characters.length || more) {
        const spacing = /[.!?\n]/u.test(character) ? pace * 2 : pace;
        const wait = started + spacing - now();
        if (wait > 0) await sleep(Math.min(wait, Math.max(0, deadline - now())));
      }
    }
    return receipt("delivered");
  } catch {
    return receipt(attempted ? "unknown" : "not_dispatched", "canvas_batch_interrupted");
  }
}
