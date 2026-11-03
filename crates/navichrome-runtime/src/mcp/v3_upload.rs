//! Upload dispatch and evidence helpers.
//!
//! `v3_full.rs` keeps the MCP facade; this module owns the trigger-click,
//! chooser interception, picker drill-down, and upload evidence predicates.

use super::super::SharedLiveSession;
use super::{
    AppV3, BrowserClickOutcome, BrowserSnapshotArgs, StagedUploadFile, V3ActArgs, snapshot_impl,
};
use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(super) fn upload_file_set_matches(expected: &[StagedUploadFile], selected: &Value) -> bool {
    selected.as_array().is_some_and(|selected| {
        selected.len() == expected.len()
            && selected.iter().zip(expected).all(|(actual, expected)| {
                actual["name"] == expected.filename
                    && actual["size"].as_u64() == Some(expected.size)
            })
    })
}

pub(super) fn staged_upload_files_value(files: &[StagedUploadFile]) -> Value {
    Value::Array(files.iter().map(|file| json!({"filename":file.filename,"mime":file.mime,"size":file.size,"sha256":file.sha256,"source_identity":file.source_identity,"expires_at_ms":file.expires_at_ms})).collect())
}

pub(super) fn upload_acceptance_transition(was_passed: bool, is_passed: bool) -> bool {
    !was_passed && is_passed
}

pub(super) fn upload_evidence_complete(
    acceptance_requested: bool,
    application_accepted: &Value,
    persistence_requested: bool,
    persisted: &Value,
) -> bool {
    (acceptance_requested || persistence_requested)
        && (!acceptance_requested || application_accepted == true)
        && (!persistence_requested || persisted == true)
}

/// Application acceptance is independent evidence that the selected bytes reached
/// the page. Drive-backed pickers copy the file and clear the input they used, so
/// the input often no longer reports a selection afterwards; requiring that
/// readback turned a successful Classroom/Drive upload into `unknown`. Document
/// and account identity must still match before acceptance is trusted.
pub(super) fn upload_input_selection_confirmed(
    input_consumed_by_page: bool,
    document_matches: bool,
    marker_matches: bool,
    application_accepted: bool,
) -> bool {
    let _ = input_consumed_by_page;
    document_matches && marker_matches && application_accepted
}

pub(super) fn upload_picker_consumed_input(selection: &Value) -> bool {
    selection["status"] == "unknown"
        && selection["dispatch_acknowledged"] == true
        && selection["reason"].as_str().is_some_and(|reason| {
            reason.contains("File input did not retain one selected file for readback")
        })
}

pub(super) fn upload_selection_reason_code(status: &Value) -> &'static str {
    if status == "unknown" {
        "file_selection_unverified"
    } else {
        "frame_upload_failed"
    }
}

pub(super) fn upload_trigger_may_have_dispatched(click: &Value) -> bool {
    click["status"] != "not_dispatched"
}

pub(super) async fn upload_click(
    app: &AppV3,
    session_id: &str,
    tab_id: &str,
    reference: &str,
    client_id: Option<&str>,
    outcome: Option<BrowserClickOutcome>,
    timeout_ms: u64,
) -> Result<Value, ErrorData> {
    let result = app
        .act(Parameters(V3ActArgs {
            desktop_action: None,
            desktop_mode: None,
            expected_visual_revision: None,
            expected_label: None,
            session_id: session_id.to_owned(),
            chrome_tab_id: tab_id.to_owned(),
            action: "click".into(),
            reference: Some(reference.to_owned()),
            expected_value: None,
            value: None,
            key: None,
            outcome,
            timeout_ms: Some(timeout_ms),
            typing_mode: None,
            delay_ms: None,
            client_id: client_id.map(str::to_owned),
            page_tool_name: None,
            page_tool_input: None,
            max_bytes: None,
            max_bytes_reason: None,
            delta_x: None,
            delta_y: None,
            start_x: None,
            start_y: None,
            end_x: None,
            end_y: None,
            center_x: None,
            center_y: None,
            start_distance: None,
            end_distance: None,
            allow_password: None,
            expected_origin: None,
            account_marker: None,
            order_confirmation: None,
        }))
        .await?;
    Ok(result.0)
}

