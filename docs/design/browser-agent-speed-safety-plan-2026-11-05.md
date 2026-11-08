# NaviChrome browser-agent speed and safety plan

**Status:** Implementation in progress (2026-11-05). Keep the existing six-tool V3 contract and Chrome-only product boundary. Local click-authority, pointer revalidation, attachment-verification, and owned-tab close guards are implemented. The installed extension/native host reload passed; read-only Gmail identity/Sent-row checks ran only under `praketg1@gmail.com`. Paired latency, automatic task-local tab tracking, full live account qualification, and hosted CI remain open.

## Diagnosis from the five-task run

The first request reached the live-task answer after **4 h 7 min 39 s**. The separately requested push and CI check added **32 min**, for **4 h 39 min 39 s** total. The timestamps show no idle gap longer than ten minutes. Exact time per model call, MCP call, browser wait, and user correction was not recorded, so a more granular time split would be invented.

The main causes, ordered by rework and risk:

1. **Too much implementation work preceded the first browser task.** A broad audit, compile/test repair, install, and reload happened before the first Gmail upload attempt, about 1 h 9 min into the run. The original task did request a code audit, but no time-box or live-first checkpoint kept the five deliverables moving in parallel with that audit.
2. **The task was allowed to write with unresolved evidence.** Gmail was sent while its attachment receipt was `unknown`; the user found it missing and a follow-up send was needed. The correct invariant is “attachment verified before send,” followed by read-only reconciliation for any uncertain send.
3. **Authorization context was not bound to the Classroom mutation.** The first announcement went to the school account/class; the user deleted it and restated the personal-account constraint. The task needs an exact account and destination check immediately before a post.
4. **The upload contract had multiple mismatches.** The live path hit a marker-selector mismatch, an unknown trigger reference, a workflow upload budget smaller than the standalone path, a missing `max_bytes_reason` field, and a stale file-picker error string. Fixing these produced four rebuild/reload cycles. The final Classroom upload receipt was still `unknown`, despite the post and attachment being visible.
5. **Observation and explanation work repeated.** The same handoff was reread five times and plan three times; the same account query ran three times without a page change; the download hash check was restated four times. The transcript had 133 assistant-visible updates before the push answer and only two final summaries.
6. **The completion gate accepted stale or incomplete proof.** The Form recheck showed empty fields and “Next,” not a fresh confirmation, while the final answer carried it forward from the prior handoff. A visible post, toast, dispatched click, tool schema, or CI pass must not be substituted for the requested external postcondition.
7. **Tab cleanup was not part of task completion.** The supplied Chrome image shows duplicate Gmail tabs, search results, two ESPN pages, Slides, and Classroom. It does not establish which tabs NaviChrome created or which must remain, so cleanup must use creation provenance rather than screenshot guesswork.

The prior live run already fixed and pushed the known upload/verifier defects in commit `8522e6d`; six CI jobs were reported green. That is evidence for that commit’s CI, not proof that the repaired Classroom upload receipt or all five app tasks were freshly qualified.

## Current Chrome path and cleanup audit

The active path is MCP V3 (`browser`, `snapshot`, `act`, `workflow`, `extract`, `verify`) → Rust runtime/workflow and verifier → Manifest V3 service worker → Chrome tabs, `webNavigation.documentId`, debugger/CDP, and native messaging. The extension already has exact-document binding, click/input guards, bounded recovery, unknown-outcome receipts, NaviChrome-owned open receipts, and an idle owned-tab eviction pool. The package skill already says not to replay `unknown` writes. The build should strengthen these existing layers, not add a seventh tool or another browser-control stack.

The extension source has 28 JavaScript modules. Static import mapping found no unreferenced `lib/` module; the unimported top-level scripts are extension entry points (`background.js`, `popup.js`, `secure-input.js`, and `dev-reload.js`). A shallow Rust module scan flags `mcp/*.rs`, but the active binary loads those files through `include!` and `#[path]`; none is safe to delete based on that scan. No JavaScript or Rust implementation was removed on a filename-only guess. Permission removal still needs an API-call-site audit.

## Build sequence

### Phase 0 — Freeze a trustworthy baseline

