use crate::commands::bt_blocklist;
use crate::services::tasks::TaskService;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub struct BtPeerBlocklistHandle {
    stop_tx: watch::Sender<bool>,
}

impl BtPeerBlocklistHandle {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

pub struct BtPeerBlocklistServiceState(pub Arc<tokio::sync::Mutex<Option<BtPeerBlocklistHandle>>>);

impl BtPeerBlocklistServiceState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

pub fn spawn_bt_peer_blocklist_service(
    app: tauri::AppHandle,
    aria2: Arc<TaskService>,
) -> BtPeerBlocklistHandle {
    let (stop_tx, mut stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        if let Err(error) = bt_blocklist::reconcile(&app, &aria2, false).await {
            log::warn!("bt_blocklist: startup reconcile failed: {error}");
        }

        loop {
            tokio::select! {
                _ = tokio::time::sleep(CHECK_INTERVAL) => {},
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        log::info!("bt_blocklist: service stopped");
                        return;
                    }
                }
            }

            if let Err(error) = bt_blocklist::reconcile(&app, &aria2, false).await {
                log::warn!("bt_blocklist: scheduled update failed: {error}");
            }
        }
    });

    BtPeerBlocklistHandle { stop_tx }
}
