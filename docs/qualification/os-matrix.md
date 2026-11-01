# Headed OS matrix

This matrix records only what ran on the host that produced the evidence. A
green cell is not a cross-platform compatibility claim.

## Qualified cells

| Host | Architecture | Chrome | Mode | Evidence |
|---|---|---|---|---|
| macOS 26.6.2 (25G83) | arm64 | Google Chrome 156.0.8078.79 | headed installed apps | [phase12-installed-evidence-2026-10-31.json](../../bench/reports/phase12-installed-evidence-2026-10-31.json) |
| macOS 26.6.2 (25G83) | arm64 | Google Chrome 156.0.8078.79 | eight background tabs | [phase12-concurrency-2026-10-31T17-29-54-849Z.json](../../bench/reports/phase12-concurrency-2026-10-31T17-29-54-849Z.json) |
| macOS 26.6.2 (25G83) | arm64 | Google Chrome 156.0.8078.79 | two MCP processes | [phase12-concurrency-2026-10-31T17-29-54-849Z.json](../../bench/reports/phase12-concurrency-2026-10-31T17-29-54-849Z.json) |

The machine-readable record is
[phase12-os-matrix-2026-10-31.json](../../bench/reports/phase12-os-matrix-2026-10-31.json).
It binds the host identity to the evidence hashes and lists every other
platform as unqualified.

## Unqualified cells

| Host | Status | Why |
|---|---|---|
| Windows x64 / arm64 | not run | No Windows host or installed Chrome session was available. |
| Linux x64 / arm64 | not run | No Linux desktop session with installed Chrome was available. |

No renderer, input, focus, clipboard, or window-manager behavior is inferred
for an untested OS. The shared-extension route is also not qualified on a
second Chrome major version.

## What the qualified cells prove

- Four installed applications accepted real writes on macOS: Google Docs
  typing, Google Docs replace/append/undo, Gmail send-free draft, and the React
  form fixture. Each row has a live server or application postcondition.
- Eight independent owned tabs completed verified form writes concurrently,
  with peak overlap 8 and zero wrong-target writes.
- Two independent MCP server processes each completed a verified form write
  concurrently, with peak overlap 2 and zero wrong-target writes.

## Reproduce

```sh
# Live installed applications (requires signed-in installed Chrome)
DOCS_LIVE=1 GMAIL_LIVE=1 node bench/runners/phase12-live-apps.mjs \
  --rows=google-docs-type-1000,google-docs-replace-append-undo,react-form,gmail-compose

# Concurrency, eight tabs and two MCP processes
node bench/runners/phase12-concurrency.mjs --tabs=8 --processes=2

# Bind the current host to those evidence files
node bench/runners/phase12-os-matrix.mjs \
  --installed-evidence=bench/reports/phase12-installed-evidence-2026-10-31.json \
  --concurrency-evidence=bench/reports/phase12-concurrency-2026-10-31T17-29-54-849Z.json \
  --output=bench/reports/phase12-os-matrix-2026-10-31.json
```
