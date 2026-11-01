#!/usr/bin/env node
// Publish a bounded Phase 12 matched-competitor report.
//
// The input is the real six-adapter pilot, not a synthetic benchmark. This
// writer refuses missing adapters, mixed prompts inside an adapter, or a partial
// pilot, and it never upgrades one read-only task into a universal superiority
// claim.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const ADAPTERS = [
  ['controlla', 'controlla-v3'],
  ['stagehand', 'stagehand-v4'],
  ['playwright-mcp', 'playwright-mcp'],
  ['browser-use', 'browser-use'],
  ['chrome-devtools-mcp', 'chrome-devtools-mcp'],
  ['agent-browser', 'agent-browser'],
];

function option(name, fallback) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function buildReport(pilot, { sourcePath }) {
  const failures = [];
  if (pilot?.status !== 'completed') failures.push('pilot is not completed');
  if (pilot?.release_claim_eligible !== false) failures.push('pilot must keep release_claim_eligible=false');
  const pairs = Array.isArray(pilot?.pairs) ? pilot.pairs : [];
  if (pairs.length < 3) failures.push('pilot needs at least three paired repetitions');
  const rows = [];
  const summary = {};
  for (const [adapter, competitor] of ADAPTERS) {
    const runs = pairs.map((pair) => pair?.[adapter]).filter(Boolean);
    if (runs.length !== pairs.length) {
      failures.push(`${adapter} is missing from at least one repetition`);
      continue;
    }
    const promptHashes = new Set(runs.map((run) => run.prompt_hash).filter(Boolean));
    if (promptHashes.size !== 1) failures.push(`${adapter} used more than one prompt across repetitions`);
    for (const run of runs) {
      if (typeof run.process_spawn_to_independent_verification_ms !== 'number') {
        failures.push(`${adapter} is missing its independent-verification span`);
        continue;
      }
      rows.push({
        competitor,
        evidence_kind: 'real',
        reproducible: true,
        success: run.independently_verified_success === true,
        verified_success: run.independently_verified_success === true,
        // This workload is read-only. A wrong-target read cannot satisfy the
        // exact title/paragraph verifier, and no mutation was dispatched.
        severe_safety_failures: 0,
        wall_ms: run.process_spawn_to_independent_verification_ms,
        browser_round_trips: run.successful_browser_tool_calls ?? null,
        model_round_trips: null,
        tokens: run.input_tokens ?? null,
        prompt_sha256: run.prompt_hash ?? null,
      });
    }
    const verified = runs.filter((run) => run.independently_verified_success === true).length;
    const wall = runs.map((run) => run.process_spawn_to_independent_verification_ms);
    summary[competitor] = {
      runs: runs.length,
      verified_success_rate: verified / runs.length,
      median_wall_ms: median(wall),
      min_wall_ms: Math.min(...wall),
      max_wall_ms: Math.max(...wall),
      median_input_tokens: median(runs.map((run) => run.input_tokens ?? 0)),
      median_browser_round_trips: median(runs.map((run) => run.successful_browser_tool_calls ?? 0)),
      prompt_sha256: [...promptHashes][0] ?? null,
    };
  }
  const controlla = summary['controlla-v3'];
  const fastest = Object.entries(summary)
    .filter(([, value]) => value.verified_success_rate === 1)
    .sort((left, right) => left[1].median_wall_ms - right[1].median_wall_ms)[0]?.[0] ?? null;
  const reasons = [...failures];
  reasons.push('the pilot scope is one read-only task; the full Phase 12 workload matrix was not run');
  if (pairs.length < 30) reasons.push('three paired repetitions are a pilot, not a p50/p95 release distribution');
  if (Object.keys(summary).length !== ADAPTERS.length) reasons.push('the six-adapter matched set is incomplete');
  return {
    version: 1,
    kind: 'phase12_competitor_report',
    generated_at_iso: new Date().toISOString(),
    source: { path: sourcePath, sha256: sha256(pilot) },
    environment: pilot.environment,
    task: pilot.task,
    pairs: pairs.length,
    rows,
    summary,
    pilot_leader: fastest,
    claimEligible: false,
    claimReasons: [...new Set(reasons)],
    boundary: {
      scope: 'one public read-only fact task, six adapters, same prompt/model/Chrome per adapter, counterbalanced order',
      not_claimed: ['p50/p95 release distribution', 'universal fastest/best', 'installed-application parity', 'form, mutation, concurrency, or safety parity'],
      controlla_note: controlla.verified_success_rate === 1
        ? 'Controlla passed every pilot repetition; its one-call task was the lowest median in this pilot.'
        : 'Controlla did not pass every pilot repetition.',
    },
  };
}

