# Phase 12 matched competitor pilot — 2026-10-31

This report is generated from a real six-adapter pilot. It is not a universal speed or superiority claim.

## Method

- Task: example-domain-title-paragraph at `https://example.com/`.
- Runs: 3 counterbalanced repetitions per adapter.
- Environment: darwin-arm64, Google Chrome 156.0.8078.79, model `gpt-6-luna`.
- Controlla binary SHA-256: `b8f97f4f77149ea62c6f231f767ba9a9ed3c2d9e8b119e12cebbcf11d7fadb82`.
- Verification: an independent HTTPS fetch matched the exact title and first paragraph; the acting adapter also had to show the matching value in its own successful browser tool result.
- Timing: process spawn to independent verification, immediately before the Codex host spawned. It is not a prompt-send boundary.

## Results

| Adapter | Verified | Median (ms) | Min–max (ms) | Median input tokens | Median browser calls |
|---|---:|---:|---:|---:|---:|
| controlla-v3 | 100% (3/3) | 11939 | 11109–13636 | 88830 | 1 |
| stagehand-v4 | 100% (3/3) | 12320 | 9952–14700 | 71792 | 1 |
| playwright-mcp | 100% (3/3) | 19121 | 18183–88223 | 107052 | 3 |
| browser-use | 100% (3/3) | 16245 | 13639–23063 | 82124 | 3 |
| chrome-devtools-mcp | 100% (3/3) | 21664 | 18737–25737 | 169841 | 3 |
| agent-browser | 100% (3/3) | 13662 | 13500–16047 | 96793 | 3 |

Pilot leader by median verified latency: **controlla-v3**.

## What this proves

- All six configured adapters can complete the same read-only task against the same public page with independent verification.
- In this three-repetition pilot, Controlla passed every run and used one browser call per run.
- The result is directional evidence for the read-only path only. It does not establish a p50/p95 distribution, a universal speed claim, or installed-application parity.

## Why the claim gate stays closed

- the pilot scope is one read-only task; the full Phase 12 workload matrix was not run
- three paired repetitions are a pilot, not a p50/p95 release distribution

## Evidence

- Source pilot: `bench/reports/phase12-competitor-pilot-2026-10-31-3rep.json`
- Source SHA-256: `f730b7b340cf2e55bdbaedae1f6aab4e91bc7514b04adf778a08701b0c3c05eb`
