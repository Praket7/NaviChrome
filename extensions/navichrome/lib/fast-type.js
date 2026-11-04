// FastKeys transaction runner. The caller supplies the CDP transport and the
// page-side guard so this module cannot invent its own authorization boundary.
export async function fastTypeProgram({ tabId, params, isAuthorized, sendCdpCommand, safeNativeError, guardDeclaration }) {
  const { object_id: objectId, index, expected, text, normalize_paragraphs: normalizeParagraphs } = params || {};
  if (typeof objectId !== "string" || objectId.length < 1 || objectId.length > 1024 || !Number.isSafeInteger(index) || index < 0 || typeof expected !== "string" || expected.length > 16384 || typeof text !== "string" || text.length < 1 || text.length > 16384 || !/^[\x00-\x7f]*$/.test(text) || typeof normalizeParagraphs !== "boolean") throw new Error("fast_type requires a bounded retained editor, ASCII text, and newline policy.");
  if (text.replace(/\r\n/g, "\n").includes("\r")) throw new Error("fast_type text must use normalized newlines.");
  const deadline = performance.now() + Math.min(60000, Math.max(1000, Number.isSafeInteger(params.deadline_ms) ? params.deadline_ms : 30000));
  let progress = expected, completedChars = 0, keyEvents = 0, guardChecks = 0;
  const guard = async (value, prepare = false) => {
    if (!isAuthorized(tabId) || performance.now() >= deadline) return { ok: false, reason: "deadline_or_session_changed" };
    guardChecks++;
    try {
      const response = await sendCdpCommand({ tabId }, "Runtime.callFunctionOn", { objectId, functionDeclaration: guardDeclaration, arguments: [{ value: index }, { value }, { value: prepare }, { value: normalizeParagraphs }, { value: true }], returnByValue: true });
      return response?.result?.value || { ok: false, reason: "guard_response_missing" };
    } catch { return { ok: false, reason: "guard_read_failed" }; }
  };
  const before = await guard(progress, true);
  if (before.ok !== true) return { status: "not_dispatched", completed_chars: 0, key_events: 0, cdp_commands: guardChecks, readback: before.value, reason: before.reason || "editor_guard_rejected" };
  // A plain input/textarea has no editor model that needs per-key observation.
  // Per-key guard checks make a 1000-character fast-key task spend four CDP
  // round trips per character. For long plain text, one trusted insertion is
  // the same final text with one dispatch; short text and rich editors keep the
  // ordered key path so composition and event semantics stay observable.
  if (!before.rich && text.length >= 256) {
    try {
      await sendCdpCommand({ tabId }, "Input.insertText", { text });
    } catch (error) {
      return { status: "unknown", completed_chars: 0, key_events: 0, cdp_commands: guardChecks + 1, readback: progress, reason: "bulk_insert_delivery_unknown", input_method: "insertText", error: safeNativeError(String(error)) };
    }
    const afterInsert = await guard(progress + text);
    return afterInsert.ok === true
      ? { status: "verified", completed_chars: text.length, key_events: 0, cdp_commands: guardChecks + 1, readback: progress + text, input_method: "insertText" }
      : { status: "unknown", completed_chars: 0, key_events: 0, cdp_commands: guardChecks + 1, readback: afterInsert.value ?? progress, reason: "bulk_insert_readback_failed", input_method: "insertText", guard: afterInsert };
  }
  for (const character of text) {
    if (!isAuthorized(tabId) || performance.now() >= deadline) return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "typing_deadline_or_session_change" };
    if (completedChars > 0) {
      const beforeNextKey = await guard(progress);
      if (beforeNextKey.ok !== true) return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "focus_or_value_changed_before_next_keydown", guard: beforeNextKey };
    }
    const enter = character === "\n", key = enter ? "Enter" : character;
    const keyDown = enter ? { type: "keyDown", key, code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36, text: "\r", unmodifiedText: "\r" } : { type: "keyDown", key };
    keyEvents++;
    try { await sendCdpCommand({ tabId }, "Input.dispatchKeyEvent", keyDown); }
    catch (error) { return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "key_down_delivery_unknown", error: safeNativeError(String(error)) }; }
    if (enter) progress += character;
    const afterDown = await guard(progress);
    if (afterDown.ok !== true) return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "focus_or_value_changed_after_keydown", guard: afterDown };
    if (!enter) {
      keyEvents++;
      try { await sendCdpCommand({ tabId }, "Input.dispatchKeyEvent", { type: "char", key, text: character, unmodifiedText: character }); }
      catch (error) { return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "character_delivery_unknown", error: safeNativeError(String(error)) }; }
      progress += character;
    }
    const afterInput = enter ? afterDown : await guard(progress);
    if (afterInput.ok !== true) return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "focus_or_value_changed_after_character", guard: afterInput };
    keyEvents++;
    try { await sendCdpCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key, ...(enter ? { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 } : {}) }); }
    catch (error) { return { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "key_up_delivery_unknown", error: safeNativeError(String(error)) }; }
    completedChars++;
  }
  const final = await guard(progress);
  return final.ok === true
    ? { status: "verified", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress }
    : { status: "unknown", completed_chars: completedChars, key_events: keyEvents, cdp_commands: keyEvents + guardChecks, readback: progress, reason: "final_editor_guard_failed", guard: final };
}
