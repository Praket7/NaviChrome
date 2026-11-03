# Rules for AI agents working on NaviChrome

NaviChrome exists to drive the user's **real Chrome, in the background, without stealing their screen**, and to report only what it can prove. Every rule below protects one of those two properties. When a change trades either one away for convenience, the change is wrong.

## 1. Background is the product, not an implementation detail

1. **Never promote a background action to a foreground one.** Background CDP dispatch, background tab selection, and off-screen clicks are the product. A "fix" that brings a window forward, activates a tab, raises focus, or scrolls the user's viewport has broken NaviChrome even if the click lands.
2. **Never take the user's focus, cursor, clipboard, or active tab.** Do not use OS-level input injection, `osascript` keystrokes, or anything that moves the physical pointer.
3. **Operate on the exact paired tab and `document_id`.** No "the active tab" shortcuts, no implicit "current window" targeting, no cross-tab fallbacks that quietly pick something else.
4. **Release the session without closing the user's tab or window.** Cleanup means dropping the lease, not tidying the user's browser.
5. **A background-only route that fails is a bug to fix, not a reason to go foreground.** If trusted input is refused in background mode (`trusted_key_route_required`), that is a real limitation to design around, not a licence to raise the window.
6. **`NAVICHROME_UNRESTRICTED=1` is a local fixture escape hatch for page guards only.** Transport, identity, lease, and postcondition checks stay enforced. Never ship a path that depends on it.

## 2. The contract is stable

7. **Keep the six V3 tools:** `browser`, `snapshot`, `act`, `workflow`, `extract`, `verify`. Do not add a seventh tool to work around a design problem, and do not rename or reshape existing ones casually.
8. **Never reintroduce blind replay.** `not_dispatched` may be corrected and retried; `unknown` requires fresh read-only verification and must never be replayed.
9. **Deterministic multi-step work belongs in one `browser open` with `steps` or one `workflow`.** Do not bounce intermediate deterministic state through the model.
10. **Observe only what the next decision needs.** One targeted snapshot with bounded items and `max_text_chars: 0` when body text is unnecessary. No broad duplicate snapshots.

## 3. Receipts never guess

11. **Never infer an outcome you did not observe.** No `Focused` because a control looked focused; no "uploaded" because a click was dispatched; no "downloaded" because a button was pressed.
12. **`dispatched_unver` and `outcome_not_declared` are honest answers.** Prefer them to a confident lie. When they appear for a common action (toolbar bold, menu toggles), the fix is to *add a real verification signal*, not to widen the guess.
13. **A receipt must name its evidence**: the saved file path for a download, the accepted filename for an upload, the document identity for a navigation. "It probably worked" is not a receipt.
14. **Never claim a speedup without a measurement**, and never claim a capability you have not exercised end to end in the real browser.
15. **Retain failed evidence.** Do not delete a failing test, log, or run to make a report look clean.

## 4. Guards must cost less than the mistake they prevent

16. **A pre-click guard may refuse only when it has a concrete, actionable objection** — the target is detached, obscured, disabled, outside the viewport, or the named label is not under the pointer.
17. **Never compare the click spot against the previous screenshot as a refusal condition.** This produced 22 false stops in a single Google Slides run, every one a menu the agent had just opened. Image drift is not evidence of an unsafe click.
18. **The click carries the words it intends to press** (`Insert`, `Share`, `Post`). Refuse only when those words are not under the pointer. That is the semantic check; the element-kind check (password/hidden/file/image, submit/reset) stays separate and narrower.
19. **Anything the agent itself just opened must pass the guard.** If opening a menu can invalidate the next click on that menu, the guard is broken by construction.
20. **Never degrade the agent to one click per turn.** 126 turns where 61 suffice is a guard failure, not caution. Latency and round trips are part of correctness.
21. **Recovery must be non-mutating and bounded.** Re-scroll, settle, wait for enablement, rebind, or re-anchor — each rung consumed once, with no loop on a stuck page.

## 5. Security and data

22. **No credential storage, browser profiles, cookies, or password managers.**
23. **A user password may pass once through `act(action="secure_fill")`.** Keep it out of every other tool, observation, workflow, trace, log, and persistent memory. Never echo a secret back.
24. **Synthetic sentinels are for redaction tests only.** Do not claim the chat transcript or client tool history can be erased.
25. **Never learn or replay credential-bearing, ambiguous, or sensitive routes.** Route memory must be bounded, origin-scoped, expiring, and quarantined on drift.

## 6. Scope discipline

26. **Chrome and web apps inside Chrome only.** No native desktop automation, no OS-level control, no second browser engine.
27. **No monolithic Comptrol import.** Keep the extracted-file Apache-2.0 attribution and update `provenance/extraction.json` whenever extracted source changes.
28. **`docs/design/` is proposals, not support.** Claim a capability only after its evidence gate passes.
29. **Do not add unrelated assets, dependencies, or abstraction layers.** The smallest change that fixes the cause wins.

## 7. Code and verification hygiene

30. **Match the repo's conventions and Rust version** (`rust-toolchain.toml`), keep direct dependency versions exact, and commit `Cargo.lock` changes.
31. **Run the gates before pushing:** `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, `npm run check:provenance`, `npm run check:docs`, and `node extensions/navichrome/test-background.cjs`.
32. **`--lib --bins` is not enough.** CI lints `--all-targets` on macOS; test-target warnings are real failures there.
33. **Fix the cause, never the assertion.** No weakened assertions, no skipped tests, no `#[allow]` or type suppressions to get green. If a test genuinely measures the wrong window (e.g. an async warm-up landing inside a count baseline), fix the measurement — and say why in the commit.
34. **A stale embedded asset digest is a real bug.** When you add a runtime asset, update `EXTENSION_RUNTIME_ASSETS` in `build.rs` *and* the native-host asset list.
35. **Update `docs/progress.md`, `docs/verification-matrix.md`, and `docs/blockers.md` at phase gates.**

## 8. Sequencing

36. **Finish P0 before Phase 1, and Phase 1 before Phase 2.** Do not build on an unfinished baseline.
37. **One P0 at a time, with a test and a measurement.** P0-3 first (contained, measurable), then P0-2, P0-4, P0-5.
38. **CI green before committing** and never report an environment as passing until you have read the conclusion of every job.

## 9. Driving the live browser (for agents testing NaviChrome)

39. **Use the real Chrome via the NaviChrome MCP host, not the preview panel**, unless the user asks for a preview.
40. **`snapshot` invalidates every prior `@cN` ref.** Take a fresh snapshot immediately before each act.
41. **Semantic refs are ambiguous and unstable** (`button "Bold"` matches twice; accessible names change after typing). Prefer stable refs from a fresh snapshot.
42. **The account marker must equal the full aria-label exactly** — substring matching fails with `account_marker_mismatch`.
43. **The MCP session is process-scoped.** A persistent stdio host must own it; verify the process is alive before assuming a live session.
44. **Prove downloads and uploads from the filesystem and the receipt**, not from a click or a toast.
