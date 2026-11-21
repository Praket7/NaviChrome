const kind = location.pathname.split("/")[1];
const $ = id => document.getElementById(id);
const input = $("editor-request"), status = $("editor-status"), detail = $("editor-preview-detail");
const paths = action => `/${kind}/${action}`;
let state, preview;
const names = { document: "Document", slides: "Presentation", video: "Video timeline" };
$("editor-title").textContent = names[kind];

async function request(action, body, contentType = "application/json") {
  const response = await fetch(paths(action), body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": contentType }, body,
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "The operation failed");
  return value;
}
function add(parent, tag, text, id) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (id) node.id = id;
  parent.append(node);
  return node;
}
function show(next) {
  state = next;
  const work = $("work");
  work.replaceChildren();
  $("editor-revision").textContent = `Revision ${state.revision}`;
  $("editor-revision").dataset.revision = state.revision;
  status.textContent = state.receipt ? `Saved revision ${state.revision} · ${state.receipt}` : "Ready";
  if (kind === "document") {
    for (const p of state.paragraphs) add(work, p.style === "heading" ? "h2" : "p", p.text, p.id);
    if (state.suggestions.length) add(work, "h3", "Suggestions");
    for (const s of state.suggestions) add(work, "p", `${s.paragraph}: ${s.expected} → ${s.text}`, s.id);
  }
  if (kind === "slides") {
    for (const [i, slide] of state.slides.entries()) {
      add(work, "h3", `Slide ${i + 1}: ${slide.id}`);
      const stage = add(work, "div", "", slide.id);
      stage.className = "slide";
      for (const o of slide.objects) {
        const object = add(stage, "div", o.text, o.id);
        object.className = "object";
        Object.assign(object.style, { left: o.x + "px", top: o.y + "px", width: o.width + "px", height: o.height + "px" });
      }
      add(work, "p", `Speaker notes: ${slide.notes}`, slide.id + "-notes");
    }
  }
  if (kind === "video") {
    $("video-controls").hidden = false;
    $("download").hidden = true;
    $("player").hidden = true;
    $("player").pause();
    $("video-status").textContent = "";
    void request("render").then(showExport).catch(() => {});
    const clips = add(work, "ol", "", "timeline-clips");
    for (const c of state.clips) add(clips, "li", `${c.id}: ${c.asset} frames ${c.start}–${c.end}, gain ${c.gain}`, c.id);
    const captions = add(work, "ul", "", "timeline-captions");
    for (const c of state.captions) add(captions, "li", `${c.start}–${c.end}: ${c.text}`, c.id);
    const frames = state.clips.reduce((n, c) => n + c.end - c.start, 0);
    add(work, "p", `${frames} frames · 30 fps`, "timeline-duration");
    $("preview-frame").max = Math.max(0, frames - 1);
  }
}
function clearPreview() {
  preview = null;
  detail.hidden = true;
  $("editor-apply").disabled = true;
}
input.addEventListener("input", clearPreview);
$("editor-preview").onclick = async () => {
  const raw = input.value;
  clearPreview();
  try {
    const result = await request("preview", raw);
    if (input.value !== raw || result.revision !== state.revision) throw Error("Request or revision changed during preview");
    preview = raw;
    status.textContent = `Preview revision ${result.revision} · ${result.id}`;
    detail.textContent = JSON.stringify(result.edits, null, 2);
    detail.hidden = false;
    $("editor-apply").disabled = false;
  } catch (error) { status.textContent = error.message; }
};
$("editor-apply").onclick = async () => {
  if (!preview || preview !== input.value) return;
  const raw = preview;
  clearPreview();
  try {
    show(await request("apply", raw));
    input.value = "";
  } catch (error) { status.textContent = error.message; }
};
$("choose-source").onclick = () => $("source-file").click();
$("source-file").onchange = () => {
  const file = $("source-file").files[0];
  if (file) $("video-status").textContent = `Source selected: ${file.name}`;
};
$("import-source").onclick = async () => {
  const file = $("source-file").files[0], id = $("source-id").value;
  if (!file) return;
  try {
    show(await request("import?id=" + encodeURIComponent(id), file, file.type));
    $("video-status").textContent = `Imported source ${id}`;
  } catch (error) { $("video-status").textContent = error.message; }
};
$("seek").onclick = () => {
  let frame = Number($("preview-frame").value);
  if (!Number.isInteger(frame) || frame < 0) return;
  const requested = frame;
  for (const clip of state.clips) {
    const length = clip.end - clip.start;
    if (frame >= length) { frame -= length; continue; }
    const player = $("player");
    player.pause();
    player.hidden = false;
    player.src = paths("asset?id=" + encodeURIComponent(clip.asset));
    player.onloadedmetadata = () => { player.currentTime = (clip.start + frame) / 30; };
    player.onseeked = () => { $("video-status").textContent = `Preview frame ${requested} · ${clip.id}`; };
    return;
  }
};
function showExport(result) {
  if (!result || result.revision !== state?.revision) return;
  const link = $("download"), player = $("player");
  const path = paths("output?id=" + result.id);
  link.href = path + "&download=1";
  link.hidden = false;
  player.onloadedmetadata = null;
  player.onseeked = null;
  player.src = path;
  player.hidden = false;
  $("video-status").textContent = `Export verified · revision ${result.revision} · ${result.frames} frames · SHA-256 ${result.sha256}`;
}
$("render").onclick = async () => {
  const revision = state.revision, button = $("render");
  const videoStatus = $("video-status"), link = $("download");
  link.hidden = true;
  videoStatus.textContent = `Rendering revision ${revision}`;
  button.disabled = true;
  try {
    showExport(await request("render", JSON.stringify({ revision })));
  } catch (error) { videoStatus.textContent = error.message; }
  finally { button.disabled = false; }
};
try { show(await request("state")); }
catch (error) { status.textContent = error.message; }
