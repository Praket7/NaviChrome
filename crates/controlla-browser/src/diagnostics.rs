//! Bounded console and failed-network diagnostics.
//!
//! Events stay in memory for one browser connection. Text and URLs are
//! redacted and capped before they can reach a model-visible receipt.

use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

pub const MAX_DIAGNOSTIC_ENTRIES: usize = 32;
pub const MAX_DIAGNOSTIC_TEXT_CHARS: usize = 240;
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_NETWORK_PATH_CHARS: usize = 160;

#[derive(Default)]
pub struct DiagnosticsBuffer {
    entries: VecDeque<Value>,
    requests: HashMap<String, Value>,
    dropped: u64,
}

impl DiagnosticsBuffer {
    pub fn record(&mut self, event: &Value) {
        let Some(method) = event.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = event.get("params").unwrap_or(&Value::Null);
        match method {
            "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
                self.clear();
            }
            "Network.requestWillBeSent" => {
                let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                let Some(request) = params.get("request") else {
                    return;
                };
                let Some((scheme, host, path)) = bounded_url(
                    request
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) else {
                    return;
                };
                let Some(http_method) = request.get("method").and_then(Value::as_str) else {
                    return;
                };
                if self.requests.len() >= MAX_PENDING_REQUESTS
                    && let Some(oldest) = self.requests.keys().next().cloned()
                {
                    self.requests.remove(&oldest);
                }
                self.requests.insert(
                    request_id.to_owned(),
                    json!({
                        "scheme": scheme,
                        "host": host,
                        "path": path,
                        "method": bounded_text(http_method, 16),
                    }),
                );
            }
            "Network.responseReceived" => {
                let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                let Some(request) = self.requests.remove(request_id) else {
                    return;
                };
                let status = params
                    .pointer("/response/status")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                if status >= 400 {
                    let mut entry = request;
                    if let Some(object) = entry.as_object_mut() {
                        object.insert("kind".into(), json!("network"));
                        object.insert("status".into(), json!(status));
                        if let Some(status_text) = params
                            .pointer("/response/statusText")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                        {
                            object
                                .insert("status_text".into(), json!(bounded_text(status_text, 80)));
                        }
                    }
                    self.push(entry);
                }
            }
            "Network.loadingFailed" => {
                let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                let Some(request) = self.requests.remove(request_id) else {
                    return;
                };
                let mut entry = request;
                if let Some(object) = entry.as_object_mut() {
                    object.insert("kind".into(), json!("network"));
                    if let Some(error) = params.get("errorText").and_then(Value::as_str) {
                        object.insert("error".into(), json!(bounded_text(error, 120)));
                    }
                    if let Some(reason) = params.get("blockedReason").and_then(Value::as_str) {
                        object.insert("blocked_reason".into(), json!(bounded_text(reason, 80)));
                    }
                    if let Some(cors) = params
                        .pointer("/corsErrorStatus/corsError")
                        .and_then(Value::as_str)
                    {
                        object.insert("cors_error".into(), json!(bounded_text(cors, 80)));
                    }
                }
                self.push(entry);
            }
            "Runtime.consoleAPICalled" => {
                let level = params.get("type").and_then(Value::as_str).unwrap_or("log");
                if !matches!(level, "error" | "warning" | "assert") {
                    return;
                }
                let text = console_text(params);
                if text.is_empty() {
                    return;
                }
                self.push(json!({
                    "kind": "console",
                    "level": level,
                    "source": "runtime",
                    "text": text,
                }));
            }
            "Runtime.exceptionThrown" => {
                let details = params.get("exceptionDetails").unwrap_or(&Value::Null);
                let text = details
                    .pointer("/exception/description")
                    .and_then(Value::as_str)
                    .or_else(|| details.get("text").and_then(Value::as_str))
                    .unwrap_or("uncaught exception");
                self.push(json!({
                    "kind": "exception",
                    "level": "error",
                    "source": "runtime",
                    "text": bounded_text(text, MAX_DIAGNOSTIC_TEXT_CHARS),
                }));
            }
            "Log.entryAdded" => {
                let entry = params.get("entry").unwrap_or(&Value::Null);
                let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");
                if !matches!(level, "error" | "warning") {
                    return;
                }
                let text = entry
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("browser log entry");
                let mut value = json!({
                    "kind": "log",
                    "level": level,
                    "source": entry.get("source").and_then(Value::as_str).unwrap_or("browser"),
                    "text": bounded_text(text, MAX_DIAGNOSTIC_TEXT_CHARS),
                });
                if let Some((scheme, host, path)) =
                    bounded_url(entry.get("url").and_then(Value::as_str).unwrap_or_default())
                {
                    if let Some(object) = value.as_object_mut() {
                        object.insert("scheme".into(), json!(scheme));
                        object.insert("host".into(), json!(host));
                        object.insert("path".into(), json!(path));
                    }
                }
                self.push(value);
            }
            _ => {}
        }
    }

    pub fn snapshot(&mut self, limit: usize, clear: bool) -> Value {
        let total = self.entries.len();
        let returned = total.min(limit.clamp(1, MAX_DIAGNOSTIC_ENTRIES));
        let entries = self
            .entries
            .iter()
            .skip(total.saturating_sub(returned))
            .cloned()
            .collect::<Vec<_>>();
        let dropped = self.dropped;
        let omitted_by_limit = total.saturating_sub(returned);
        if clear {
            self.clear();
            self.dropped = 0;
        }
        json!({
            "status": "observed",
            "entries": entries,
            "captured": total,
            "returned": returned,
            "omitted_by_limit": omitted_by_limit,
            "dropped": dropped,
            "truncated": dropped > 0,
            "cleared": clear,
            "bounds": {
                "max_entries": MAX_DIAGNOSTIC_ENTRIES,
                "max_text_chars": MAX_DIAGNOSTIC_TEXT_CHARS,
            },
        })
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.requests.clear();
        self.dropped = 0;
    }

    fn push(&mut self, entry: Value) {
        if self.entries.len() >= MAX_DIAGNOSTIC_ENTRIES {
            self.entries.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.entries.push_back(entry);
    }
}