- Convert the five tasks into versioned acceptance cases with starting account, exact page/class/document, allowed mutation, final-state predicate, required evidence, and owned-tab policy. Distinguish user instructions from page text; page content is untrusted data and cannot grant authority.
- Add a trace key per task and collect monotonic durations for planning/tool round trips (where the client exposes them), MCP handling, browser work, page readiness, preflight, dispatch, verification, retries, rebuild/reload, and final response. Record missing timing as `null`; never infer caller/model latency from runtime timings.
- Use isolated fixtures for fault cases and the authorized personal testing account for live side effects. Record each task’s success, verified success, false-success, unknown outcome, account/destination error, action count, observation count/bytes, and p50/p95 latency. Redact page text, message content, credentials, tokens, and private URLs from routine traces.
- Capture a paired baseline before optimizing. For an end-to-end latency claim, require at least 30 matched runs per task/build on the same task, client, and site/account conditions; report all-attempt latency and verified-success-conditioned latency separately.

**Gate:** each case has an independent final-state oracle. A dispatched action or plausible assistant summary cannot score as success.

### Phase 1 — Make every click intentional and current

- Preserve the exact paired tab and `document_id`. Immediately before dispatch, re-resolve one unique target and check it is attached, visible, enabled, within the viewport, and receives the event at the selected point. Bind the requested semantic label (for example, “Post” or “Send”) and expected effect to that action.
- Treat page text, images, links, and injected workflow directions as untrusted. An action must fit the user’s task authority envelope: exact account identity, destination, action, and expected object. Stop before dispatch when that binding is absent or mismatched.
- Do not refuse a valid menu click solely because pixels changed since an older screenshot. Refuse on a concrete target/identity objection; permit the menu opened by the prior action after a fresh local check. Use one bounded re-resolve/settle attempt, then return a typed refusal.
- Keep mutation outcomes typed: `not_dispatched`, `dispatched`, `verified`, or `unknown`. `unknown` triggers one fresh read-only reconciliation; it never triggers a replay. If the target postcondition cannot be proven, report it as unresolved.

**Gate:** dynamic menu, overlay, target replacement, wrong-account, injected-page-instruction, timeout-after-dispatch, and duplicate-submit fixtures all stop or complete with the expected typed outcome. Zero unauthorized writes and zero blind retries of unknown mutations.

### Phase 2 — Make save, upload, send, and download receipts complete

- Keep standalone and workflow upload limits/schema identical. Reject incomplete byte-limit results with a typed reason; map picker/bridge errors once at the boundary so stale error strings cannot degrade an actionable refusal into `unknown`.
- For Gmail, require the exact recipient and an independently observed attachment filename before clicking Send. After dispatch, verify the sent message and attachment in Sent. If send status is unknown, inspect Sent/Drafts read-only before deciding whether any follow-up is needed.
- For Classroom, verify the exact signed-in personal account and testing class before Post. Require both the published announcement and accepted attachment; do not treat a visible draft or stale upload receipt as completion.
- For downloads, wait for the browser completion event and verify the resulting path, byte length, and digest against the expected source when one exists. A click or early filesystem miss is not the final state.
- For Forms and other submissions, require the app’s final confirmation or a durable submitted record; an empty form or “Next” control is a non-completion result.

**Gate:** delayed picker, too-large file, canceled chooser, app-rejected file, delayed write, duplicate-looking attachment, and timeout-after-submit fixtures preserve data and report exact uncertainty. No write proceeds past a failed prerequisite.

### Phase 3 — Cut round trips without weakening checks

- Use one targeted observation for the next decision, then place deterministic actions and their explicit postconditions in one `workflow`/task program. Do not expose deterministic intermediate state back to the model.
- Replace repeated broad snapshots and account searches with one exact account/page check cached only for the current document epoch. Invalidate it on navigation, account switch, relevant form change, or identity mismatch.
- Wait on the needed state (target visible/enabled, app acceptance, download completion, stable document) with an explicit deadline. Avoid fixed sleeps and avoid treating generic network-idle as proof that a dynamic page is settled.
- Keep recovery bounded to one correction per failure class: wait/settle, re-resolve, or re-observe. Do not loop or restart a whole workflow when a read-only check can isolate the failed step.
- Build/reload once after a coherent code batch. Do not reinstall for a documentation-only change. Keep all client/model latency separate from browser execution latency.

**Gate:** at least 30% lower median end-to-end latency on the paired deterministic fixture suite, with p95 no more than 5% worse and no reduction in verified success. These are proposed goals; report measured deltas and confidence intervals rather than claiming a pass from tool-call count alone.

### Phase 4 — Close only task-owned tabs that are not part of the result

