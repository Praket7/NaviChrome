fn is_failed_network_diagnostic(entry: &serde_json::Value) -> bool {
    entry["kind"] == "network"
        || (entry["kind"] == "log" && entry["source"] == "network")
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn unchanged_snapshot_replays_without_a_scan_and_mutation_invalidates_it() {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    let executable =
        std::path::Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert!(executable.is_file());
    let mut app = super::AppV3::new(super::super::AppV2::new(super::super::App::default()));
    app.headless_chrome = Some(executable.to_path_buf());
    let (server_io, client_io) = tokio::io::duplex(65_536);
    let server =
        rmcp::service::serve_directly::<rmcp::RoleServer, _, _, _, _>(app.clone(), server_io, None);
    let server_task = tokio::spawn(async move {
        let _ = server.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    let call = |name: &str, value: serde_json::Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(value.as_object().unwrap().clone())
    };
    let launch = client
        .call_tool(call(
            "browser",
            serde_json::json!({
                "action":"launch",
                "mode":"headless",
                "url":"data:text/html,%3Cbutton%3ESave%3C/button%3E%3Cinput%20aria-label%3D%22Name%22%20value%3D%22before%22%3E%3Cbutton%3ECancel%3C/button%3E"
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let session = launch["session_id"].as_str().unwrap().to_owned();
    let tab = launch["target_ids"][0].as_str().unwrap().to_owned();
    let first = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({"session_id":session,"chrome_tab_id":tab}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let snapshot_id = first["snapshot_id"].as_str().unwrap().to_owned();
    let item_count = first["items"].as_array().unwrap().len();
    assert!(item_count >= 3, "fixture controls missing: {first}");

    let second = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({
                "session_id":session,
                "chrome_tab_id":tab,
                "since_snapshot_id":snapshot_id,
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(second["observation_cache"]["hit"], true, "{second}");
    assert_eq!(
        second["observation_cache"]["basis"], "validated_interaction_epoch",
        "{second}"
    );
    assert_eq!(second["scanned_nodes"], 0, "{second}");
    assert_eq!(second["items"], serde_json::json!([]), "{second}");
    assert_eq!(second["delta"]["upsert"], serde_json::json!([]), "{second}");
    assert_eq!(second["delta"]["full"], false, "{second}");
    assert_eq!(
        second["unchanged_items_omitted"].as_u64().unwrap() as usize,
        item_count,
        "{second}"
    );

    {
        let live = app
            .core
            .legacy
            .shared_sessions
            .lock()
            .await
            .get(&session)
            .unwrap()
            .clone();
        let live = live.lock().await;
        live.connection
            .as_ref()
            .unwrap()
            .command(
                live.registry().unwrap(),
                &live.handle,
                &tab,
                "Runtime.evaluate",
                serde_json::json!({
                    "expression":"document.querySelector('button').textContent='Changed';true",
                    "returnByValue":true
                }),
            )
            .await
            .unwrap();
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let third = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({
                "session_id":session,
                "chrome_tab_id":tab,
                "since_snapshot_id":snapshot_id,
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_ne!(
        third["observation_cache"]["hit"], true,
        "mutation must invalidate the cached snapshot: {third}"
    );
    assert!(
        third["scanned_nodes"].as_u64().unwrap_or(0) > 0,
        "mutation must require a real scan: {third}"
    );
    assert!(
        third["delta"]["upsert"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "Changed"),
        "changed control missing from delta: {third}"
    );
    let _ = client.cancel().await;
    server_task.abort();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn failed_act_receipt_attaches_bounded_redacted_diagnostics() {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    let executable =
        std::path::Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert!(executable.is_file());
    let mut app = super::AppV3::new(super::super::AppV2::new(super::super::App::default()));
    app.headless_chrome = Some(executable.to_path_buf());
    let (server_io, client_io) = tokio::io::duplex(65_536);
    let server =
        rmcp::service::serve_directly::<rmcp::RoleServer, _, _, _, _>(app.clone(), server_io, None);
    let server_task = tokio::spawn(async move {
        let _ = server.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    let call = |name: &str, value: serde_json::Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(value.as_object().unwrap().clone())
    };
    let page = "data:text/html,<button id=b>Go</button><script>document.getElementById('b').onclick=()=>{console.error('password=act-secret');fetch('http://127.0.0.1:9/act-failed?token=act-secret').catch(()=>{})}</script>";
    let launch = client
        .call_tool(call(
            "browser",
            serde_json::json!({"action":"launch","mode":"headless","url":page}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let session = launch["session_id"].as_str().unwrap().to_owned();
    let tab = launch["target_ids"][0].as_str().unwrap().to_owned();
    let snapshot = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({"session_id":session,"chrome_tab_id":tab}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let reference = snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Go")
        .and_then(|item| item["reference"].as_str())
        .unwrap_or_else(|| panic!("Go button missing: {snapshot}"))
        .to_owned();
    let act = client
        .call_tool(call(
            "act",
            serde_json::json!({
                "session_id":session,
                "chrome_tab_id":tab,
                "action":"click",
                "reference":reference,
                "outcome":{"kind":"navigation","url":"https://example.test/never"},
                "timeout_ms":1000
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(act["status"], "dispatched_pending_verification", "{act}");
    let diagnostics = &act["diagnostics"];
    assert_eq!(diagnostics["attached_for"], "failure_receipt", "{act}");
    assert_eq!(diagnostics["source"], "cdp_event_buffer", "{act}");
    let entries = diagnostics["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("failure diagnostics missing: {act}"));
    assert!(
        entries.iter().any(|entry| entry["kind"] == "console"),
        "console diagnostic missing from failure receipt: {act}"
    );
    let network = entries
        .iter()
        .find(|entry| is_failed_network_diagnostic(entry))
        .unwrap_or_else(|| panic!("failed network diagnostic missing from failure receipt: {act}"));
    assert_eq!(network["host"], "127.0.0.1", "{act}");
    assert_eq!(network["path"], "/act-failed", "{act}");
    let serialized = act.to_string();
    assert!(!serialized.contains("act-secret"), "secret leaked: {act}");
    assert!(!serialized.contains("token="), "query leaked: {act}");
    assert!(act.to_string().len() <= 2048, "failure receipt exceeded budget: {act}");
    let _ = client.cancel().await;
    server_task.abort();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn failed_workflow_receipt_attaches_bounded_redacted_diagnostics() {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    let executable =
        std::path::Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert!(executable.is_file());
    let mut app = super::AppV3::new(super::super::AppV2::new(super::super::App::default()));
    app.headless_chrome = Some(executable.to_path_buf());
    let (server_io, client_io) = tokio::io::duplex(65_536);
    let server =
        rmcp::service::serve_directly::<rmcp::RoleServer, _, _, _, _>(app.clone(), server_io, None);
    let server_task = tokio::spawn(async move {
        let _ = server.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    let call = |name: &str, value: serde_json::Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(value.as_object().unwrap().clone())
    };
    let page = "data:text/html,<button id=b>Run</button><script>document.getElementById('b').onclick=()=>{console.error('password=workflow-secret');fetch('http://127.0.0.1:9/workflow-failed?token=workflow-secret').catch(()=>{})}</script>";
    let launch = client
        .call_tool(call(
            "browser",
            serde_json::json!({"action":"launch","mode":"headless","url":page}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let session = launch["session_id"].as_str().unwrap().to_owned();
    let tab = launch["target_ids"][0].as_str().unwrap().to_owned();
    let snapshot = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({"session_id":session,"chrome_tab_id":tab}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let reference = snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Run")
        .and_then(|item| item["reference"].as_str())
        .unwrap_or_else(|| panic!("Run button missing: {snapshot}"))
        .to_owned();
    let workflow = client
        .call_tool(call(
            "workflow",
            serde_json::json!({
                "session_id":session,
                "chrome_tab_id":tab,
                "steps":[{"kind":"click","reference":reference,"outcome":{"kind":"navigation","url":"https://example.test/never"}}]
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_ne!(workflow["status"], "completed", "{workflow}");
    let diagnostics = &workflow["diagnostics"];
    assert_eq!(diagnostics["attached_for"], "failure_receipt", "{workflow}");
    assert_eq!(diagnostics["source"], "cdp_event_buffer", "{workflow}");
    let entries = diagnostics["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("workflow failure diagnostics missing: {workflow}"));
    assert!(
        entries.iter().any(|entry| entry["kind"] == "console"),
        "console diagnostic missing from workflow receipt: {workflow}"
    );
    let network = entries
        .iter()
        .find(|entry| is_failed_network_diagnostic(entry))
        .unwrap_or_else(|| panic!("failed network diagnostic missing from workflow receipt: {workflow}"));
    assert_eq!(network["host"], "127.0.0.1", "{workflow}");
    assert_eq!(network["path"], "/workflow-failed", "{workflow}");
    let serialized = workflow.to_string();
    assert!(
        !serialized.contains("workflow-secret"),
        "secret leaked: {workflow}"
    );
    assert!(
        !serialized.contains("token="),
        "query leaked: {workflow}"
    );
    assert!(
        workflow.to_string().len() <= 2048,
        "workflow receipt exceeded budget: {workflow}"
    );
    let _ = client.cancel().await;
    server_task.abort();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn task_and_task_program_failure_receipts_attach_diagnostics() {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    let executable =
        std::path::Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert!(executable.is_file());
    let mut app = super::AppV3::new(super::super::AppV2::new(super::super::App::default()));
    app.headless_chrome = Some(executable.to_path_buf());
    let (server_io, client_io) = tokio::io::duplex(65_536);
    let server =
        rmcp::service::serve_directly::<rmcp::RoleServer, _, _, _, _>(app.clone(), server_io, None);
    let server_task = tokio::spawn(async move {
        let _ = server.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    let call = |name: &str, value: serde_json::Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(value.as_object().unwrap().clone())
    };
    let page = "data:text/html,<button id=a>Run</button><button id=b>Again</button><script>for(const id of ['a','b']){document.getElementById(id).onclick=()=>{console.error('password=task-secret');fetch('http://127.0.0.1:9/task-failed?token=task-secret').catch(()=>{})}}</script>";
    let launch = client
        .call_tool(call(
            "browser",
            serde_json::json!({"action":"launch","mode":"headless","url":page}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let session = launch["session_id"].as_str().unwrap().to_owned();
    let tab = launch["target_ids"][0].as_str().unwrap().to_owned();
    let snapshot = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({"session_id":session,"chrome_tab_id":tab}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let reference = snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Run")
        .and_then(|item| item["reference"].as_str())
        .unwrap_or_else(|| panic!("Run button missing: {snapshot}"))
        .to_owned();
    let task_steps = client
        .call_tool(call(
            "browser",
            serde_json::json!({
                "action":"task",
                "session_id":session,
                "chrome_tab_id":tab,
                "steps":[{"kind":"click","reference":reference,"outcome":{"kind":"navigation","url":"https://example.test/never"}}]
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_ne!(task_steps["status"], "completed", "{task_steps}");
    assert_eq!(
        task_steps["diagnostics"]["attached_for"], "failure_receipt",
        "{task_steps}"
    );
    let step_entries = task_steps["diagnostics"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("task-step diagnostics missing: {task_steps}"));
    assert!(
        step_entries.iter().any(|entry| entry["kind"] == "console"),
        "task-step console diagnostic missing: {task_steps}"
    );
    assert!(
        step_entries
            .iter()
            .any(|entry| is_failed_network_diagnostic(entry)),
        "task-step network diagnostic missing: {task_steps}"
    );
    assert!(!task_steps.to_string().contains("task-secret"));
    assert!(
        task_steps.to_string().len() <= 2048,
        "task-step receipt exceeded budget: {task_steps}"
    );

    let snapshot = client
        .call_tool(call(
            "snapshot",
            serde_json::json!({"session_id":session,"chrome_tab_id":tab}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let reference = snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Again")
        .and_then(|item| item["reference"].as_str())
        .unwrap_or_else(|| panic!("Again button missing: {snapshot}"))
        .to_owned();
    let task_program = client
        .call_tool(call(
            "browser",
            serde_json::json!({
                "action":"task",
                "session_id":session,
                "chrome_tab_id":tab,
                "task_program":{"steps":[{"kind":"click","reference":reference,"predicate":{"kind":"url","equals":"https://example.test/never"}}]}
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_ne!(task_program["status"], "completed", "{task_program}");
    assert_eq!(
        task_program["diagnostics"]["attached_for"], "failure_receipt",
        "{task_program}"
    );
    let program_entries = task_program["diagnostics"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("task-program diagnostics missing: {task_program}"));
    assert!(
        program_entries
            .iter()
            .any(|entry| entry["kind"] == "console"),
        "task-program console diagnostic missing: {task_program}"
    );
    assert!(
        program_entries
            .iter()
            .any(|entry| is_failed_network_diagnostic(entry)),
        "task-program network diagnostic missing: {task_program}"
    );
    assert!(!task_program.to_string().contains("task-secret"));
    assert!(
        task_program.to_string().len() <= 2048,
        "task-program receipt exceeded budget: {task_program}"
    );
    let _ = client.cancel().await;
    server_task.abort();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn diagnostics_return_bounded_redacted_console_and_failed_network_events() {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    let executable =
        std::path::Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert!(executable.is_file());
    let mut app = super::AppV3::new(super::super::AppV2::new(super::super::App::default()));
    app.headless_chrome = Some(executable.to_path_buf());
    let (server_io, client_io) = tokio::io::duplex(65_536);
    let server =
        rmcp::service::serve_directly::<rmcp::RoleServer, _, _, _, _>(app.clone(), server_io, None);
    let server_task = tokio::spawn(async move {
        let _ = server.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    let call = |name: &str, value: serde_json::Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(value.as_object().unwrap().clone())
    };
    let page = "data:text/html,<script>setTimeout(()=>{console.error('live diagnostic password=live-secret');fetch('http://127.0.0.1:9/missing?token=live-secret').catch(()=>{})},600)</script>";
    let launch = client
        .call_tool(call(
            "browser",
            serde_json::json!({"action":"launch","mode":"headless","url":page}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let session = launch["session_id"].as_str().unwrap().to_owned();
    let tab = launch["target_ids"][0].as_str().unwrap().to_owned();
    let mut diagnostics = serde_json::Value::Null;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        diagnostics = client
            .call_tool(call(
                "browser",
                serde_json::json!({
                    "action":"diagnostics",
                    "session_id":session,
                    "chrome_tab_id":tab,
                    "diagnostic_limit":8
                }),
            ))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        let entries = diagnostics["diagnostics"]["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let has_console = entries.iter().any(|entry| entry["kind"] == "console");
        let has_network = entries.iter().any(is_failed_network_diagnostic);
        if has_console && has_network {
            break;
        }
    }
    let entries = diagnostics["diagnostics"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("diagnostics missing: {diagnostics}"));
    assert!(
        entries.iter().any(|entry| entry["kind"] == "console"),
        "console diagnostic missing: {diagnostics}"
    );
    let network = entries
        .iter()
        .find(|entry| is_failed_network_diagnostic(entry))
        .unwrap_or_else(|| panic!("failed network diagnostic missing: {diagnostics}"));
    assert_eq!(network["host"], "127.0.0.1", "{diagnostics}");
    assert_eq!(network["path"], "/missing", "{diagnostics}");
    let serialized = diagnostics.to_string();
    assert!(
        !serialized.contains("live-secret"),
        "secret leaked into diagnostics: {diagnostics}"
    );
    assert!(
        !serialized.contains("token="),
        "query string leaked into diagnostics: {diagnostics}"
    );
    assert_eq!(diagnostics["diagnostics"]["truncated"], false, "{diagnostics}");
    let _ = client.cancel().await;
    server_task.abort();
}