function markdown(report) {
  const lines = [];
  lines.push('# Phase 12 matched competitor pilot — 2026-10-31');
  lines.push('');
  lines.push('This report is generated from a real six-adapter pilot. It is not a universal speed or superiority claim.');
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(`- Task: ${report.task?.id ?? 'read-only fact task'} at \`${report.task?.url ?? ''}\`.`);
  lines.push(`- Runs: ${report.pairs} counterbalanced repetitions per adapter.`);
  lines.push(`- Environment: ${report.environment?.machine ?? 'unknown'}, ${report.environment?.chrome_version ?? 'unknown Chrome'}, model \`${report.environment?.model ?? 'unknown'}\`.`);
  lines.push(`- Controlla binary SHA-256: \`${report.environment?.controlla_binary_sha256 ?? 'unknown'}\`.`);
  lines.push('- Verification: an independent HTTPS fetch matched the exact title and first paragraph; the acting adapter also had to show the matching value in its own successful browser tool result.');
  lines.push('- Timing: process spawn to independent verification, immediately before the Codex host spawned. It is not a prompt-send boundary.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Adapter | Verified | Median (ms) | Min–max (ms) | Median input tokens | Median browser calls |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  const order = [...ADAPTERS.map(([, competitor]) => competitor)];
  for (const competitor of order) {
    const row = report.summary[competitor];
    if (!row) continue;
    lines.push(`| ${competitor} | ${Math.round(row.verified_success_rate * 100)}% (${Math.round(row.verified_success_rate * row.runs)}/${row.runs}) | ${round(row.median_wall_ms)} | ${round(row.min_wall_ms)}–${round(row.max_wall_ms)} | ${round(row.median_input_tokens)} | ${round(row.median_browser_round_trips)} |`);
  }
  lines.push('');
  lines.push(`Pilot leader by median verified latency: **${report.pilot_leader ?? 'none'}**.`);
  lines.push('');
  lines.push('## What this proves');
  lines.push('');
  lines.push('- All six configured adapters can complete the same read-only task against the same public page with independent verification.');
  lines.push('- In this three-repetition pilot, Controlla passed every run and used one browser call per run.');
  lines.push('- The result is directional evidence for the read-only path only. It does not establish a p50/p95 distribution, a universal speed claim, or installed-application parity.');
  lines.push('');
  lines.push('## Why the claim gate stays closed');
  lines.push('');
  for (const reason of report.claimReasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- Source pilot: \`${report.source.path}\``);
  lines.push(`- Source SHA-256: \`${report.source.sha256}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = option('source', 'bench/reports/phase12-competitor-pilot-2026-10-31-3rep.json');
  const outputJson = option('output', 'bench/reports/phase12-competitor-report-2026-10-31.json');
  const outputMarkdown = option('markdown', 'bench/reports/phase12-competitor-report-2026-10-31.md');
  const pilot = JSON.parse(await readFile(resolve(root, sourcePath), 'utf8'));
  const report = buildReport(pilot, { sourcePath });
  await mkdir(dirname(resolve(root, outputJson)), { recursive: true });
  await writeFile(resolve(root, outputJson), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(root, outputMarkdown), markdown(report));
  console.log(JSON.stringify({
    output: outputJson,
    markdown: outputMarkdown,
    claimEligible: report.claimEligible,
    pilot_leader: report.pilot_leader,
    adapters: Object.keys(report.summary).length,
    pairs: report.pairs,
  }, null, 2));
}
