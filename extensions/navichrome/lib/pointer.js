// Shared pointer/gesture planning. Geometry is always resolved immediately
// before trusted input; the model never has to locate scroll containers.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function resolveClickablePoint({ rect, viewport, rootPoint }) {
  if (!rect || !viewport) return null;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, viewport.width);
  const bottom = Math.min(rect.bottom, viewport.height);
  if (!(right > left && bottom > top)) return null;
  const x = left + (right - left) / 2;
  const y = top + (bottom - top) / 2;
  return rootPoint ? { x: rootPoint.x + x, y: rootPoint.y + y, localX: x, localY: y } : { x, y, localX: x, localY: y };
}

export function resolveScrollPlan({ rect, viewport, containerRect = null, margin = 24 }) {
  if (!rect || !viewport) return { needed: false, reason: "missing_geometry" };
  const bounds = containerRect ?? { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const visible = rect.top >= bounds.top + margin && rect.left >= bounds.left + margin
    && rect.bottom <= bounds.bottom - margin && rect.right <= bounds.right - margin;
  if (visible) return { needed: false };
  const dx = rect.right > bounds.right - margin ? rect.right - (bounds.right - margin)
    : rect.left < bounds.left + margin ? rect.left - (bounds.left + margin) : 0;
  const dy = rect.bottom > bounds.bottom - margin ? rect.bottom - (bounds.bottom - margin)
    : rect.top < bounds.top + margin ? rect.top - (bounds.top + margin) : 0;
  return { needed: dx !== 0 || dy !== 0, dx, dy };
}

export function interpolateDragPath(from, to, { steps = 8, maxSteps = 24 } = {}) {
  if (!from || !to) return [];
  const count = clamp(steps, 2, maxSteps);
  const path = [];
  for (let index = 1; index <= count; index += 1) {
    const fraction = index / count;
    path.push({
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
    });
  }
  return path;
}

export function clickBackendLadder({ semanticEquivalent, trustedRequired, frameLocal, unique }) {
  const ladder = [];
  if (semanticEquivalent && !trustedRequired) ladder.push("semantic_activation");
  ladder.push(frameLocal ? "frame_cdp_mouse" : "cdp_mouse");
  if (!unique) ladder.push("visual_grounded_coordinate");
  if (semanticEquivalent) ladder.push("keyboard_activation");
  return ladder;
}

export function touchPath(from, to, { steps = 6, maxSteps = 16 } = {}) {
  return interpolateDragPath(from, to, { steps, maxSteps });
}

// One trusted-input engine for root and child-frame routes. Callers own target
// identity validation and receipts; this module owns event vocabulary,
// ordering, interpolation, and release cleanup.
export class PointerEngine {
  constructor({ send } = {}) {
    if (typeof send !== "function") throw new Error("send is required");
    this.send = send;
  }

  async move(target, { x, y }, { button } = {}) {
    const event = { type: "mouseMoved", x, y };
    if (button) event.button = button;
    return this.send(target, "Input.dispatchMouseEvent", event);
  }

  async press(target, { x, y, button = "left", clickCount = 1 }) {
    return this.send(target, "Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount, x, y });
  }

  async release(target, { x, y, button = "left", clickCount = 1 }) {
    return this.send(target, "Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount, x, y });
  }

  async click(target, point, { button = "left", clickCount = 1, move = true } = {}) {
    if (move) await this.move(target, point);
    await this.press(target, { ...point, button, clickCount });
    await this.release(target, { ...point, button, clickCount });
  }

  async wheel(target, point, { deltaX = 0, deltaY = 0 } = {}) {
    await this.move(target, point, { button: "none" });
    return this.send(target, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
  }

  async touchStart(target, point) {
    return this.send(target, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }],
    });
  }

  async touchMove(target, point) {
    return this.send(target, "Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }],
    });
  }

  async touchEnd(target) {
    return this.send(target, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  // Two-finger gestures need both contact points in one trusted CDP event.
  // Single-point helpers stay intact for ordinary taps and swipes.
  async touchMulti(target, type, points) {
    if (!["touchStart", "touchMove", "touchEnd"].includes(type)) throw new Error("invalid touch phase");
    if (!Array.isArray(points) || points.length < 1 || points.length > 10) throw new Error("touch point count is out of bounds");
    const touchPoints = points.map((point, index) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("touch point geometry is invalid");
      return {
        id: Number.isSafeInteger(point.id) ? point.id : index + 1,
        x: point.x, y: point.y,
        radiusX: 1, radiusY: 1, force: 1,
      };
    });
    return this.send(target, "Input.dispatchTouchEvent", { type, touchPoints });
  }

  async touch(target, type, touchPoints) {
    return this.send(target, "Input.dispatchTouchEvent", { type, touchPoints });
  }

  async swipe(target, from, to, { steps = 6 } = {}) {
    await this.touchStart(target, from);
    for (const point of touchPath(from, to, { steps })) await this.touchMove(target, point);
    await this.touchEnd(target);
  }

  async drag(target, from, to, { steps = 8, button = "left" } = {}) {
    await this.move(target, from);
    await this.press(target, { ...from, button, clickCount: 1 });
    for (const point of interpolateDragPath(from, to, { steps })) await this.move(target, point);
    await this.release(target, { ...to, button, clickCount: 1 });
  }
}

export async function dispatchFrameClick(tabId, params, {
  sendCdpCommand, frameTreeWithChildren, frameActionablePoint, rootPointForFrame,
  frames, ensureAutoAttach, pointerEngine, isExactHttpUrl, isAuthorized,
}) {
  const frameId = params?.frame_id, loaderId = params?.loader_id, backendNodeId = params?.backend_node_id;
  if (typeof frameId !== "string" || !frameId || frameId.length > 256 || typeof loaderId !== "string" || !loaderId || loaderId.length > 256 || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new Error("frame click requires bounded frame, loader, and backend node identities.");
  const outcome = params?.outcome, timeoutMs = params?.timeout_ms, inputMode = params?.input_mode ?? "mouse";
  if (!(["mouse", "touch"].includes(inputMode))) throw new Error("frame click input_mode must be mouse or touch.");
  if (!outcome || !["navigation", "focused", "visible", "text", "expanded", "selected"].includes(outcome.kind) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) throw new Error("frame click requires a supported postcondition and a 250..10000ms timeout.");
  if (["visible", "text"].includes(outcome.kind) && (typeof outcome.selector !== "string" || !outcome.selector || outcome.selector.length > 512) || outcome.kind === "text" && (typeof outcome.text !== "string" || outcome.text.length > 512) || outcome.kind === "navigation" && outcome.url != null && !isExactHttpUrl(outcome.url) || ["expanded", "selected"].includes(outcome.kind) && outcome.selector != null && (typeof outcome.selector !== "string" || !outcome.selector || outcome.selector.length > 512)) throw new Error("frame click postcondition is invalid or exceeds its bound.");
  const route = { tabId };
  const frameLoader = async () => {
    const tree = await frameTreeWithChildren(tabId, frameId);
    const visit = node => node?.frame?.id === frameId ? node.frame.loaderId : (node?.childFrames || []).map(visit).find(Boolean);
    return visit(tree.frameTree);
  };
  const frameUrl = async () => {
    const tree = await frameTreeWithChildren(tabId, frameId);
    const visit = node => node?.frame?.id === frameId ? node.frame.url : (node?.childFrames || []).map(visit).find(Boolean);
    return visit(tree.frameTree);
  };
  await ensureAutoAttach(tabId);
  let objectId, child;
  try {
    if (await frameLoader() !== loaderId) throw new Error("Frame document changed since the accessibility snapshot.");
    // A fresh local tree already proves same-process ownership. If the
    // frame came from a child tree, its attached session is already bound.
    const sessionId = frames.sessionForFrame(tabId, frameId);
    child = sessionId ? { tabId, sessionId } : route;
    const beforeUrl = outcome.kind === "navigation" ? await frameUrl() : null;
    const ax = await sendCdpCommand(child, "Accessibility.getFullAXTree", sessionId ? {} : { frameId });
    const node = ax.nodes?.find(item => item.backendDOMNodeId === backendNodeId);
    if (!node || !["button", "link", "checkbox", "radio", "option", "menuitem", "tab", "switch"].includes(node.role?.value)) throw new Error("Frame control is stale or is not an actionable control.");
    const label = String(node.name?.value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (/^(send|post|publish|submit|delete|remove|share)(\s|$)/u.test(label) ||
        /^(place order|confirm order|complete order|buy now|pay now|purchase now|complete purchase|confirm purchase)(\s|$)/u.test(label)) {
      return { status: "not_dispatched", dispatch_acknowledged: false, dispatch_may_have_occurred: false,
        verified: false, reason_code: "frame_mutation_authority_required",
        reason: "The live frame control requires a consequential action check that this route cannot perform." };
    }
    if ((params.expected_label ?? null) !== null && label !== String(params.expected_label).trim().replace(/\s+/g, " ").toLowerCase()) {
      return { status: "not_dispatched", dispatch_acknowledged: false, dispatch_may_have_occurred: false,
        verified: false, reason_code: "frame_target_label_changed", reason: "The live frame control label differs from the requested label." };
    }
    const resolved = await sendCdpCommand(child, "DOM.resolveNode", { backendNodeId });
    objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("Frame click target could not be resolved for outcome verification.");
    const localPoint = await frameActionablePoint(child, objectId);
    const initialMapping = await rootPointForFrame(tabId, frameId, objectId, localPoint.x, localPoint.y, localPoint.viewport);
    const { x, y } = initialMapping;
    const verifyOutcome = async () => {
      if (outcome.kind === "navigation") {
        const currentUrl = await frameUrl();
        const loaderChanged = await frameLoader();
        const changed = !!currentUrl && (currentUrl !== beforeUrl || !!loaderChanged && loaderChanged !== loaderId);
        return changed && (outcome.url == null || new URL(currentUrl).href === new URL(outcome.url).href);
      }
      const result = await sendCdpCommand(child, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function __navichromeFrameOutcome(outcome){const e=this,d=e.ownerDocument;const q=s=>s==null?e:d.querySelector(s);switch(outcome.kind){case 'focused':return d.activeElement===e||e.contains(d.activeElement);case 'visible':{const n=q(outcome.selector);if(!n)return false;const s=getComputedStyle(n);return n.isConnected&&n.getClientRects().length>0&&s.display!=='none'&&s.visibility==='visible'&&Number.parseFloat(s.opacity||'1')>0}case 'text':{const n=q(outcome.selector);return !!n&&n.isConnected&&(n.innerText||n.textContent||'').includes(outcome.text)}case 'expanded':{const n=q(outcome.selector);return !!n&&(n.getAttribute('aria-expanded')==='true'||n.open===true)}case 'selected':{const n=q(outcome.selector);return !!n&&(n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-checked')==='true'||n.checked===true||n.selected===true)}default:return false}}",
        arguments: [{ value: outcome }], returnByValue: true,
      });
      if (result.exceptionDetails || typeof result.result?.value !== "boolean") throw new Error("Frame outcome could not be evaluated.");
      return result.result.value;
    };
    if (outcome.kind !== "navigation" && await verifyOutcome()) {
      return { status: "not_dispatched", frame_id: frameId, backend_node_id: backendNodeId, dispatch_acknowledged: false, dispatch_may_have_occurred: false, verified: false, reason_code: "frame_outcome_already_true", reason: "Requested frame click outcome was already true before input." };
    }
    let pressAttempted = false;
    try {
      if (inputMode === "mouse") await pointerEngine.move(route, { x, y }, { button: "none" });
      // Hover can move the control or put a tooltip over it. Recheck the
      // original point and every owner immediately before sending down.
      const currentPoint = await frameActionablePoint(child, objectId);
      const dispatchPoint = await rootPointForFrame(tabId, frameId, objectId, currentPoint.x, currentPoint.y, currentPoint.viewport);
      if (Math.abs(dispatchPoint.x - x) > 0.5 || Math.abs(dispatchPoint.y - y) > 0.5 || JSON.stringify(dispatchPoint.owner_signature) !== JSON.stringify(initialMapping.owner_signature) || await frameLoader() !== loaderId || (frames.sessionForFrame(tabId, frameId) || null) !== (sessionId || null) || !isAuthorized(tabId)) throw new Error("Frame control or owner geometry changed before dispatch.");
      pressAttempted = true;
      if (inputMode === "touch") {
        await pointerEngine.touchStart(route, { x, y });
        await pointerEngine.touchEnd(route);
      } else {
        await pointerEngine.press(route, { x, y });
        await pointerEngine.release(route, { x, y });
      }
    } catch (error) {
      if (pressAttempted && inputMode === "touch") await pointerEngine.touchEnd(route).catch(() => {});
      if (pressAttempted && inputMode === "mouse") await pointerEngine.release(route, { x, y }).catch(() => {});
      return { frame_id: frameId, backend_node_id: backendNodeId, dispatch_acknowledged: false, dispatch_may_have_occurred: pressAttempted, verified: false, reason_code: pressAttempted ? "frame_input_delivery_unknown" : "frame_target_changed_before_dispatch", reason: String(error) };
    }
    const deadline = Date.now() + timeoutMs;
    let verified = false;
    do { verified = await verifyOutcome().catch(() => false); if (verified || Date.now() >= deadline) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
    return { frame_id: frameId, backend_node_id: backendNodeId, input_mode: inputMode, dispatch_acknowledged: true, dispatch_may_have_occurred: true, verified, reason: verified ? undefined : "requested frame click outcome was not observed before its deadline" };
  } catch (error) {
    return {
      frame_id: frameId, backend_node_id: backendNodeId, dispatch_acknowledged: false,
      dispatch_may_have_occurred: false, verified: false, reason_code: "frame_click_preflight_failed", reason: String(error)
    };
  } finally {
    if (objectId) await sendCdpCommand(child, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}
