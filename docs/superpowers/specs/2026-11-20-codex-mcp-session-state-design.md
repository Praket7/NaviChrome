# Codex MCP session state design

## Intent

Prevent concurrent Codex MCP launches from failing the exclusive `server.lock` handshake while preserving a durable operation journal and heartbeat for each process.

## Findings

Codex's configured `NAVICHROME_STATE_DIR` is static, but multiple resumed Codex sessions launch independent stdio processes. Each process acquires an exclusive lock in that directory and opens `operations.sqlite`, so the second process exits before MCP initialization. The current launcher environment contains no stable Codex chat or session identifier.

## Approaches

1. **Per-process directories (selected):** give each MCP process its own state directory, lock, journal, and heartbeat beneath the configured state root. This removes lock contention and keeps concurrent runtime records distinct. Keep the journal while that process is active; after exit, delete its directory only when every operation is terminal. Preserve unresolved journals for manual reconciliation; a later process does not automatically resume them. Shared target leases remain coordinated at the configured root and resolve owner heartbeats by process ID and generation.
2. **Shared journal:** allow multiple MCP processes to share one SQLite journal and redesign locking/recovery for concurrent dispatch. This is a broader safety change and was not selected.

## Scope and constraints

- Keep the configured state path as the root and isolate process locks, journals, and heartbeats beneath it.
- On startup, prune only inactive session directories whose operations are all terminal; never delete an unresolved journal or a directory whose lock is held.
- Keep storage small during normal use; unresolved journals remain until reconciled because deleting them could erase evidence of an unknown delivery outcome.
- Preserve existing single-process behavior where possible.
- Add an assert-based regression check proving two concurrent launches receive separate paths, retain unresolved journals, and expose their own heartbeat to lease recovery.
- Do not claim cross-process automatic recovery until a stable logical session identity is available.

## Recovery boundary

The selected behavior is separate process-scoped journals, retained only while active or unresolved. New processes do not automatically resume older journals because the current Codex launcher does not provide a stable logical chat ID. Resolved inactive journals are deleted on a later launch; unresolved journals remain available for manual reconciliation.
