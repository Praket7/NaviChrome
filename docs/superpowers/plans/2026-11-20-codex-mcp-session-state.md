# Codex MCP Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let concurrent Codex NaviChrome MCP processes initialize successfully while retaining only unresolved operation journals.

**Architecture:** Treat `NAVICHROME_STATE_DIR` as a shared root, and put each MCP process lock, operation journal, and heartbeat in a unique child directory. Preserve active and unresolved session directories; remove inactive directories only after recovery and checking their journal contains no unresolved operation.

**Tech Stack:** Rust, `rusqlite`, existing filesystem lock helper, Node integration-config checks.

**Spec:** `docs/superpowers/specs/2026-11-20-codex-mcp-session-state-design.md`

## Global Constraints

- Keep unresolved journals until their delivery outcome is reconciled.
- Never delete a session directory while its `server.lock` is held.
- Keep browser target leases coordinated in the configured root; the lock, journal, and heartbeat are per-process.
- Preserve the dirty checkout and exact dependency versions.

## Review Focus

- A second live process must receive a different path and complete its lock acquisition.
- A journal containing an accepted, running, or unknown operation must never be pruned.
- A resolved inactive journal must be removed, including SQLite WAL/SHM files, to limit storage.
- Missing or malformed journals must not be treated as unresolved delivery data or cause deletion of an active directory.
- PID reuse must not attach a new session to an older journal; use a random session suffix.

---

### Task 1: Journal cleanup predicate

**Files:**
- Modify: `crates/navichrome-runtime/src/jobs.rs`
- Test: `crates/navichrome-runtime/src/jobs.rs` unit tests

**Interfaces:**
- Produces: `Journal::has_unresolved_operations(&self) -> Result<bool, JournalError>`

- [x] **Step 1: Add a failing journal test** asserting false for an empty journal and a journal with only terminal operations, and true for an operation whose delivery is unresolved.
- [x] **Step 2: Run the focused Rust test and confirm the new method is missing.**
- [x] **Step 3: Implement the predicate with one SQLite `EXISTS` query for nonterminal statuses or `delivery='unknown'`.**
- [x] **Step 4: Run the focused Rust test and confirm it passes.**

### Task 2: Per-process state directories and safe pruning

**Files:**
- Create: `crates/navichrome-runtime/src/mcp/session_state.rs`
- Modify: `crates/navichrome-runtime/src/mcp.rs` module declarations
- Test: `crates/navichrome-runtime/src/mcp/session_state.rs` unit tests

**Interfaces:**
- Consumes: `Journal::has_unresolved_operations` from Task 1.
- Produces: `create_session_state_dir(root: &Path, pid: u32) -> Result<PathBuf, SessionStateError>` and `prune_resolved_sessions(root: &Path, active: &Path) -> Result<(), SessionStateError>`.

- [x] **Step 1: Test that two session-directory creations under one root return distinct existing directories.**
- [x] **Step 2: Test pruning removes only inactive resolved directories, retaining a locked directory and any directory with unresolved operations.**
- [ ] **Step 3: Run focused Rust tests and verify they fail before implementation.** (Not run before implementation.)
- [x] **Step 4: Implement unique PID-plus-random directory names and fail-safe pruning: acquire each candidate lock, recover safe pre-dispatch work, retain unreadable journals, and delete only after confirming no unresolved operations.**
- [x] **Step 5: Run the focused tests and confirm the active lock remains acquirable and unresolved fixtures remain on disk.**

### Task 3: Wire MCP startup, shutdown, and documentation

**Files:**
- Modify: `crates/navichrome-runtime/src/mcp/v2.rs`
- Modify: `crates/navichrome-runtime/src/mcp/v3_full.rs`
- Modify: `crates/navichrome-runtime/src/process_lease.rs`
- Modify: `crates/navichrome-runtime/src/doctor.rs`
- Modify: `README.md`
- Test: `crates/navichrome-runtime/src/mcp/session_state.rs` lifecycle tests

**Interfaces:**
- Consumes: `create_session_state_dir` and `prune_resolved_sessions` from Task 2.

- [x] **Step 1: Add a lifecycle test showing normal shutdown removes its resolved session directory while a simulated unresolved session remains.**
- [ ] **Step 2: Run the focused lifecycle test and confirm it fails before wiring.** (Not run before wiring.)
- [x] **Step 3: Wire both stdio entry points to process directories and heartbeats, recover their journals, prune safe prior directories, and remove resolved session data only after releasing the directory lock.**
- [x] **Step 4: Update the README to describe the root/session-directory behavior and the unresolved-journal retention rule.**
- [x] **Step 5: Run focused Rust tests and `npm run check:clients`; then perform a direct stdio MCP initialization against the configured root and confirm `tools/list` succeeds for two concurrent processes.**
