import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, initial } from "./model.mjs";
import { startStudio } from "./server.mjs";

const batch = (revision, ...edits) => ({ version: 1, revision, edits });
test("conflicting document changes are atomic and suggestions stay separate", () => {
  const doc = initial("document");
  const first = { kind: "replace_text", id: "title", expected: "Field notes", text: "Field report" };
  assert.throws(() => apply(doc, batch(0, first, { ...first, text: "duplicate" })), /precondition/);
  assert.equal(doc.paragraphs[0].text, "Field notes");
  const next = apply(doc, batch(0, { ...first, kind: "suggest_text", suggestion_id: "title-edit" }));
  assert.equal(next.paragraphs[0].text, "Field notes");
  const accepted = apply(next, batch(1, { kind: "accept_suggestion", id: "title-edit" }));
  assert.equal(accepted.paragraphs[0].text, "Field report");
  assert.equal(accepted.suggestions.length, 0);
});
test("slide changes preserve untouched objects, clip edits use source frames", () => {
  const slides = initial("slides");
  const next = apply(slides, batch(0, { kind: "move_object", id: "summary", slide: "opening", expected_x: 68, expected_y: 152, x: 48, y: 145 }));
  assert.deepEqual(next.slides[1], slides.slides[1]);
  assert.equal(next.slides[0].objects[1].x, 48);
  const video = { ...initial("video"), assets: [{ id: "shot", frames: 90 }], clips: [{ id: "shot", asset: "shot", start: 0, end: 90, gain: 1 }] };
  const result = apply(video, batch(0,
    { kind: "split_clip", id: "shot", expected_start: 0, expected_end: 90, at: 60, new_id: "tail" },
    { kind: "move_clip", id: "tail", expected_index: 1, index: 0 },
    { kind: "add_caption", id: "caption", start: 0, end: 20, text: "Opening" },
  ));
  assert.deepEqual(result.clips.map(c => [c.id, c.start, c.end]), [["tail", 60, 90], ["shot", 0, 60]]);
  assert.throws(() => apply(result, batch(1, { kind: "add_caption", id: "overlap", start: 18, end: 25, text: "Overlap" })), /overlaps/);
});
test("server binds preview to the bytes and revision, persists across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "navichrome-creative-test-"));
  let studio;
  try {
    studio = await startStudio({ dir });
    const change = batch(0, { kind: "replace_text", id: "title", expected: "Field notes", text: "Field report" });
    const post = (action, value, origin = studio.origin) => fetch(studio.origin + "/document/" + action, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    assert.equal((await post("preview", change, "https://outside.example")).status, 403);
    assert.equal((await post("apply", change)).status, 409);
    const preview = await (await post("preview", change)).json();
    assert.equal((await post("apply", { ...change, edits: [{ ...change.edits[0], text: "Other edit" }] })).status, 409);
    assert.equal((await post("apply", change)).status, 200);
    assert.equal((await post("apply", change)).status, 409);
    await new Promise(resolve => studio.server.close(resolve));
    studio = await startStudio({ dir });
    const saved = await (await fetch(studio.origin + "/document/state")).json();
    assert.equal(saved.revision, 1);
    assert.equal(saved.receipt, preview.id);
    assert.equal(saved.paragraphs[0].text, "Field report");
  } finally {
    if (studio) await new Promise(resolve => studio.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
