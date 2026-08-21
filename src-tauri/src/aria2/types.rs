//! Aria2 JSON-RPC data transfer objects.
//!
//! All fields use `String` to match the aria2 JSON-RPC protocol where every
//! numeric value is represented as a string.  `#[serde(rename_all = "camelCase")]`
//! maps Rust snake_case fields to the camelCase keys emitted by aria2.

use serde::{Deserialize, Serialize};

/// URI entry within an aria2 file descriptor.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Aria2FileUri {
    pub uri: String,
    pub status: String,
}

/// Single file within an aria2 download task.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2File {
    pub index: String,
    pub path: String,
    pub length: String,
    pub completed_length: String,
    pub selected: String,
    #[serde(default)]
    pub uris: Vec<Aria2FileUri>,
}

/// BitTorrent metadata attached to a task when the download is a torrent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Aria2BtInfo {
    #[serde(default)]
    pub info: Option<Aria2BtName>,
    #[serde(default, rename = "announceList")]
    pub announce_list: Option<Vec<Vec<String>>>,
    #[serde(default, rename = "magnetLink")]
    pub magnet_link: Option<String>,
    #[serde(default, rename = "creationDate")]
    pub creation_date: Option<u64>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// Name sub-object within `Aria2BtInfo.info`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Aria2BtName {
    pub name: String,
}

fn bool_from_json_bool_or_string<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::Bool(value)) => Some(value),
        Some(serde_json::Value::String(value)) => match value.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

/// ED2K metadata attached to a task when the download is an ED2K file link or search request.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2Ed2kInfo {
    #[serde(default)]
    pub ed2k_link: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub length: Option<String>,
    #[serde(default)]
    pub completed_length: Option<String>,
    #[serde(default)]
    pub part_hash_count: Option<String>,
    #[serde(default)]
    pub aich_root: Option<String>,
    #[serde(default)]
    pub server_count: Option<String>,
    #[serde(default)]
    pub connected_server_count: Option<String>,
    #[serde(default)]
    pub peer_count: Option<String>,
    #[serde(default)]
    pub queued_peer_count: Option<String>,
    #[serde(default)]
    pub accepted_peer_count: Option<String>,
    #[serde(default)]
    pub dead_peer_count: Option<String>,
    #[serde(default)]
    pub low_id_peer_count: Option<String>,
    #[serde(default)]
    pub callback_waiting_peer_count: Option<String>,
    #[serde(default)]
    pub kad_node_count: Option<String>,
    #[serde(default)]
    pub kad_router_count: Option<String>,
    #[serde(default, deserialize_with = "bool_from_json_bool_or_string")]
    pub kad_firewalled: Option<bool>,
    #[serde(default)]
    pub kad_observed_address_count: Option<String>,
    #[serde(default, deserialize_with = "bool_from_json_bool_or_string")]
    pub search_active: Option<bool>,
    #[serde(default, deserialize_with = "bool_from_json_bool_or_string")]
    pub search_more_results: Option<bool>,
    #[serde(default)]
    pub search_result_count: Option<String>,
    #[serde(default)]
    pub uploading_peer_count: Option<String>,
    #[serde(default)]
    pub waiting_upload_peer_count: Option<String>,
    #[serde(default)]
    pub peer_credit_count: Option<String>,
}

/// HLS VOD metadata attached to a task when the download is an HLS playlist.
///
/// Enum-like fields are strings so this DTO does not depend on `hls` module types.
/// `segmentCount` / `segmentTotal` are JSON numbers, matching TypeScript `Aria2HlsInfo`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2HlsInfo {
    pub playlist_url: String,
    pub media_kind: String,
    pub segment_count: u32,
    pub segment_total: u32,
    pub encrypt_method: String,
    pub phase: String,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub fallback_ts_path: Option<String>,
}

/// Complete aria2 task object returned by tellStatus, tellActive,
/// tellWaiting, or tellStopped.
///
/// All numeric values are strings per the aria2 JSON-RPC protocol.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2Task {
    pub gid: String,
    pub status: String,
    pub total_length: String,
    pub completed_length: String,
    pub upload_length: String,
    pub download_speed: String,
    pub upload_speed: String,
    pub connections: String,
    pub dir: String,
    #[serde(default)]
    pub files: Vec<Aria2File>,
    #[serde(default)]
    pub bittorrent: Option<Aria2BtInfo>,
    #[serde(default)]
    pub ed2k: Option<Aria2Ed2kInfo>,
    #[serde(default)]
    pub hls: Option<Aria2HlsInfo>,
    #[serde(default)]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub num_seeders: Option<String>,
    #[serde(default)]
    pub seeder: Option<String>,
    #[serde(default)]
    pub bitfield: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub num_pieces: Option<String>,
    #[serde(default)]
    pub piece_length: Option<String>,
    #[serde(default)]
    pub verified_length: Option<String>,
    #[serde(default)]
    pub verify_integrity_pending: Option<String>,
    #[serde(default)]
    pub followed_by: Option<Vec<String>>,
    #[serde(default)]
    pub following: Option<String>,
    #[serde(default)]
    pub belongs_to: Option<String>,
}