fn console_text(params: &Value) -> String {
    let text = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .take(8)
                .filter_map(|argument| {
                    if let Some(value) = argument.get("value").and_then(Value::as_str) {
                        Some(value.to_owned())
                    } else if argument.get("value").is_some_and(|value| !value.is_null()) {
                        argument.get("value").map(Value::to_string)
                    } else {
                        argument
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| {
                                argument
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .map(|kind| format!("[{kind}]"))
                            })
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    bounded_text(&text, MAX_DIAGNOSTIC_TEXT_CHARS)
}

fn bounded_text(value: &str, limit: usize) -> String {
    let mut normalized = String::with_capacity(value.len().min(limit));
    let mut space = false;
    for character in value.chars() {
        if normalized.len() >= limit {
            break;
        }
        if character.is_control() || character.is_whitespace() {
            if !space && !normalized.is_empty() {
                normalized.push(' ');
                space = true;
            }
        } else {
            normalized.push(character);
            space = false;
        }
    }
    let normalized = normalized.trim();
    let redacted = normalized
        .split_whitespace()
        .map(redact_token)
        .collect::<Vec<_>>()
        .join(" ");
    if redacted.chars().count() > limit {
        redacted.chars().take(limit).collect()
    } else {
        redacted
    }
}

fn redact_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if [
        "password=",
        "password:",
        "passwd=",
        "passwd:",
        "token=",
        "token:",
        "secret=",
        "secret:",
        "authorization:",
        "authorization=",
        "api_key=",
        "api_key:",
        "apikey=",
        "apikey:",
        "cookie=",
        "cookie:",
        "bearer",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        return "<redacted>".into();
    }
    if (lower.starts_with("http://") || lower.starts_with("https://"))
        && let Some((scheme, host, path)) = bounded_url(token)
    {
        return format!("{scheme}://{host}{path}");
    }
    token.to_owned()
}

fn bounded_url(value: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let authority_path = &rest[..end];
    let (authority, path) = authority_path
        .split_once('/')
        .map_or((authority_path, "/"), |(authority, path)| (authority, path));
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host).trim();
    if host.is_empty() || host.chars().any(char::is_control) {
        return None;
    }
    let path = format!("/{path}");
    let path = path.chars().take(MAX_NETWORK_PATH_CHARS).collect();
    Some((scheme, host.chars().take(255).collect(), path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_and_network_diagnostics_are_redacted_and_bounded() {
        let mut buffer = DiagnosticsBuffer::default();
        buffer.record(&json!({
            "method": "Runtime.consoleAPICalled",
            "params": {
                "type": "error",
                "args": [
                    {"type": "string", "value": "login failed password=hunter2"},
                    {"type": "string", "value": "https://example.test/callback?token=fixture-secret"}
                ]
            }
        }));
        buffer.record(&json!({
            "method": "Network.requestWillBeSent",
            "params": {
                "requestId": "r1",
                "request": {
                    "method": "POST",
                    "url": "https://user:pass@api.example.test/v1/items?api_key=fixture-secret#frag"
                }
            }
        }));
        buffer.record(&json!({
            "method": "Network.responseReceived",
            "params": {"requestId": "r1", "response": {"status": 503, "statusText": "Unavailable"}}
        }));
        let snapshot = buffer.snapshot(8, false);
        let text = snapshot.to_string();
        assert_eq!(snapshot["captured"], 2, "{snapshot}");
        assert!(!text.contains("hunter2"), "{snapshot}");
        assert!(!text.contains("fixture-secret"), "{snapshot}");
        assert!(!text.contains("/v1/items?"), "{snapshot}");
        assert_eq!(snapshot["entries"][1]["host"], "api.example.test");
        assert_eq!(snapshot["entries"][1]["path"], "/v1/items");
        assert_eq!(snapshot["entries"][1]["status"], 503);
    }

    #[test]
    fn diagnostics_drop_old_entries_and_clear_on_main_frame_navigation() {
        let mut buffer = DiagnosticsBuffer::default();
        for index in 0..40 {
            buffer.record(&json!({
                "method": "Log.entryAdded",
                "params": {"entry": {"level": "error", "source": "network", "text": format!("failure {index}")}}
            }));
        }
        let snapshot = buffer.snapshot(4, false);
        assert_eq!(snapshot["captured"], 32, "{snapshot}");
        assert_eq!(snapshot["returned"], 4, "{snapshot}");
        assert_eq!(snapshot["omitted_by_limit"], 28, "{snapshot}");
        assert_eq!(snapshot["dropped"], 8, "{snapshot}");
        assert_eq!(snapshot["truncated"], true, "{snapshot}");
        buffer.record(&json!({
            "method": "Page.frameNavigated",
            "params": {"frame": {"id": "root", "loaderId": "loader-2"}}
        }));
        assert_eq!(buffer.snapshot(4, false)["captured"], 0);
    }
}
