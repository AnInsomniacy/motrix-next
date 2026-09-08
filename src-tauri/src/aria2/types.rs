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
    pub priority: Option<String>,
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
    #[serde(default, rename = "privateTorrent")]
    pub private_torrent: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default, rename = "fileSelectionState")]
    pub file_selection_state: Option<String>,
    #[serde(default)]
    pub error: Option<Aria2BtError>,
    #[serde(default, rename = "infoHashV1")]
    pub info_hash_v1: Option<String>,
    #[serde(default, rename = "infoHashV2")]
    pub info_hash_v2: Option<String>,
    #[serde(default, rename = "currentTracker")]
    pub current_tracker: Option<String>,
    #[serde(default, rename = "numPeers")]
    pub num_peers: Option<String>,
    #[serde(default, rename = "connectingPeers")]
    pub connecting_peers: Option<String>,
    #[serde(default, rename = "handshakingPeers")]
    pub handshaking_peers: Option<String>,
    #[serde(default, rename = "numSeeds")]
    pub num_seeds: Option<String>,
    #[serde(default)]
    pub progress: Option<String>,
    #[serde(default)]
    pub availability: Option<String>,
    #[serde(default, rename = "failedLength")]
    pub failed_length: Option<String>,
    #[serde(default, rename = "redundantLength")]
    pub redundant_length: Option<String>,
    #[serde(default, rename = "activeTime")]
    pub active_time: Option<String>,
    #[serde(default, rename = "finishedTime")]
    pub finished_time: Option<String>,
    #[serde(default, rename = "connectCandidates")]
    pub connect_candidates: Option<String>,
    #[serde(default, rename = "uploadingPeers")]
    pub uploading_peers: Option<String>,
    #[serde(default, rename = "webSeeds")]
    pub web_seeds: Vec<String>,
    #[serde(default, rename = "numComplete")]
    pub num_complete: Option<String>,
    #[serde(default, rename = "numIncomplete")]
    pub num_incomplete: Option<String>,
}

/// Structured BitTorrent operation error emitted independently from task state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2BtError {
    pub code: String,
    pub kind: String,
    pub category: String,
    pub message: String,
    pub recoverable: String,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

