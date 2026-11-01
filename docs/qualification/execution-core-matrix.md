# Execution-core qualification matrix

This page separates four kinds of evidence. They are not interchangeable.

| Evidence | Proves | Does not prove |
|---|---|---|
| Deterministic fixtures (`bench/fixtures`, extension Node tests, V3 Rust tests) | Exact command counts, one-transaction typing, frame routing, rebase safety, stale-session recovery | That a live application accepted the input |
| Installed-Chrome matrix (`bench/tasks/phase12-installed-apps.json`) | The operator's account saw the requested application state | Competitor parity, or behavior on a different account/tenant |
| Matched competitor run | Relative latency and call counts under the same task | Application acceptance on its own |
| Client smoke evidence | A supported client completed a real task through the MCP | Browser capability coverage |

## Current status — 2026-10-31

| Row | Result | Evidence |
|---|---|---|
| Google Docs 1,000-character typing | qualified | exact text persisted across the exact-URL reopen; one native text transaction; `phase12-installed-evidence-2026-10-31.json` |
| Google Docs replace / undo / append | qualified | original marker absent after select-all replacement, restored by undo, and present with the append marker at the document end |
| Gmail send-free draft | qualified | recipient, subject, and body verified; draft visible after an independent reopen in a new tab; no Send dispatched |
| React controlled form | qualified | React state accepted both values and the page reported Saved |
| Word for Web | unqualified | no signed-in Microsoft Word for Web session was available |
| CodeMirror / Monaco | unqualified | no installed instance was present in this checkout; the editor-ladder fixture is not an application acceptance |
| contenteditable IME, cross-origin iframe, virtualized table, canvas, human interference | unqualified as installed apps | these matrix rows are fixture evidence by design; the deterministic suites cover the contracts, not a live application |

Run the evaluator against the current evidence file:

```sh
node bench/runners/phase12-installed-apps.mjs \
  --evidence bench/reports/phase12-installed-evidence-2026-10-31.json
```

The result is 4 qualified rows and 8 unqualified rows. `--require-qualified`
still exits nonzero, so the release gate cannot mistake four live rows for a
full matrix.

### Concurrency — 2026-10-31

```sh
node bench/runners/phase12-concurrency.mjs --tabs=8 --processes=2
```

Eight independent owned tabs completed verified form writes concurrently with
peak overlap 8, 9.6 s wall against 54.3 s of serial tab time, zero wrong-target
writes, and every fixture-server postcondition accepted. Two independent MCP
server processes also completed concurrently with peak overlap 2 and zero
wrong-target writes. Evidence:
`phase12-concurrency-2026-10-31T17-29-54-849Z.json`.

### Matched competitor pilot — 2026-10-31

```sh
node bench/runners/phase12-competitor-report.mjs
```

The report covers all six configured adapters on one shared read-only task with
three counterbalanced repetitions, the same Chrome, model, and prompt per
adapter, and an independent HTTPS title/paragraph verifier. Controlla passed
3/3 runs with one browser call per run and the lowest median in this pilot.
This is directional, not a p50/p95 release distribution or a universal speed
claim. The generated report is
`bench/reports/phase12-competitor-report-2026-10-31.md`.

### Headed OS matrix

Only macOS 26.6.2 arm64 was executed. The machine-readable record binds the
host, Chrome version, and evidence hashes, and marks Windows and Linux as
unqualified. See [the OS matrix](os-matrix.md).

Run without evidence to see the truthful default:

```sh
node bench/runners/phase12-installed-apps.mjs
```

Without an `--evidence` file, every row is reported unqualified. That is the
truthful default for a checkout that has not executed the live matrix; it is
why the repository does not claim Google Docs, Word for Web, Gmail, Canva, or
"human-intervention resistant" support from fixture tests alone.

To qualify rows, run each task on installed Chrome with your own account and
record a `phase12_evidence` file:

```json
{
  "version": 1,
  "kind": "phase12_evidence",
  "results": [
    {
      "id": "google-docs-type-1000",
      "application_accepted": true,
      "client_completed": true,
      "assertions_passed": true,
      "evidence_hash": "sha256:...",
      "controlla_version": "3.x.y",
      "recorded_at_ms": 0
    }
  ]
}
```

Then:

```sh
node bench/runners/phase12-installed-apps.mjs --evidence evidence.json --require-qualified
```

`--require-qualified` exits nonzero while any row lacks current evidence, so a
release script can refuse capability claims instead of trusting prose.

## Rows

The matrix covers: Google Docs typing and edit operations, Word for Web
typing, Gmail compose, a generic React form, CodeMirror, Monaco,
contenteditable IME, a cross-origin iframe form, a virtualized table, canvas
drag/zoom, and human interference. Each row names its correctness assertions in
`bench/tasks/phase12-installed-apps.json`.

## Release rule

A release may describe a capability only when its row is `qualified` in this
run. "Fastest", "best", "universal", and application-support claims additionally
require the matched competitor evidence enforced by
`scripts/check-best-chrome-release-gate.mjs` and
`scripts/check-v3-release-gate.mjs`.
