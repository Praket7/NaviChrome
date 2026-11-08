export function validDownloadUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "http:" || url.protocol === "https:") return !!url.hostname;
    if (url.protocol === "blob:") {
      const inner = new URL(url.pathname);
      return !inner.username && !inner.password && (inner.protocol === "http:" || inner.protocol === "https:") && !!inner.hostname;
    }
    return false;
  } catch { return false; }
}

export async function downloadUrlHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function safeDownloadFilename(value) {
  if (typeof value !== "string" || !value) return null;
  const name = value.split(/[\\/]/).at(-1).slice(0, 255);
  return name || null;
}

export function validExpectedDownloadFilename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && value !== "." && value !== ".." && value === value.trim() && !/[\\/\0-\x1f\x7f]/.test(value);
}