pub(super) async fn upload_chooser_event(
    live: &Arc<Mutex<SharedLiveSession>>,
    tab_id: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let live = live.lock().await;
    match (live.connection.as_ref(), live.registry()) {
        (Some(connection), Ok(registry)) => connection
            .command(
                registry,
                &live.handle,
                tab_id,
                "NaviChrome.waitForFileChooser",
                json!({"timeout_ms":timeout_ms}),
            )
            .await
            .map_err(|error| error.to_string()),
        (None, _) => Err("shared extension session has not been accepted".to_owned()),
        (_, Err(error)) => Err(error.to_string()),
    }
}

/// A Google Drive-style picker is opened by the attach trigger instead of a
/// native file chooser. Its "Browse" control creates the chooser that the
/// extension can intercept. Find that control inside a picker frame only, so a
/// normal page's Browse button is never pressed by an upload step.
fn upload_picker_reference<'a>(
    snapshot: &'a Value,
    names: &[&str],
    roles: &[&str],
) -> Option<(&'a str, bool)> {
    snapshot.get("items")?.as_array()?.iter().find_map(|item| {
        let frame = item
            .get("source_frame")
            .and_then(Value::as_str)
            .unwrap_or("main");
        if frame == "main" {
            return None;
        }
        let url = item
            .get("source_frame_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !(url.contains("picker") || url.contains("upload") || url.contains("drive.google.com")) {
            return None;
        }
        if !roles.contains(&item.get("role").and_then(Value::as_str)?) {
            return None;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if !names
            .iter()
            .any(|expected| name.eq_ignore_ascii_case(expected))
        {
            return None;
        }
        let reference = item.get("reference").and_then(Value::as_str)?;
        let selected = item.get("selected").and_then(Value::as_str) == Some("true");
        Some((reference, selected))
    })
}

async fn upload_picker_snapshot(
    app: &AppV3,
    session_id: &str,
    tab_id: &str,
) -> Result<Value, ErrorData> {
    snapshot_impl(
        &app.core,
        &BrowserSnapshotArgs {
            session_id: session_id.to_owned(),
            chrome_tab_id: tab_id.to_owned(),
            selector: None,
            max_items: Some(400),
            max_text_chars: Some(0),
            max_bytes: Some(1_000_000),
            max_bytes_reason: None,
            href_hint: None,
            frame_id: None,
            include_frames: Some(true),
            goal: None,
            max_scan_nodes: Some(65_536),
        },
    )
    .await
}

pub(super) async fn click_upload_picker_browse(
    app: &AppV3,
    live: &Arc<Mutex<SharedLiveSession>>,
    session_id: &str,
    tab_id: &str,
    client_id: Option<&str>,
) -> Result<Option<Value>, ErrorData> {
    let mut snapshot = upload_picker_snapshot(app, session_id, tab_id).await?;
    // Some pickers open on another pane; switch to Upload before browsing.
    if let Some((reference, false)) = upload_picker_reference(&snapshot, &["Upload"], &["tab"]) {
        let clicked = upload_click(
            app,
            session_id,
            tab_id,
            reference,
            client_id,
            Some(BrowserClickOutcome::Focused),
            2_000,
        )
        .await?;
        if upload_trigger_may_have_dispatched(&clicked) {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            snapshot = upload_picker_snapshot(app, session_id, tab_id).await?;
        }
    }
    let Some((reference, _)) = upload_picker_reference(
        &snapshot,
        &[
            "Browse",
            "Browse files",
            "Select files from your device",
            "Upload from computer",
            "Choose file",
            "Choose files",
        ],
        &["button", "link"],
    ) else {
        return Ok(None);
    };
    let clicked = upload_click(
        app,
        session_id,
        tab_id,
        reference,
        client_id,
        Some(BrowserClickOutcome::Focused),
        2_000,
    )
    .await?;
    if clicked["status"] == "not_dispatched" {
        return Ok(None);
    }
    // The picker's Browse click is a page-level control, so keep the wait
    // bounded: either the chooser opens (and is intercepted), or the caller's
    // lazy file-input fallback gets the input the picker just created.
    Ok(upload_chooser_event(live, tab_id, 2_000).await.ok())
}
