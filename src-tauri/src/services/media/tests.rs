use super::*;
use crate::aria2::types::{Aria2File, Aria2Media, Aria2MediaTrack, Aria2Task};
use axum::{extract::State as HttpState, http::StatusCode, routing::post, Json, Router};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Default)]
struct EngineFixture {
    tasks: Mutex<HashMap<String, Aria2Task>>,
    additions: AtomicUsize,
    starts: AtomicUsize,
    lose_start_reply: AtomicBool,
    last_options: Mutex<Value>,
}

async fn rpc(
    HttpState(state): HttpState<Arc<EngineFixture>>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let params = &request["params"];
    let gid = params[0].as_str().unwrap_or("");
    let mut tasks = state.tasks.lock().await;
    let result = match request["method"].as_str().unwrap_or("") {
        "system.multicall" => {
            let calls = params[0].as_array().expect("batch");
            Value::Array(
                calls
                    .iter()
                    .map(|call| {
                        let rows: Vec<_> = tasks
                            .values()
                            .filter(|task| match call["methodName"].as_str().expect("method") {
                                "aria2.tellActive" => task.status == "active",
                                "aria2.tellWaiting" => {
                                    matches!(task.status.as_str(), "waiting" | "paused")
                                }
                                "aria2.tellStopped" => {
                                    matches!(task.status.as_str(), "complete" | "error" | "removed")
                                }
                                _ => panic!("unexpected snapshot call"),
                            })
                            .cloned()
                            .collect();
                        json!([rows])
                    })
                    .collect(),
            )
        }
        "aria2.getVersion" => {
            json!({"enabledFeatures":["HLS/DASH"],"mediaFeatures":["request-contexts","stable-track-ids","structured-errors"]})
        }
        "system.listMethods" => json!(["aria2.finishMedia", "aria2.retryMedia"]),
        "aria2.addUri" => {
            state.additions.fetch_add(1, Ordering::Relaxed);
            let gid = params[1]["gid"].as_str().expect("assigned GID");
            *state.last_options.lock().await = params[1].clone();
            let task = Aria2Task {
                gid: gid.into(),
                status: "paused".into(),
                files: vec![Aria2File {
                    path: "/downloads/video.mp4".into(),
                    ..Default::default()
                }],
                media: Some(Aria2Media {
                    state: "awaiting-selection".into(),
                    protocol: "hls".into(),
                    live: "false".into(),
                    duration: "60000".into(),
                    tracks: vec![
                        Aria2MediaTrack {
                            id: "video-main".into(),
                            r#type: "video".into(),
                            selected: "true".into(),
                            width: "0".into(),
                            height: "0".into(),
                            bandwidth: "0".into(),
                            frame_rate: "0".into(),
                            ..Default::default()
                        },
                        Aria2MediaTrack {
                            id: "audio-main".into(),
                            r#type: "audio".into(),
                            selected: "true".into(),
                            width: "0".into(),
                            height: "0".into(),
                            bandwidth: "0".into(),
                            frame_rate: "0".into(),
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }),
                ..Default::default()
            };
            tasks.insert(gid.into(), task);
            json!(gid)
        }
        "aria2.tellStatus" => match tasks.get(gid) {
            Some(task) => json!(task),
            None => {
                return (
                    StatusCode::OK,
                    Json(
                        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":1,"message":"GID not found"}}),
                    ),
                )
            }
        },
        "aria2.changeOption" => {
            *state.last_options.lock().await = params[1].clone();
            json!("OK")
        }
        "aria2.unpause" => {
            state.starts.fetch_add(1, Ordering::Relaxed);
            let task = tasks.get_mut(gid).expect("existing probe");
            task.status = "active".into();
            task.media.as_mut().expect("media").state = "downloading".into();
            if state.lose_start_reply.swap(false, Ordering::Relaxed) {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"reply lost"})),
                );
            }
            json!(gid)
        }
        "aria2.forceRemove" => {
            if let Some(task) = tasks.get_mut(gid) {
                task.status = "removed".into();
            }
            json!(gid)
        }
        "aria2.removeDownloadResult" => {
            tasks.remove(gid);
            json!("OK")
        }
        "aria2.saveSession" => json!("OK"),
        _ => panic!("Unexpected fixture RPC: {}", request["method"]),
    };
    (
        StatusCode::OK,
        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})),
    )
}

