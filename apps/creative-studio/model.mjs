// Application-owned transaction model. Edits use stable object IDs and
// absolute preconditions. Only the server commits a previewed revision.
export const FPS = 30;
export const KINDS = ["document", "slides", "video"];
export const identifier = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const exact = (condition, message) => { if (!condition) throw Error(message); };
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const boundedText = v => typeof v === "string" && v.length <= 4000 && !v.includes("\0");

export function initial(kind) {
  const base = { kind, revision: 0, receipt: null };
  if (kind === "document") return { ...base, paragraphs: [
    { id: "title", style: "heading", text: "Field notes" },
    { id: "intro", style: "body", text: "This first paragraph needs a clearer opening." },
    { id: "closing", style: "body", text: "Preserve this closing paragraph." },
  ], suggestions: [] };
  if (kind === "slides") return { ...base, slides: [
    { id: "opening", notes: "Introduce the purpose.", objects: [
      { id: "headline", x: 48, y: 48, width: 520, height: 72, text: "Field notes" },
      { id: "summary", x: 68, y: 152, width: 480, height: 88, text: "A longer summary goes here." },
    ] },
    { id: "closing", notes: "Close with the next step.", objects: [
      { id: "next-step", x: 48, y: 48, width: 520, height: 72, text: "Next steps" },
    ] },
  ] };
  if (kind === "video") return { ...base, assets: [], clips: [], captions: [] };
  throw Error("unknown editor");
}

function unique(id, list) {
  exact(identifier(id) && !list.some(item => item.id === id), "invalid or duplicate new ID");
}
function one(id, list) {
  const item = list.find(entry => entry.id === id);
  exact(item, "target ID is absent");
  return item;
}
function replace(target, key, op) {
  exact(boundedText(op.text) && typeof op.expected === "string" && target[key] === op.expected, "text precondition failed");
  target[key] = op.text;
}

export function apply(state, plan) {
  exact(plan?.version === 1 && plan.revision === state.revision, "revision changed");
  exact(Array.isArray(plan.edits) && plan.edits.length > 0 && plan.edits.length <= 24, "batch must contain 1–24 edits");
  const next = structuredClone(state);
  for (const op of plan.edits) {
    exact(op && identifier(op.id) && typeof op.kind === "string", "invalid edit target");
    if (next.kind === "document") {
      if (op.kind === "accept_suggestion" || op.kind === "reject_suggestion") {
        const edit = one(op.id, next.suggestions);
        if (op.kind === "accept_suggestion") replace(one(edit.paragraph, next.paragraphs), "text", edit);
        next.suggestions = next.suggestions.filter(entry => entry.id !== op.id);
      } else {
        const p = one(op.id, next.paragraphs);
        if (op.kind === "replace_text") replace(p, "text", op);
        else if (op.kind === "suggest_text") {
          unique(op.suggestion_id, next.suggestions);
          exact(next.suggestions.length < 64 && boundedText(op.text) && p.text === op.expected, "suggestion precondition failed");
          next.suggestions.push({ id: op.suggestion_id, paragraph: p.id, expected: p.text, text: op.text });
        } else throw Error("unsupported document edit");
      }
    } else if (next.kind === "slides") {
      const slide = one(op.slide ?? op.id, next.slides);
      if (op.kind === "replace_notes") {
        replace(slide, "notes", op);
      } else {
        const object = one(op.id, slide.objects);
        if (op.kind === "replace_text") replace(object, "text", op);
        else if (op.kind === "move_object") {
          exact(object.x === op.expected_x && object.y === op.expected_y &&
            integer(op.x, 0, 640 - object.width) && integer(op.y, 0, 360 - object.height), "slide geometry precondition failed");
          object.x = op.x;
          object.y = op.y;
        } else throw Error("unsupported slide edit");
      }
    } else if (op.kind === "add_caption") {
      unique(op.id, next.captions);
      exact(next.captions.length < 80 && boundedText(op.text) && op.text.trim() && op.text.length <= 220 && !/[\r\n<>]/u.test(op.text) &&
        integer(op.start, 0, 18000) && integer(op.end, op.start + 1, 18000), "invalid caption");
      next.captions.push({ id: op.id, start: op.start, end: op.end, text: op.text });
    } else {
      const clip = one(op.id, next.clips);
      const source = one(clip.asset, next.assets);
      if (op.kind === "trim_clip" || op.kind === "split_clip") {
        exact(clip.start === op.expected_start && clip.end === op.expected_end, "clip range changed");
        if (op.kind === "trim_clip") {
          exact(integer(op.start, 0, source.frames) && integer(op.end, op.start + 1, source.frames), "invalid source range");
          Object.assign(clip, { start: op.start, end: op.end });
        } else {
          unique(op.new_id, next.clips);
          exact(next.clips.length < 24 && integer(op.at, clip.start + 1, clip.end - 1), "split not inside clip");
          next.clips.splice(next.clips.indexOf(clip) + 1, 0, { ...clip, id: op.new_id, start: op.at });
          clip.end = op.at;
        }
      } else if (op.kind === "move_clip") {
        exact(next.clips.indexOf(clip) === op.expected_index && integer(op.index, 0, next.clips.length - 1), "clip order changed");
        next.clips.splice(op.expected_index, 1);
        next.clips.splice(op.index, 0, clip);
      } else if (op.kind === "set_gain") {
        exact(clip.gain === op.expected && Number.isFinite(op.gain) && op.gain >= 0 && op.gain <= 2, "gain precondition failed");
        clip.gain = op.gain;
      } else throw Error("unsupported video edit");
    }
  }
  if (next.kind === "video") {
    const duration = next.clips.reduce((n, clip) => n + clip.end - clip.start, 0);
    exact(duration <= FPS * 120, "timeline exceeds two minutes");
    next.captions.sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const caption of next.captions) {
      exact(caption.end <= duration && caption.start >= previousEnd, "caption overlaps or exceeds timeline");
      previousEnd = caption.end;
    }
  }
  next.revision++;
  return next;
}
