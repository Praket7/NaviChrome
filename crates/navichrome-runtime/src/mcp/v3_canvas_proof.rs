//! Document-text proof for canvas editors.
//!
//! Google Docs paints its document on a canvas and keeps the editable in a
//! hidden event-target frame. The DOM therefore cannot answer "is this text in
//! the document?". The proof path selects the document through the editor's own
//! commands, asks it to copy into a page-owned `DataTransfer`, and compares the
//! copied text with the expected value. It never reads or writes the user's
//! system clipboard.

use serde_json::{Value, json};
use std::time::Duration;

use super::AppV3;
use super::{
    copy_document_selection_event, document_tab_visible, press_shortcut,
};

/// Prove a canvas-editor insertion against the document itself.
///
/// The editable element never reports the typed text, and the page's DOM text
/// does not contain it (Google Docs paints a canvas). The document's own copy
/// event does: dispatching `copy` with a writable `DataTransfer` lets the
/// editor write the selection into a page-owned buffer. That proves the
/// insertion without touching the user's clipboard at all.
pub(super) async fn verify_canvas_document_text(
    connection: &super::super::PageSessionTransport,
    registry: &navichrome_browser::sessions::SessionRegistry,
    handle: &navichrome_browser::sessions::SessionHandle,
    tab_id: &str,
    object_id: &str,
    typed: &str,
    deadline: tokio::time::Instant,
) -> Value {
    use crate::document_text;
    let unavailable = |verification: &'static str| {
        json!({
            "status": "dispatched_unverified",
            "verification": verification,
            "document_text": Value::Null
        })
    };
    let sampled = document_text::verification_windows(typed).len();
    if sampled == 0 {
        return unavailable("too_short_for_text_match");
    }
    let cutoff = deadline.min(tokio::time::Instant::now() + Duration::from_secs(8));
    // Chrome withholds the document copy path from a hidden tab: the selection
    // never reaches the editor, so every readback would compare the user's
    // untouched clipboard against the document and call a successful insert a
    // mismatch. Say why instead, and leave the clipboard alone.
    if document_tab_visible(connection, registry, handle, tab_id, cutoff).await == Some(false) {
        return json!({
            "status": "dispatched_unverified",
            "verification": "tab_hidden",
            "document_text": Value::Null,
            "reason": "the document was not read because Chrome keeps a hidden tab's selection and clipboard out of reach",
            "next_action": "Bring this tab to the foreground and read the inserted text in the document; do not replay the insertion."
        });
    }
    let modifiers = if cfg!(target_os = "macos") { 4 } else { 2 };
    let _ = press_shortcut(
        connection, registry, handle, tab_id, cutoff, "a", "KeyA", 65, modifiers,
    )
    .await;
    // A background tab can swallow the OS copy shortcut, but the document can
    // still answer the copy event itself: dispatching `copy` with a writable
    // DataTransfer lets the editor write the selection into our own buffer.
    let mut copy_event_characters = 0_usize;
    let mut last_match = None;
    for attempt in 0..6 {
        if tokio::time::Instant::now() >= cutoff {
            break;
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        if let Some(document) = copy_document_selection_event(
            connection,
            registry,
            handle,
            tab_id,
            object_id,
            cutoff,
        )
        .await
        {
            copy_event_characters = document.chars().count();
            let result = document_text::verify_typed_text(typed, &document);
            if result.proven() {
                return json!({
                    "status": "verified",
                    "verification": "document_copy_event",
                    "document_text": {
                        "characters": document.chars().count(),
                        "hash": document_text::text_hash(&document),
                        "matched_windows": result.matched_windows,
                        "sampled_windows": result.sampled_windows,
                        "exact_contains": result.exact_contains,
                        "attempts": attempt + 1
                    }
                });
            }
            last_match = Some(result);
        }
    }
    // Collapse the select-all selection even when proof failed.
    let _ = press_shortcut(
        connection,
        registry,
        handle,
        tab_id,
        cutoff,
        "ArrowRight",
        "ArrowRight",
        39,
        0,
    )
    .await;
    let mut receipt = unavailable(if copy_event_characters == 0 {
        "copy_event_unavailable"
    } else {
        "copy_event_text_mismatch"
    });
    receipt["copy_event_characters"] = json!(copy_event_characters);
    if let Some(result) = last_match {
        receipt["document_text"] = json!({
            "matched_windows": result.matched_windows,
            "sampled_windows": result.sampled_windows,
            "exact_contains": result.exact_contains
        });
    }
    receipt["next_action"] = json!("Read the document text directly; do not replay the insertion.");
    receipt
}

/// A text predicate on a canvas editor cannot be answered from the DOM: the
/// document lives behind an event-target frame and reports no text. When the
/// page has such an editor, read the document through its own copy path and
/// prove the predicate there. This is a verification fallback, never a write.
pub(super) async fn verify_canvas_text_present(
    app: &AppV3,
    session_id: &str,
    tab_id: &str,
    text: &str,
) -> Option<Value> {
    let has_canvas_editor = app
        .core
        .semantic
        .lock()
        .await
        .get(&super::super::tab_key(session_id, tab_id))
        .is_some_and(|state| {
            state.items.values().any(|item| {
                item["role"] == "textbox"
                    && (item["value_readable"] == false
                        || item["source_kind"] == "same_origin_blank_frame")
            })
        });
    if !has_canvas_editor {
        return None;
    }
    let live = app
        .core
        .legacy
        .shared_sessions
        .lock()
        .await
        .get(session_id)?
        .clone();
    let shared = live.lock().await;
    let snapshot = shared.snapshots.get(tab_id)?;
    let connection = shared.connection.as_ref()?;
    let registry = shared.registry().ok()?;
    let proof = verify_canvas_document_text(
        connection,
        registry,
        &shared.handle,
        tab_id,
        &snapshot.object_id,
        text,
        tokio::time::Instant::now() + Duration::from_secs(8),
    )
    .await;
    if proof["status"] != "verified" {
        return None;
    }
    Some(json!({
        "status": "passed",
        "verified": true,
        "verification": proof["verification"],
        "document_text": proof["document_text"],
        "surface": {"canvas": false, "event_target_frame": true, "text_readable": false}
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn compact_bulk_type_keeps_insertion_proof() {
        let receipt = json!({
            "status":"verified","action":"type","typing_mode":"block",
            "bulk_insert":true,"completed_chars":4027,
            "verification":"document_copy_event",
            "document_text":{"characters":4027,"hash":"abcd","matched_windows":3,"sampled_windows":3,"exact_contains":true},
            "surface":{"canvas":false,"event_target_frame":true,"text_readable":false},
            "dispatch_acknowledged":true,"dispatch_may_have_occurred":true,
            "debug":"x".repeat(12_000)
        });
        let compacted = super::super::compact_v3_workflow_step(receipt, false, true);
        assert!(
            super::super::v3_workflow_response_size(&compacted) <= 640,
            "{}: {compacted}",
            super::super::v3_workflow_response_size(&compacted)
        );
        assert_eq!(compacted["bulk_insert"], true);
        assert_eq!(compacted["completed_chars"], 4027);
        assert_eq!(compacted["typing_mode"], "block");
        assert_eq!(compacted["verification"], "document_copy_event");
        assert_eq!(compacted["document_text"]["matched_windows"], 3);
    }
}