struct Fixture {
    service: Arc<MediaService>,
    engine: Arc<EngineFixture>,
    server: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture listener");
        let port = listener.local_addr().expect("listener address").port();
        let engine = Arc::new(EngineFixture::default());
        let router = Router::new()
            .route("/jsonrpc", post(rpc))
            .with_state(engine.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("fixture server");
        });
        let directory = tempfile::tempdir().expect("fixture directory");
        let journal = Journal::open(directory.path().join("operations.db"))
            .await
            .expect("journal");
        let service = Arc::new(MediaService {
            engine: Arc::new(TaskService::new(port, String::new())),
            journal,
            submission_gate: Mutex::new(()),
            deferred_events: Mutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
        });
        Self {
            service,
            engine,
            server,
            _directory: directory,
        }
    }
    async fn ready(&self, request: ProbeRequest) -> Presentation {
        let id = request.id;
        self.service
            .create(request, Format::Mkv)
            .await
            .expect("probe creation");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let result = self.service.read(id).await.expect("probe read");
                if result["state"] == "ready" {
                    return serde_json::from_value(result["presentation"].clone())
                        .expect("presentation");
                }
                assert_eq!(result["state"], "probing");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("probe readiness")
    }
}

fn request() -> ProbeRequest {
    ProbeRequest {
        id: Uuid::new_v4(),
        source: Source {
            url: "https://media.example/stream.m3u8?token=opaque".into(),
            kind: SourceKind::Hls,
            page_url: "https://example.com/watch".into(),
            title: "Video".into(),
            filename: "stream.m3u8".into(),
            mime: "application/vnd.apple.mpegurl".into(),
            request_contexts: vec![],
        },
    }
}

#[tokio::test]
async fn confirmed_selection_starts_the_probed_gid_once_and_persists_receipt() {
    let fixture = Fixture::new().await;
    let request = request();
    let presentation = fixture.ready(request.clone()).await;
    assert_eq!(presentation.defaults.format, Format::Mkv);
    let options = fixture.engine.last_options.lock().await.clone();
    assert_eq!(options["media-pause-after-probe"], "true");
    assert!(options.get("dry-run").is_none());
    assert_eq!(options["media-request-contexts"], "[]");
    assert_eq!(
        fixture.service.capabilities().await.expect("capabilities")["sourceKinds"],
        json!(["hls", "dash"])
    );
    let submission = SubmitRequest {
        submission_id: Uuid::new_v4(),
        selection: presentation.defaults,
    };
    let first = fixture
        .service
        .submit(request.id, submission.clone())
        .await
        .expect("submit");
    let second = fixture
        .service
        .submit(request.id, submission.clone())
        .await
        .expect("replay");
    assert_eq!(first, second);
    assert_eq!(first["gid"], options["gid"]);
    assert_eq!(fixture.engine.additions.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.engine.starts.load(Ordering::Relaxed), 1);
    let stored = fixture
        .service
        .journal
        .load()
        .await
        .expect("durable receipt");
    assert_eq!(stored[0].state, State::Submitted);
    assert!(!serde_json::to_string(&stored)
        .expect("journal JSON")
        .contains("token=opaque"));
    assert!(
        !fixture
            .service
            .engine
            .tasks
            .is_internal(first["gid"].as_str().expect("GID"))
            .await
    );
    let cancelled = fixture
        .service
        .cancel(request.id)
        .await
        .expect("cancel submitted");
    assert_eq!(cancelled["state"], "submitted");
    fixture.service.maintain().await.expect("maintenance");
    assert_eq!(fixture.engine.tasks.lock().await.len(), 1);
    let mut conflict = submission;
    conflict.selection.format = Format::Mp4;
    assert_eq!(
        fixture.service.submit(request.id, conflict).await,
        Err(Error::Conflict)
    );
}