/// Name sub-object within `Aria2BtInfo.info`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Aria2BtName {
    pub name: String,
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
    #[serde(default)]
    pub kad_firewalled: Option<bool>,
    #[serde(default)]
    pub kad_observed_address_count: Option<String>,
    #[serde(default)]
    pub search_active: Option<bool>,
    #[serde(default)]
    pub search_more_results: Option<bool>,
    #[serde(default)]
    pub search_result_count: Option<String>,
    #[serde(default)]
    pub sharing_time: Option<String>,
    #[serde(default)]
    pub uploading_peer_count: Option<String>,
    #[serde(default)]
    pub waiting_upload_peer_count: Option<String>,
    #[serde(default)]
    pub peer_credit_count: Option<String>,
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
pub struct Aria2BtSessionStatus {
    pub listen_port: String,
    pub announce_port: String,
    pub external_ip: String,
    pub mapped_tcp_port: String,
    pub mapped_udp_port: String,
    pub dht_nodes: String,
    pub dht_replacement_nodes: String,
    pub dht_active_requests: String,
    pub dropped_alerts: String,
    pub peer_sockets: String,
    pub established_peers: String,
    pub handshaking_peers: String,
    pub half_open_peers: String,
    pub tcp_peers: String,
    pub utp_peers: String,
    pub queued_tracker_announces: String,
    pub connection_attempts: String,
    pub connection_timeouts: String,
    pub payload_downloaded: String,
    pub payload_uploaded: String,
    pub tracker_downloaded: String,
    pub tracker_uploaded: String,
    #[serde(default)]
    pub ip_overhead_downloaded: String,
    #[serde(default)]
    pub ip_overhead_uploaded: String,
    #[serde(default)]
    pub dht_downloaded: String,
    #[serde(default)]
    pub dht_uploaded: String,
    #[serde(default)]
    pub disk_blocks_in_use: String,
    #[serde(default)]
    pub queued_disk_jobs: String,
    #[serde(default)]
    pub average_disk_job_time: String,
    #[serde(default)]
    pub disk_request_latency: String,
    #[serde(default)]
    pub disk_read_waiting_peers: String,
    #[serde(default)]
    pub disk_write_waiting_peers: String,
    #[serde(default)]
    pub last_performance_warning: Option<String>,
    #[serde(default)]
    pub performance_warnings: std::collections::HashMap<String, String>,
    pub dht_state_healthy: String,
    #[serde(default)]
    pub listen_endpoints: Vec<String>,
    #[serde(default)]
    pub port_mapping_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aria2BtTrackerConfig {
    pub url: String,
    pub tier: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aria2BtPeerAddResult {
    pub added: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2TorrentInspectionFile {
    pub index: String,
    pub path: String,
    pub length: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2TorrentInspection {
    pub name: String,
    pub mode: String,
    pub info_hash_v1: String,
    pub info_hash_v2: String,
    pub total_length: String,
    pub files: Vec<Aria2TorrentInspectionFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2BtTrackerEndpoint {
    pub local_endpoint: String,
    pub protocol: String,
    pub status: String,
    pub failures: String,
    pub seeders: String,
    pub leechers: String,
    pub downloads: String,
    pub next_announce: String,
    pub min_announce: String,
    pub updating: String,
    pub verified: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2BtTracker {
    pub url: String,
    pub source: String,
    pub tier: String,
    pub status: String,
    pub failures: String,
    pub seeders: String,
    pub leechers: String,
    pub downloads: String,
    pub next_announce: String,
    pub min_announce: String,
    pub updating: String,
    pub verified: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub endpoints: Vec<Aria2BtTrackerEndpoint>,
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
    #[serde(default)]
    pub data: Option<serde_json::Value>,
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
                "mode": "multi",
                "state": "downloading",
                "infoHashV1": "abc123def456",
                "infoHashV2": "def456abc123",
                "numPeers": "7",
                "connectingPeers": "2",
                "handshakingPeers": "1"
            },
            "infoHash": "abc123def456",
            "seeder": "true",
            "numSeeders": "5"
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        let bt = task.bittorrent.as_ref().unwrap();
        assert_eq!(bt.info.as_ref().unwrap().name, "test.torrent");
        assert_eq!(bt.mode.as_deref(), Some("multi"));
        assert_eq!(bt.state.as_deref(), Some("downloading"));
        assert_eq!(bt.info_hash_v2.as_deref(), Some("def456abc123"));
        assert_eq!(bt.num_peers.as_deref(), Some("7"));
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
                "callbackWaitingPeerCount": "1",
                "sharingTime": "84"
            }
        });
        let task: Aria2Task = serde_json::from_value(json).expect("deserialize");
        let ed2k = task.ed2k.as_ref().unwrap();
        assert_eq!(ed2k.completed_length.as_deref(), Some("0"));
        assert_eq!(ed2k.sharing_time.as_deref(), Some("84"));
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

    #[test]
    fn deserialize_native_bt_runtime_contract() {
        let status: Aria2BtSessionStatus = serde_json::from_value(serde_json::json!({
            "listenPort": "29120",
            "announcePort": "29120",
            "externalIp": "203.0.113.7",
            "mappedTcpPort": "29120",
            "mappedUdpPort": "29120",
            "dhtNodes": "128",
            "dhtReplacementNodes": "8",
            "dhtActiveRequests": "2",
            "droppedAlerts": "0",
            "peerSockets": "12",
            "establishedPeers": "10",
            "handshakingPeers": "2",
            "halfOpenPeers": "2",
            "tcpPeers": "8",
            "utpPeers": "4",
            "queuedTrackerAnnounces": "1",
            "connectionAttempts": "30",
            "connectionTimeouts": "3",
            "payloadDownloaded": "4096",
            "payloadUploaded": "1024",
            "trackerDownloaded": "512",
            "trackerUploaded": "256",
            "dhtStateHealthy": "true",
            "listenEndpoints": ["0.0.0.0:29120"]
        }))
        .expect("deserialize BT session status");
        assert_eq!(status.dht_state_healthy, "true");

        let tracker: Aria2BtTracker = serde_json::from_value(serde_json::json!({
            "url": "udp://tracker.example:6969/announce",
            "source": "global",
            "tier": "1",
            "status": "working",
            "failures": "0",
            "seeders": "12",
            "leechers": "4",
            "downloads": "20",
            "nextAnnounce": "600",
            "minAnnounce": "300",
            "updating": "false",
            "verified": "true",
            "endpoints": [{
                "localEndpoint": "0.0.0.0:29120",
                "protocol": "v1",
                "status": "working",
                "failures": "0",
                "seeders": "12",
                "leechers": "4",
                "downloads": "20",
                "nextAnnounce": "600",
                "minAnnounce": "300",
                "updating": "false",
                "verified": "true"
            }]
        }))
        .expect("deserialize BT tracker status");
        assert_eq!(tracker.source, "global");
        assert_eq!(tracker.next_announce, "600");
        assert_eq!(tracker.endpoints[0].min_announce, "300");
    }

    #[test]
    fn deserialize_bt_file_selection_and_error_contract() {
        let info: Aria2BtInfo = serde_json::from_value(serde_json::json!({
            "state": "paused",
            "fileSelectionState": "awaiting",
            "error": {
                "code": "1",
                "kind": "invalidFileSelection",
                "category": "configuration",
                "message": "select-file is required",
                "recoverable": "true",
                "operation": "resume"
            }
        }))
        .expect("deserialize BT file selection contract");

        assert_eq!(info.file_selection_state.as_deref(), Some("awaiting"));
        let error = info.error.expect("structured BT error");
        assert_eq!(error.kind, "invalidFileSelection");
        assert_eq!(error.recoverable, "true");
        assert_eq!(error.operation.as_deref(), Some("resume"));
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
