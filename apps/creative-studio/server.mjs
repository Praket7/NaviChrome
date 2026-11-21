import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { apply, FPS, identifier, initial, KINDS } from "./model.mjs";

const run = promisify(execFile);
const digest = data => createHash("sha256").update(data).digest("hex");
const token = value => /^[a-f0-9]{64}$/.test(value);
const command = (name, args) => run(name, args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
const duration = clips => clips.reduce((n, clip) => n + clip.end - clip.start, 0);
const seconds = frames => (frames / FPS).toFixed(6);
const timestamp = frame => new Date(Math.round(frame * 1000 / FPS)).toISOString().slice(11, 23).replace(".", ",");
const source = name => readFileSync(new URL(name, import.meta.url));

async function mediaInfo(path, format = "mov") {
  const { stdout } = await command("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", format, "-show_entries",
    "stream=codec_name,codec_type,width,height,avg_frame_rate,nb_frames:format=duration", "-of", "json", path]);
  return JSON.parse(stdout);
}

async function render(state, dir, output) {
  if (!state.clips.length) throw Error("add at least one video clip");
  const args = ["-nostdin", "-loglevel", "error", "-y", "-filter_complex_threads", "1"];
  const graph = [];
  for (const [index, clip] of state.clips.entries()) {
    const asset = state.assets.find(item => item.id === clip.asset);
    args.push("-protocol_whitelist", "file,pipe", "-f", asset.format, "-i", join(dir, asset.id + ".source"));
    const length = seconds(clip.end - clip.start);
    graph.push(`[${index}:v]fps=${FPS},trim=start_frame=${clip.start}:end_frame=${clip.end},setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`);
    graph.push(asset.audio
      ? `[${index}:a]atrim=start=${seconds(clip.start)}:end=${seconds(clip.end)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${clip.gain},apad,atrim=duration=${length}[a${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[a${index}]`);
  }
  graph.push(state.clips.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${state.clips.length}:v=1:a=1[v][a]`);
  const captions = output + ".srt";
  if (state.captions.length) {
    writeFileSync(captions, state.captions.map((c, i) => `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}\n`).join("\n"));
    args.push("-i", captions);
  }
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-t", seconds(duration(state.clips)));
  if (state.captions.length) args.push("-map", `${state.clips.length}:s:0`, "-c:s", "mov_text");
  try {
    await command("ffmpeg", [...args, output]);
    const info = await mediaInfo(output);
    const video = info.streams?.find(s => s.codec_type === "video");
    if (video?.codec_name !== "h264" || video.width !== 640 || video.height !== 360 ||
        video.avg_frame_rate !== "30/1" || Number(video.nb_frames) !== duration(state.clips) ||
        !info.streams.some(s => s.codec_type === "audio") ||
        Boolean(state.captions.length) !== info.streams.some(s => s.codec_type === "subtitle")) {
      throw Error("render failed the independent media check");
    }
    return { ...info, size: statSync(output).size, sha256: digest(readFileSync(output)), frames: Number(video.nb_frames) };
  } finally {
    if (existsSync(captions)) unlinkSync(captions);
  }
}

async function body(req, max) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > max) throw Error("request exceeded byte limit");
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function movie(req, res, path, download, mime = "video/mp4") {
  const size = statSync(path).size;
  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes" };
  if (download) headers["Content-Disposition"] = 'attachment; filename="creative-edit.mp4"';
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (match) {
    const start = Number(match[1]), end = Math.min(size - 1, match[2] ? Number(match[2]) : size - 1);
    if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  createReadStream(path).pipe(res);
}

export function startStudio({ dir = mkdtempSync(join(tmpdir(), "navichrome-studio-")), port = 0 } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = kind => join(dir, kind + ".json");
  const read = kind => existsSync(path(kind)) ? JSON.parse(readFileSync(path(kind))) : initial(kind);
  const save = state => {
    const temp = path(state.kind) + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path(state.kind));
  };
  const previews = new Map();
  const renderId = state => digest(JSON.stringify(state));
  const renderReceipt = state => {
    const id = renderId(state);
    const file = join(dir, id + ".mp4");
    const metadata = join(dir, id + ".export.json");
    if (!existsSync(file) || !existsSync(metadata)) return null;
    const receipt = JSON.parse(readFileSync(metadata));
    return receipt.id === id && receipt.revision === state.revision && receipt.size === statSync(file).size ? receipt : null;
  };
  let mediaBusy = false, renderBusy = false;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "invalid local host" });
    const url = new URL(req.url, origin);
    const [, kind, action, extra] = url.pathname.split("/");
    try {
      if (req.method === "GET" && url.pathname === "/studio.mjs") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        return res.end(source("./studio.mjs"));
      }
      if (req.method === "GET" && url.pathname === "/studio.css") {
        res.writeHead(200, { "Content-Type": "text/css" });
        return res.end(source("./studio.css"));
      }
      if (!KINDS.includes(kind) || extra) return json(res, 404, { error: "editor route not found" });
      if (req.method === "GET") {
        if (!action) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; frame-ancestors 'none'; form-action 'self'" });
          return res.end(source("./index.html"));
        }
        if (action === "state") return json(res, 200, read(kind));
        if (kind === "video" && action === "render") return json(res, 200, renderReceipt(read(kind)));
        if (kind === "video" && action === "asset" && identifier(url.searchParams.get("id"))) {
          const asset = read(kind).assets.find(item => item.id === url.searchParams.get("id"));
          if (asset) return movie(req, res, join(dir, asset.id + ".source"), false, asset.mime);
        }
        if (kind === "video" && action === "output" && token(url.searchParams.get("id") ?? "")) {
          const output = join(dir, url.searchParams.get("id") + ".mp4");
          if (existsSync(output)) return movie(req, res, output, url.searchParams.get("download") === "1");
        }
        return json(res, 404, { error: "asset not found" });
      }
      if (req.method !== "POST" || req.headers.origin !== origin) return json(res, 403, { error: "same-origin POST required" });
      if (kind === "video" && action === "import") {
        const state = read(kind), id = url.searchParams.get("id");
        if (mediaBusy || state.assets.length >= 8 || !identifier(id) || state.assets.some(s => s.id === id)) throw Error("invalid or duplicate source ID, or import busy");
        const mime = req.headers["content-type"] ?? "";
        if (!/^video\/(mp4|quicktime|webm)$/.test(mime)) throw Error("choose an MP4, MOV or WebM video");
        mediaBusy = true;
        const temp = join(dir, randomUUID() + ".upload");
        try {
          writeFileSync(temp, await body(req, 24 * 1024 * 1024), { mode: 0o600 });
          const format = mime === "video/webm" ? "matroska" : "mov";
          const info = await mediaInfo(temp, format);
          const secs = Number(info.format?.duration);
          if (!Number.isFinite(secs) || secs < .1 || secs > 120 || !info.streams?.some(s => s.codec_type === "video" && s.width <= 3840 && s.height <= 2160)) throw Error("choose a bounded video source");
          if (read(kind).revision !== state.revision) throw Error("timeline changed during import");
          const frames = Math.floor(secs * FPS + 0.001);
          if (duration(state.clips) + frames > 120 * FPS) throw Error("timeline exceeds two minutes");
          renameSync(temp, join(dir, id + ".source"));
          state.assets.push({ id, format, mime, frames, audio: info.streams.some(s => s.codec_type === "audio") });
          state.clips.push({ id, asset: id, start: 0, end: frames, gain: 1 });
          state.revision++;
          state.receipt = null;
          save(state);
          return json(res, 200, state);
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
          mediaBusy = false;
        }
      }
      if (req.headers["content-type"] !== "application/json") throw Error("JSON request required");
      const raw = await body(req, 24_000);
      const input = JSON.parse(raw);
      const state = read(kind);
      if (action === "preview" || action === "apply") {
        const id = digest(raw);
        const next = apply(state, input);
        if (action === "preview") {
          if (previews.size >= 32) previews.delete(previews.keys().next().value);
          previews.set(kind + id, Date.now() + 120_000);
          return json(res, 200, { id, revision: state.revision, edits: input.edits });
        }
        const expiry = previews.get(kind + id);
        if (!(expiry > Date.now())) throw Error("preview this exact batch first");
        previews.delete(kind + id);
        next.receipt = id;
        save(next);
        return json(res, 200, next);
      }
      if (kind === "video" && action === "render") {
        if (input.revision !== state.revision) throw Error("revision changed before export");
        const id = renderId(state);
        const existing = renderReceipt(state);
        if (existing) return json(res, 200, existing);
        if (renderBusy || readdirSync(dir).filter(file => file.endsWith(".export.json")).length >= 16) throw Error("render busy or session export limit reached");
        renderBusy = true;
        const temp = join(dir, id + ".partial.mp4");
        try {
          const info = await render(state, dir, temp);
          renameSync(temp, join(dir, id + ".mp4"));
          const result = { id, revision: state.revision, ...info };
          writeFileSync(join(dir, id + ".export.json"), JSON.stringify(result), { mode: 0o600 });
          return json(res, 200, result);
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
          renderBusy = false;
        }
      }
      return json(res, 404, { error: "unknown editor operation" });
    } catch (error) {
      if (!res.headersSent) json(res, 409, { error: String(error.message).split("\n")[0].slice(0, 240) });
    }
  });
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${server.address().port}`, dir }));
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { origin, dir } = await startStudio({ dir: process.env.NAVICHROME_STUDIO_DIR, port: Number(process.env.NAVICHROME_STUDIO_PORT || 0) });
  process.stdout.write(JSON.stringify({ origin, dir }) + "\n");
}
