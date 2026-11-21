import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { canvasHumanBatch } from "../extensions/navichrome/lib/typing-support.js";

test("canvas guard ignores mouse movement and stops on a trusted click with an unchanged DOM caret", () => {
  const source = readFileSync(new URL("../crates/navichrome-runtime/src/mcp/v3_full.rs", import.meta.url), "utf8");
  const expression = source.match(/const CANVAS_CARET_GUARD: &str = r#"([\s\S]*?)"#;/)[1];
  const top = new EventTarget();
  const child = new EventTarget();
  const editor = {
    isConnected: true, isContentEditable: false, selectionStart: 5, selectionEnd: 5,
    ownerDocument: child,
    closest: () => null, matches: selector => selector.includes("textarea"),
  };
  child.activeElement = editor;
  top.activeElement = { matches: selector => selector === "iframe,frame", contentDocument: child };
  const guard = runInNewContext(expression, {
    document: top, performance: { now: () => 0 }, AbortController, setTimeout: () => 1, clearTimeout: () => {},
  });
  const fire = (document, type, trusted) => {
    const event = new Event(type);
    Object.defineProperty(event, "isTrusted", { value: trusted });
    document.dispatchEvent(event);
  };
  assert.equal(guard("check"), true);
  fire(top, "pointermove", true);
  fire(child, "pointerdown", false);
  assert.equal(guard("check"), true);
  fire(child, "pointerdown", true);
  assert.equal(guard("check"), "canvas_manual_input");
  assert.equal(editor.selectionStart, 5);
});

test("canvas guard follows a Docs editor node replacement but still stops on trusted pointer input", () => {
  const source = readFileSync(new URL("../crates/navichrome-runtime/src/mcp/v3_full.rs", import.meta.url), "utf8");
  const expression = source.match(/const CANVAS_CARET_GUARD: &str = r#"([\s\S]*?)"#;/)[1];
  const doc = new EventTarget();
  const makeEditor = () => ({isConnected:true,isContentEditable:false,selectionStart:0,selectionEnd:0,
    ownerDocument:doc,closest:()=>null,matches:selector=>selector.includes("textarea")});
  const firstEditor = makeEditor();
  doc.activeElement = firstEditor;
  const guard = runInNewContext(expression, {document:doc,performance:{now:()=>0},AbortController,
    setTimeout:()=>1,clearTimeout:()=>{}});
  assert.equal(guard("check"), true);
  firstEditor.isConnected = false;
  doc.activeElement = makeEditor(); // Docs can replace its hidden editor while preserving the caret.
  assert.equal(guard("stamp"), true);
  assert.equal(guard("check"), true);
  const click = new Event("pointerdown");
  Object.defineProperty(click,"isTrusted",{value:true});
  doc.dispatchEvent(click);
  assert.equal(guard("check"), "canvas_manual_input");
});

test("canvas guard tolerates background focus emulation but refuses a different active editor", () => {
  const source = readFileSync(new URL("../crates/navichrome-runtime/src/mcp/v3_full.rs", import.meta.url), "utf8");
  const expression = source.match(/const CANVAS_CARET_GUARD: &str = r#"([\s\S]*?)"#;/)[1];
  const doc = new EventTarget();
  const makeEditor = () => ({isConnected:true,isContentEditable:false,selectionStart:0,selectionEnd:0,
    ownerDocument:doc,closest:()=>null,matches:selector=>selector.includes("textarea")});
  const original = makeEditor();
  doc.activeElement = original;
  const guard = runInNewContext(expression, {document:doc,performance:{now:()=>0},AbortController,
    setTimeout:()=>1,clearTimeout:()=>{}});
  doc.activeElement = {isConnected:true,ownerDocument:doc,closest:()=>null,matches:()=>false};
  assert.equal(guard("check"), true);
  doc.activeElement = makeEditor();
  assert.equal(guard("check"), "canvas_other_editor_focused");
});

function fixture({ interrupt = false, revoke = false } = {}) {
  let ms = 0, authorized = true, focused = true;
  const events = [], pauses = [];
  return { events, pauses, env: {
    now: () => ms, sleep: async wait => { pauses.push(wait); ms += wait; },
    isAuthorized: () => authorized,
    send: async (_, method, args) => {
      ms++;
      if (method === "Runtime.callFunctionOn") return { result: { value: focused } };
      events.push(args);
      if (args.type === "keyDown") {
        if (interrupt) focused = false;
        if (revoke) authorized = false;
      }
      return {};
    },
  }};
}
const params = { object_id: "retained", text: "é\n.", delay_ms: 100, more: true, budget_ms: 5_000 };
test("keeps paced Unicode and Enter events on the same editor", async () => {
  const { events, pauses, env } = fixture();
  const r = await canvasHumanBatch(1, params, env);
  assert.equal(r.status, "delivered");
  assert.equal(r.completed_chars, 3);
  assert.equal(r.key_events, 8);
  assert.equal(r.cdp_commands, 19);
  assert.deepEqual(events.filter(event => event.type === "char").map(event => event.text), ["é", "."]);
  assert.deepEqual(pauses, [93, 195, 193]);
});
test("focus or lease loss after keydown prevents char and keyup", async () => {
  for (const interruption of [{ interrupt: true }, { revoke: true }]) {
    const { events, env } = fixture(interruption);
    const r = await canvasHumanBatch(1, params, env);
    assert.equal(r.status, "unknown");
    assert.equal(r.completed_chars, 0);
    assert.deepEqual(events.map(event => event.type), ["keyDown"]);
  }
});
test("rejects stale budgets and invalid input before browser work", async () => {
  for (const invalid of [{ text: "x".repeat(33) }, { text: "\t" }, { budget_ms: 8001 }]) {
    const { events, env } = fixture();
    const r = await canvasHumanBatch(1, { ...params, ...invalid }, env);
    assert.equal(r.status, "not_dispatched");
    assert.deepEqual(events, []);
    assert.equal(r.cdp_commands, 0);
  }
});
