#!/usr/bin/env node
// Phase 12 headed OS matrix recorder.
//
// This runner does not manufacture cross-platform coverage. It binds the
// current host identity to the evidence that was actually produced here, and
// records every other OS cell as unqualified. A release may therefore claim
// only the cells listed under `qualified_cells`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const CHROME = process.env.CONTROLLA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function chromeVersion() {
  try {
    return execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function osIdentity() {
  if (process.platform === 'darwin') {
    const name = execFileSync('sw_vers', ['-productName'], { encoding: 'utf8' }).trim();
    const version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    const build = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
    return { family: 'macos', name: `${name} ${version}`, version, build, arch: process.arch };
  }
  if (process.platform === 'win32') {
    return { family: 'windows', name: `Windows ${process.getSystemVersion?.() ?? ''}`.trim(), version: process.getSystemVersion?.() ?? null, build: null, arch: process.arch };
  }
  if (process.platform === 'linux') {
    const version = process.getSystemVersion?.() ?? null;
    return { family: 'linux', name: `Linux ${version ?? ''}`.trim(), version, build: null, arch: process.arch };
  }
  return { family: process.platform, name: process.platform, version: null, build: null, arch: process.arch };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

export async function recordOsMatrix({ installedEvidence, concurrencyEvidence, output }) {
  const os = osIdentity();
  const chrome = chromeVersion();
  const installed = await readJson(installedEvidence);
  const concurrency = await readJson(concurrencyEvidence);
  const installedRows = Array.isArray(installed?.results) ? installed.results : [];
  const qualifiedInstalled = installedRows.filter((row) =>
    row.application_accepted === true
    && row.client_completed === true
    && row.assertions_passed === true
    && typeof row.evidence_hash === 'string'
    && row.evidence_hash.length >= 8
  );
  const installedApplications = [...new Set(qualifiedInstalled.map((row) => String(row.id).split('-')[0]))];
  const backgroundQualified = concurrency?.summary?.all_verified === true
    && concurrency?.summary?.all_clean === true
    && Number.isInteger(concurrency?.environment?.tabs)
    && concurrency.environment.tabs >= 8;
  const multiProcessQualified = concurrency?.multi_process?.all_verified === true
    && concurrency?.multi_process?.all_clean === true
    && Number.isInteger(concurrency?.multi_process?.processes)
    && concurrency.multi_process.processes >= 2;
  const cells = [
    {
      os: os.name,
      arch: os.arch,
      browser: chrome,
      mode: 'headed_installed_chrome',
      qualified: qualifiedInstalled.length > 0,
      evidence: installedEvidence,
      evidence_hash: sha256(qualifiedInstalled),
      row_count: qualifiedInstalled.length,
      applications: installedApplications,
    },
    {
      os: os.name,
      arch: os.arch,
      browser: chrome,
      mode: 'background_concurrent_tabs',
      qualified: backgroundQualified,
      evidence: concurrencyEvidence,
      evidence_hash: sha256(concurrency?.summary ?? null),
      tabs: concurrency?.environment?.tabs ?? null,
      peak_overlap: concurrency?.summary?.peak_overlap ?? null,
      wrong_target_events: concurrency?.summary?.wrong_target_events ?? null,
    },
    {
      os: os.name,
      arch: os.arch,
      browser: chrome,
      mode: 'multi_process_concurrent_tabs',
      qualified: multiProcessQualified,
      evidence: concurrencyEvidence,
      evidence_hash: sha256(concurrency?.multi_process?.rows ?? null),
      processes: concurrency?.multi_process?.processes ?? null,
      peak_overlap: concurrency?.multi_process?.peak_overlap ?? null,
      wrong_target_events: concurrency?.multi_process?.wrong_target_events ?? null,
    },
  ];
  const known = new Set(['macos', 'windows', 'linux']);
  const unqualifiedPlatforms = [...known].filter((family) => family !== os.family).map((family) => ({
    family,
    reason: 'not executed on this host; cross-OS behavior is not inferred from macOS evidence',
  }));
  const report = {
    version: 1,
    kind: 'phase12_os_matrix',
    generated_at_iso: new Date().toISOString(),
    host: { ...os, chrome },
    qualified_cells: cells.filter((cell) => cell.qualified),
    cells,
    unqualified_platforms: unqualifiedPlatforms,
    claim_scope: `only ${os.name} ${os.arch} is evidenced by this run`,
    cross_os_claim_allowed: false,
  };
  await mkdir(dirname(resolve(root, output)), { recursive: true });
  await writeFile(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const installedEvidence = option('installed-evidence', 'bench/reports/phase12-installed-evidence-2026-10-31.json');
  const concurrencyEvidence = option('concurrency-evidence');
  const output = option('output', `bench/reports/phase12-os-matrix-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
  if (!concurrencyEvidence) throw new Error('--concurrency-evidence is required');
  recordOsMatrix({ installedEvidence, concurrencyEvidence, output })
    .then((report) => {
      console.log(JSON.stringify({
        host: report.host,
        qualified_cells: report.qualified_cells.map((cell) => cell.mode),
        unqualified_platforms: report.unqualified_platforms.map((entry) => entry.family),
      }, null, 2));
    })
    .catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