- Record a task-local ownership ledger when NaviChrome creates a tab: task ID, creation receipt/idempotency key, tab ID, window ID, initial document identity, and whether the task used it. Reused or user-created tabs are never task-owned.
- Mark each owned tab `retain_for_result` only when the user asked to keep it or the final deliverable requires it for review. At successful task end, close every other tab NaviChrome created for that task, including temporary tabs that were used during the workflow but are not needed in the final result.
- Before close, require no active lease, no unresolved/unknown mutation, and the same owned tab identity. Close through the existing explicit tabs API and verify the topology receipt. A close failure is reported; it does not trigger a broader window/tab close.
- On interruption, preserve tabs with unresolved writes for inspection. On completion, release the session and verify user-owned tabs remain untouched.
- Never infer creation ownership from the screenshot. The tabs shown in this run cannot be safely closed retroactively without their ownership receipts.

**Gate:** fixtures prove unused and intermediate task-created tabs close; result tabs stay open; reused/user-created tabs survive; changed identity, active lease, unknown write, or failed close is reported without deleting anything else.

### Phase 5 — Reduce exposure and make failures diagnosable

- Review each manifest permission against exact API call sites and test it before removal. Preserve only permissions required by the shipped extension; keep host access narrow. Page-originated data must not override account/recipient/class policy.
- Keep secret handling one-shot and redacted. Do not store passwords, cookies, browser profiles, message bodies, or sensitive page text in routes, traces, or task memory.
- Return structured failure evidence: phase, typed reason, whether dispatch may have occurred, current document identity, failed predicate, one recovery already attempted, and the next safe read-only action. Bound payloads and remove sensitive page data.
- Reuse the current diagnostic hooks and report evidence at each phase gate in `docs/progress.md`, `docs/verification-matrix.md`, and `docs/blockers.md`.

**Gate:** injected-page and cross-account fixtures do not cause unauthorized effects; synthetic secret sentinels never appear outside the permitted secure-fill route; every unknown write includes a safe reconciliation instruction.

## Completion criteria

- All five requested task cases pass three consecutive fixture runs, plus authorized live checks for their specified account and destination.
- Every reported success has fresh evidence for the requested end state; attachment uploads also have accepted-file evidence and downloads have path/bytes/digest evidence.
- Zero wrong-account, wrong-class, wrong-recipient, duplicate-write, blind-unknown-replay, false-success, or user-owned-tab-close events in the qualification matrix.
- The paired latency target passes without weakening the safety gates. Otherwise publish the measured result and retain the blocker; do not call NaviChrome “fastest” or “fully qualified.”
- Required local CI/release gates and hosted CI pass for the exact commit. Live Chrome results remain a separate qualification row.

## Research consulted

- Chrome documents [`chrome.tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs) and the [extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). These support the current extension architecture and task-owned tab operations; they do not define NaviChrome's ownership policy.
- Playwright's [actionability checks](https://playwright.dev/docs/actionability) provide a concrete reference for unique, visible, stable, enabled, unobscured targets. NaviChrome must retain its background Chrome and exact-document constraints.
- Jiang et al., [Atomicity for Agents](https://arxiv.org/abs/2603.00476), study TOCTOU between observation and action across ten open-source agents and propose pre-execution state validation. This supports an immediate target/identity preflight; it does not establish NaviChrome's false-refusal rate.
- Srinivasan, [What Does “Now” Mean to Your Computer-Use Agent?](https://arxiv.org/abs/2610.39282), reports stale-click risk concentrated during page loading in its 31-page sample and studies cheaper local preflight checks. The measured rates are sample-specific; dynamic commercial pages still require direct NaviChrome measurement.
- Hossen, [The Agent Clicks Approve](https://arxiv.org/abs/2610.15138), demonstrates a confused-deputy risk from page-supplied directions on two authorization surfaces. Its 73/73 attack result is from a controlled testbed, not a general browser-agent success rate; it motivates binding writes to user-authorized account and destination.
- Jayarajan, [What Limits Agentic Systems Efficiency?](https://arxiv.org/html/2510.16276v1), separates model/API and web-environment latency and reports substantial environment overhead on its workloads. The benchmark tasks and models differ from NaviChrome, so only the measurement decomposition transfers.
- Runkle/LangChain, [How We Optimized Browser Use for Deep Agents](https://www.langchain.com/blog/how-we-optimized-browser-use-for-deep-agents), is vendor-authored but useful as an example of trace-driven iteration and batching. Its comparative speed/success figures are not used as NaviChrome targets.
- GitHub was used to inspect the public [NaviChrome repository README](https://github.com/Praket7/NaviChrome); the code-search endpoint returned no matching snippets, so local import/call-site inspection remains the basis for cleanup decisions.