/// Raw global statistics as returned by aria2 RPC (all values are strings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2GlobalStat {
    pub download_speed: String,
    pub upload_speed: String,
    pub num_active: String,
    pub num_waiting: String,
    pub num_stopped: String,
    pub num_stopped_total: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2BtEndpoint {
    pub listen_port: String,
    pub announce_port: String,
    pub external_ip: String,
}

// ── Internal JSON-RPC protocol types ────────────────────────────────

/// JSON-RPC 2.0 request envelope.
#[derive(Debug, Serialize)]
pub(crate) struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: String,
    pub method: String,
    pub params: Vec<serde_json::Value>,
}

/// JSON-RPC 2.0 response envelope.
#[derive(Debug, Deserialize)]
pub(crate) struct JsonRpcResponse<T> {
    pub result: Option<T>,
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Deserialize)]
pub(crate) struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Aria2Task deserialization ────────────────────────────────────

    #[test]
    fn deserialize_minimal_task_from_aria2_json() {
        let json = serde_json::json!({
            "gid": "abc123",
            "status": "active",
            "totalLength": "1024",
            "completedLength": "512",
            "uploadLength": "0",
            "downloadSpeed": "100",
            "uploadSpeed": "0",
            "connections": "5",
            "dir": "/tmp"
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        assert_eq!(task.gid, "abc123");
        assert_eq!(task.status, "active");
        assert_eq!(task.total_length, "1024");
        assert_eq!(task.completed_length, "512");
        assert!(task.files.is_empty());
        assert!(task.bittorrent.is_none());
        assert!(task.hls.is_none());
        assert!(task.error_code.is_none());
    }

    #[test]
    fn deserialize_task_with_bt_info() {
        let json = serde_json::json!({
            "gid": "bt001",
            "status": "active",
            "totalLength": "0",
            "completedLength": "0",
            "uploadLength": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "0",
            "dir": "/downloads",
            "bittorrent": {
                "info": { "name": "test.torrent" },
                "mode": "multi"
            },
            "infoHash": "abc123def456",
            "seeder": "true",
            "numSeeders": "5"
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        let bt = task.bittorrent.as_ref().unwrap();
        assert_eq!(bt.info.as_ref().unwrap().name, "test.torrent");
        assert_eq!(bt.mode.as_deref(), Some("multi"));
        assert_eq!(task.info_hash.as_deref(), Some("abc123def456"));
        assert_eq!(task.seeder.as_deref(), Some("true"));
        assert_eq!(task.num_seeders.as_deref(), Some("5"));
    }

    #[test]
    fn deserialize_ed2k_task() {
        let json = serde_json::json!({
            "gid": "ed2k001",
            "status": "active",
            "totalLength": "3389035",
            "completedLength": "0",
            "uploadLength": "0",
            "downloadSpeed": "65536",
            "uploadSpeed": "0",
            "connections": "3",
            "dir": "/downloads",
            "ed2k": {
                "hash": "3D366ED505B977FC61C9A6EE01E96329",
                "completedLength": "0",
                "lowIdPeerCount": "2",
                "callbackWaitingPeerCount": "1"
            }
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        let ed2k = task.ed2k.as_ref().unwrap();
        assert_eq!(ed2k.completed_length.as_deref(), Some("0"));
        assert_eq!(
            ed2k.hash.as_deref(),
            Some("3D366ED505B977FC61C9A6EE01E96329")
        );
        assert_eq!(ed2k.low_id_peer_count.as_deref(), Some("2"));
        assert_eq!(ed2k.callback_waiting_peer_count.as_deref(), Some("1"));
    }

    #[test]
    fn deserialize_task_with_error_fields() {
        let json = serde_json::json!({
            "gid": "err001",
            "status": "error",
            "totalLength": "0",
            "completedLength": "0",
            "uploadLength": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "0",
            "dir": "/tmp",
            "errorCode": "1",
            "errorMessage": "unknown error"
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        assert_eq!(task.error_code.as_deref(), Some("1"));
        assert_eq!(task.error_message.as_deref(), Some("unknown error"));
    }

    #[test]
    fn deserialize_ed2k_search_task_with_boolean_status_fields() {
        let json = serde_json::json!({
            "gid": "75c1fb5d8979819f",
            "status": "active",
            "totalLength": "0",
            "completedLength": "0",
            "uploadLength": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "2",
            "dir": "/Users/test/Downloads",
            "files": [
                {
                    "index": "1",
                    "path": "/Users/test/Downloads/aria2-next-ed2k-search-75c1fb5d8979819f",
                    "length": "0",
                    "completedLength": "0",
                    "selected": "true",
                    "uris": []
                }
            ],
            "ed2k": {
                "name": "ubuntu",
                "kadFirewalled": false,
                "searchActive": true,
                "searchMoreResults": false,
                "searchResultCount": "4"
            }
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        let ed2k = task.ed2k.as_ref().unwrap();
        assert_eq!(ed2k.search_active, Some(true));
        assert_eq!(ed2k.search_more_results, Some(false));
        assert_eq!(ed2k.kad_firewalled, Some(false));
    }

    #[test]
    fn deserialize_task_with_followed_by() {
        let json = serde_json::json!({
            "gid": "meta001",
            "status": "complete",
            "totalLength": "100",
            "completedLength": "100",
            "uploadLength": "0",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "0",
            "dir": "/tmp",
            "followedBy": ["child001", "child002"],
            "following": "parent001",
            "belongsTo": "parent001"
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        assert_eq!(
            task.followed_by.as_deref(),
            Some(&["child001".to_string(), "child002".to_string()][..])
        );
        assert_eq!(task.following.as_deref(), Some("parent001"));
        assert_eq!(task.belongs_to.as_deref(), Some("parent001"));
    }

    // ── Aria2GlobalStat deserialization ──────────────────────────────

    #[test]
    fn deserialize_global_stat() {
        let json = serde_json::json!({
            "downloadSpeed": "1048576",
            "uploadSpeed": "524288",
            "numActive": "3",
            "numWaiting": "1",
            "numStopped": "10",
            "numStoppedTotal": "100"
        });
        let stat: Aria2GlobalStat = serde_json::from_value(json).expect("deserialize");
        assert_eq!(stat.download_speed, "1048576");
        assert_eq!(stat.num_active, "3");
        assert_eq!(stat.num_stopped_total, "100");
    }

    // ── Aria2File deserialization ────────────────────────────────────

    #[test]
    fn deserialize_file_with_uris() {
        let json = serde_json::json!({
            "index": "1",
            "path": "/tmp/file.zip",
            "length": "1000",
            "completedLength": "500",
            "selected": "true",
            "uris": [
                { "uri": "http://example.com/file.zip", "status": "used" }
            ]
        });
        let file: Aria2File = serde_json::from_value(json).expect("deserialize");
        assert_eq!(file.index, "1");
        assert_eq!(file.path, "/tmp/file.zip");
        assert_eq!(file.uris.len(), 1);
        assert_eq!(file.uris[0].status, "used");
    }

    // ── JsonRpcRequest serialization ────────────────────────────────

    #[test]
    fn jsonrpc_request_serializes_correctly() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "motrix".to_string(),
            method: "aria2.getGlobalStat".to_string(),
            params: vec![serde_json::Value::String("token:secret123".to_string())],
        };
        let json = serde_json::to_value(&req).expect("serialize");
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], "motrix");
        assert_eq!(json["method"], "aria2.getGlobalStat");
        assert_eq!(json["params"][0], "token:secret123");
    }

    // ── JsonRpcResponse deserialization ──────────────────────────────

    #[test]
    fn jsonrpc_response_with_result() {
        let json = serde_json::json!({
            "id": "motrix",
            "jsonrpc": "2.0",
            "result": "OK"
        });
        let resp: JsonRpcResponse<String> = serde_json::from_value(json).expect("deserialize");
        assert_eq!(resp.result.as_deref(), Some("OK"));
        assert!(resp.error.is_none());
    }

    #[test]
    fn jsonrpc_response_with_error() {
        let json = serde_json::json!({
            "id": "motrix",
            "jsonrpc": "2.0",
            "error": { "code": -32600, "message": "Invalid Request" }
        });
        let resp: JsonRpcResponse<String> = serde_json::from_value(json).expect("deserialize");
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Invalid Request");
    }
}
