// Pick the one file input a lazy upload may target. The baseline proves which
// inputs existed before the trigger; a lone surviving baseline input is a
// deliberate fallback, while every ambiguous shape fails closed.
export function selectFileInputCandidate(baseline, all) {
  if (!Array.isArray(baseline) || baseline.length > 256 || baseline.some(item => typeof item?.frame_id !== "string" || typeof item?.frame_loader_id !== "string" || !Number.isSafeInteger(item?.backend_node_id))) {
    throw new Error("Lazy-input fallback requires a bounded pre-trigger file-input baseline.");
  }
  const existed = new Set(baseline.map(item => `${item.frame_id}:${item.frame_loader_id}:${item.backend_node_id}`));
  const candidates = all.filter(item => !existed.has(`${item.frame_id}:${item.frame_loader_id}:${item.backend_node_id}`));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 && baseline.length === 1) {
    const prior = baseline[0];
    const selected = all.find(item => item.frame_id === prior.frame_id && item.frame_loader_id === prior.frame_loader_id && item.backend_node_id === prior.backend_node_id);
    if (!selected) throw new Error("The sole pre-trigger file input is no longer attached to the upload document.");
    return { ...selected, existing_input_fallback: true };
  }
  if (candidates.length === 0) throw new Error("No new file input appeared after the upload trigger.");
  throw new Error("Multiple new file inputs appeared after the upload trigger; refusing ambiguous selection.");
}
