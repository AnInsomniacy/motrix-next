//! JSON-RPC transport. Task admission and visibility belong to the task service.
use crate::{
    aria2::types::{JsonRpcRequest, JsonRpcResponse},
    error::AppError,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};
use tokio::sync::RwLock;

pub struct RpcClient {
    http: reqwest::Client,
    credentials: RwLock<(u16, String)>,
    next_id: AtomicU64,
}
impl RpcClient {
    pub fn new(port: u16, secret: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .no_proxy()
                .build()
                .expect("local RPC client"),
            credentials: RwLock::new((port, secret)),
            next_id: AtomicU64::new(1),
        }
    }
    pub async fn credentials(&self) -> (u16, String) {
        self.credentials.read().await.clone()
    }
    pub async fn update_credentials(&self, port: u16, secret: String) {
        *self.credentials.write().await = (port, secret);
    }
    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        mut params: Vec<Value>,
    ) -> Result<T, AppError> {
        let (port, secret) = self.credentials().await;
        authorize(method, &mut params, &secret);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id: id.to_string(),
            method: method.into(),
            params,
        };
        let started = Instant::now();
        let result = async {
            let response = self
                .http
                .post(format!("http://127.0.0.1:{port}/jsonrpc"))
                .json(&request)
                .send()
                .await?;
            let status = response.status();
            let status_error = response.error_for_status_ref().err();
            let bytes = response.bytes().await?;
            let body: JsonRpcResponse<T> = serde_json::from_slice(&bytes).map_err(|error| {
                AppError::Aria2(format!(
                    "Invalid JSON-RPC response (HTTP {status}): {error}"
                ))
            })?;
            // aria2 carries native RPC errors in HTTP 400/404/500 responses.
            // Decode that envelope before treating the HTTP status as transport failure.
            if let Some(error) = body.error {
                if let Some(kind @ ("invalidBase64" | "torrentTooLarge" | "invalidTorrent")) = error
                    .data
                    .as_ref()
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                {
                    return Err(AppError::TorrentInspection {
                        kind: kind.into(),
                        message: error.message,
                    });
                }
                return Err(AppError::Rpc {
                    code: error.code,
                    message: error.message,
                    data: error.data,
                });
            }
            if let Some(error) = status_error {
                return Err(error.into());
            }
            body.result
                .ok_or_else(|| AppError::Aria2("Missing JSON-RPC result".into()))
        }
        .await;
        record_rpc_result(method, id, started, &result);
        result
    }
}
fn authorize(method: &str, params: &mut Vec<Value>, secret: &str) {
    if secret.is_empty() {
        return;
    }
    let token = Value::String(format!("token:{secret}"));
    if method == "system.multicall" {
        if let Some(calls) = params.first_mut().and_then(Value::as_array_mut) {
            for call in calls {
                if let Some(params) = call.get_mut("params").and_then(Value::as_array_mut) {
                    params.insert(0, token.clone());
                }
            }
        }
    } else {
        params.insert(0, token);
    }
}

fn is_polling_method(method: &str) -> bool {
    matches!(
        method,
        "aria2.getVersion"
            | "aria2.getGlobalStat"
            | "aria2.tellActive"
            | "aria2.tellWaiting"
            | "aria2.tellStopped"
            | "aria2.tellStatus"
            | "aria2.getPeers"
            | "aria2.getFiles"
    )
}

fn record_rpc_result<T>(method: &str, id: u64, started: Instant, result: &Result<T, AppError>) {
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Err(error) if is_polling_method(method) => log::debug!(
            target: "aria2_rpc",
            event = "rpc_unavailable",
            rpc_id = id,
            method,
            duration_ms,
            error:% = error;
            "rpc_unavailable"
        ),
        Err(error) => log::error!(
            target: "aria2_rpc",
            event = "rpc_failed",
            rpc_id = id,
            method,
            duration_ms,
            error:% = error;
            "rpc_failed"
        ),
        Ok(_) if duration_ms >= 1_000 => log::warn!(
            target: "aria2_rpc",
            event = "rpc_slow",
            rpc_id = id,
            method,
            duration_ms;
            "rpc_slow"
        ),
        Ok(_) if !is_polling_method(method) => log::debug!(
            target: "aria2_rpc",
            event = "rpc_completed",
            rpc_id = id,
            method,
            duration_ms;
            "rpc_completed"
        ),
        Ok(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multicall_authentication_is_attached_to_each_native_operation() {
        let mut params = vec![serde_json::json!([
            {"methodName":"aria2.tellStatus","params":["gid"]},
            {"methodName":"aria2.getVersion","params":[]}
        ])];
        authorize("system.multicall", &mut params, "secret");
        assert_eq!(
            params[0][0]["params"],
            serde_json::json!(["token:secret", "gid"])
        );
        assert_eq!(params[0][1]["params"], serde_json::json!(["token:secret"]));
    }
    #[tokio::test]
    async fn response_errors_preserve_native_data_and_invalid_utf8_is_rejected() {
        use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
        async fn respond(Json(request): Json<Value>) -> axum::response::Response {
            match request["method"].as_str().unwrap() {
                "aria2.invalidUtf8" => b"{\"result\":\"bad\xffname\"}".to_vec().into_response(),
                "aria2.unavailable" => {
                    (StatusCode::SERVICE_UNAVAILABLE, "unavailable").into_response()
                }
                method => {
                    let status = if method == "aria2.httpError" {
                        StatusCode::BAD_REQUEST
                    } else {
                        StatusCode::OK
                    };
                    (status, Json(serde_json::json!({
                        "jsonrpc":"2.0", "id":request["id"],
                        "error":{"code":1, "message":"Native failure", "data":{"kind":"taskConflict"}}
                    }))).into_response()
                }
            }
        }
        let router = Router::new().route("/jsonrpc", post(respond));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RpcClient::new(listener.local_addr().unwrap().port(), String::new());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for method in ["aria2.httpError", "aria2.rpcError"] {
            let error = client.call::<String>(method, vec![]).await.unwrap_err();
            assert!(
                matches!(error, AppError::Rpc { code:1, data:Some(data), .. }
                if data["kind"] == "taskConflict")
            );
        }
        assert!(
            matches!(client.call::<String>("aria2.invalidUtf8", vec![]).await,
            Err(AppError::Aria2(message)) if message.starts_with("Invalid JSON-RPC response"))
        );
        assert!(
            matches!(client.call::<String>("aria2.unavailable", vec![]).await,
            Err(AppError::Aria2(message)) if message.contains("HTTP 503"))
        );
        server.abort();
    }
}