#[tokio::test]
async fn lost_start_reply_reconciles_without_restarting_or_creating_a_download() {
    let fixture = Fixture::new().await;
    let request = request();
    let presentation = fixture.ready(request.clone()).await;
    fixture
        .engine
        .lose_start_reply
        .store(true, Ordering::Relaxed);
    let submission = SubmitRequest {
        submission_id: Uuid::new_v4(),
        selection: presentation.defaults,
    };
    assert_eq!(
        fixture.service.submit(request.id, submission.clone()).await,
        Err(Error::Unavailable)
    );
    assert_eq!(
        fixture.service.journal.load().await.expect("intent")[0].state,
        State::Starting
    );
    fixture.service.maintain().await.expect("reconcile");
    let receipt = fixture
        .service
        .submit(request.id, submission)
        .await
        .expect("recovered receipt");
    assert_eq!(
        fixture.service.read(request.id).await.expect("read")["gid"],
        receipt["gid"]
    );
    assert_eq!(fixture.engine.additions.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.engine.starts.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn cancellation_tombstone_prevents_late_creation_and_expiry_removes_only_probes() {
    let fixture = Fixture::new().await;
    let cancelled = request();
    fixture
        .service
        .cancel(cancelled.id)
        .await
        .expect("early cancellation");
    assert_eq!(
        fixture
            .service
            .create(cancelled, Format::Mp4)
            .await
            .expect("late create")["state"],
        "cancelled"
    );
    assert_eq!(fixture.engine.additions.load(Ordering::Relaxed), 0);
    let active = request();
    fixture.ready(active.clone()).await;
    fixture
        .service
        .operations
        .lock()
        .await
        .get_mut(&active.id)
        .expect("probe")
        .expires_at = now() - 1;
    fixture.service.maintain().await.expect("expire");
    fixture.service.maintain().await.expect("clean");
    assert!(fixture.engine.tasks.lock().await.is_empty());
}

#[tokio::test]
async fn malformed_request_contexts_never_reach_the_engine() {
    let fixture = Fixture::new().await;
    let mut authenticated = request();
    authenticated.source.request_contexts.push(RequestContext {
        url: authenticated.source.url.clone(),
        headers: vec![RequestHeader {
            name: "Host".into(),
            value: "Bearer secret".into(),
        }],
    });
    assert_eq!(
        fixture.service.create(authenticated, Format::Mp4).await,
        Err(Error::UnsupportedSource)
    );
    assert_eq!(fixture.engine.additions.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn restart_preserves_submissions_and_invalidates_orphan_inspections() {
    let fixture = Fixture::new().await;
    let pending = request();
    fixture.ready(pending.clone()).await;
    let confirmed = request();
    let presentation = fixture.ready(confirmed.clone()).await;
    let submission = SubmitRequest {
        submission_id: Uuid::new_v4(),
        selection: presentation.defaults,
    };
    let receipt = fixture
        .service
        .submit(confirmed.id, submission.clone())
        .await
        .expect("confirmed download");
    let restored = Arc::new(
        MediaService::restore(
            fixture.service.engine.clone(),
            fixture.service.journal.clone(),
        )
        .await
        .expect("restore"),
    );
    assert_eq!(
        restored.read(pending.id).await.expect("orphan")["error"],
        "source_expired"
    );
    assert_eq!(
        restored
            .submit(confirmed.id, submission)
            .await
            .expect("receipt"),
        receipt
    );
    restored.maintain().await.expect("orphan cleanup");
    assert_eq!(fixture.engine.tasks.lock().await.len(), 1);
    assert_eq!(fixture.engine.starts.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn restart_finishes_a_persisted_submission_intent_on_its_original_gid() {
    let fixture = Fixture::new().await;
    let request = request();
    let presentation = fixture.ready(request.clone()).await;
    let submission = SubmitRequest {
        submission_id: Uuid::new_v4(),
        selection: presentation.defaults,
    };
    let mut intent = fixture
        .service
        .operations
        .lock()
        .await
        .get(&request.id)
        .expect("probe")
        .clone();
    intent.state = State::Starting;
    intent.selection = Some(submission.selection.clone());
    intent.submission_id = Some(submission.submission_id);
    fixture
        .service
        .journal
        .save(&intent)
        .await
        .expect("durable intent");
    let restored = Arc::new(
        MediaService::restore(
            fixture.service.engine.clone(),
            fixture.service.journal.clone(),
        )
        .await
        .expect("restore"),
    );
    restored.maintain().await.expect("reconcile intent");
    let receipt = restored
        .submit(request.id, submission)
        .await
        .expect("receipt");
    assert_eq!(receipt["gid"], intent.gid);
    assert_eq!(fixture.engine.additions.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.engine.starts.load(Ordering::Relaxed), 1);
}

#[test]
fn selection_validates_track_identity_muxed_sources_and_live_duration() {
    let mut presentation = Presentation {
        kind: SourceKind::Hls,
        title: "Video".into(),
        live: false,
        duration_ms: None,
        size: None,
        formats: vec![Format::Mp4],
        tracks: vec![Track {
            id: "muxed".into(),
            r#type: "muxed".into(),
            language: String::new(),
            codec: String::new(),
            width: 0,
            height: 0,
            bandwidth: 0,
            frame_rate: 0.0,
        }],
        defaults: Selection {
            video_id: Some("muxed".into()),
            audio_id: Some("muxed".into()),
            subtitle_id: None,
            format: Format::Mp4,
            record_time_seconds: 0,
        },
    };
    assert!(presentation
        .validate_selection(&presentation.defaults)
        .is_ok());
    presentation.defaults.audio_id = Some("unknown".into());
    assert!(presentation
        .validate_selection(&presentation.defaults)
        .is_err());
    presentation.defaults.audio_id = None;
    presentation.defaults.record_time_seconds = 60;
    assert!(presentation
        .validate_selection(&presentation.defaults)
        .is_err());
    presentation.live = true;
    assert!(presentation
        .validate_selection(&presentation.defaults)
        .is_ok());
}
