use super::*;
use crate::{aria2::types::Aria2Task, database::Database, services::tasks::TaskService};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct Engine {
    tasks: Mutex<Vec<Aria2Task>>,
    additions: AtomicUsize,
}
async fn rpc(
    State(engine): State<Arc<Engine>>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let result = match request["method"].as_str().unwrap() {
        "system.multicall" => json!([[*engine.tasks.lock().await], [[]], [[]]]),
        "aria2.addUri" | "aria2.addTorrent" => {
            let gid = request["params"].as_array().unwrap().last().unwrap()["gid"]
                .as_str()
                .unwrap();
            engine.tasks.lock().await.push(Aria2Task {
                gid: gid.into(),
                status: "active".into(),
                ..Default::default()
            });
            engine.additions.fetch_add(1, Ordering::Relaxed);
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error":"lost creation reply"})),
            );
        }
        "aria2.saveSession" => json!("OK"),
        method => panic!("Unexpected native method: {method}"),
    };
    (
        StatusCode::OK,
        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})),
    )
}

#[tokio::test]
async fn lost_creation_replies_reconcile_the_original_gid_for_uri_and_torrent_inputs() {
    let state = Arc::new(Engine::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let engine = TaskService::new(listener.local_addr().unwrap().port(), String::new());
    let router = Router::new()
        .route("/jsonrpc", post(rpc))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let db = Database::open_in_memory().unwrap();
    for torrent in [false, true] {
        let id = if torrent { "torrent" } else { "uri" };
        let source = || {
            if torrent {
                TaskInput::Torrent("native-metainfo".into())
            } else {
                TaskInput::Uris(vec!["https://example.test/file".into()])
            }
        };
        let expected = db.reserve_submission(id, "input").await.unwrap().gid;
        db.stage_confirmation(id, "request body").await.unwrap();
        assert!(submit_reserved(&engine, &db, id, source(), json!({}))
            .await
            .is_err());
        assert_eq!(
            submit_reserved(&engine, &db, id, source(), json!({}))
                .await
                .unwrap(),
            expected
        );
        assert_eq!(
            submit_reserved(&engine, &db, id, source(), json!({}))
                .await
                .unwrap(),
            expected
        );
    }
    assert_eq!(state.additions.load(Ordering::Relaxed), 2);
    assert!(db.pending_downloads().await.unwrap().is_empty());
    db.reserve_submission("cancelled", "input").await.unwrap();
    db.cancel_submission("cancelled").await.unwrap();
    assert!(matches!(
        submit_reserved(
            &engine,
            &db,
            "cancelled",
            TaskInput::Uris(vec![]),
            json!({})
        )
        .await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(state.additions.load(Ordering::Relaxed), 2);
    server.abort();
}

#[tokio::test]
async fn saved_credentials_apply_only_to_one_origin_and_preserve_explicit_auth() {
    let db = Database::open_in_memory().unwrap();
    db.save_credential("https://example.test", "saved", "literal%20")
        .await
        .unwrap();
    let mut options = json!({});
    native::apply_saved_credentials(&db, &["https://example.test/file".into()], &mut options)
        .await
        .unwrap();
    assert_eq!(options["http-passwd"], "literal%20");
    let mut explicit = json!({"http-user":"manual"});
    native::apply_saved_credentials(&db, &["https://example.test/file".into()], &mut explicit)
        .await
        .unwrap();
    assert_eq!(explicit, json!({"http-user":"manual"}));
    let mut mirrors = json!({});
    native::apply_saved_credentials(
        &db,
        &[
            "https://example.test/file".into(),
            "https://other.test/file".into(),
        ],
        &mut mirrors,
    )
    .await
    .unwrap();
    assert_eq!(mirrors, json!({}));
}
