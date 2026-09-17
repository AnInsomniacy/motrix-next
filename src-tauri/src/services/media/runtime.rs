//! Tauri lifecycle wiring and publication of confirmed download events.
use super::journal::State;
use super::{error::Error, journal::Journal, MediaService};
use crate::services::tasks::TaskServiceState;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

pub struct MediaState(pub OnceCell<Arc<MediaService>>);
impl MediaState {
    pub fn new() -> Self {
        Self(OnceCell::new())
    }
}

pub async fn service(app: &AppHandle) -> Result<Arc<MediaService>, Error> {
    let state = app.state::<MediaState>();
    let result = state
        .0
        .get_or_try_init(|| async {
            let directory = app
                .path()
                .app_local_data_dir()
                .map_err(|_| Error::Unavailable)?;
            tokio::fs::create_dir_all(&directory)
                .await
                .map_err(|_| Error::Unavailable)?;
            let journal = Journal::open(directory.join("media-operations.db")).await?;
            let service = Arc::new(
                MediaService::restore(app.state::<TaskServiceState>().0.clone(), journal).await?,
            );
            let weak = Arc::downgrade(&service);
            let app = app.clone();
            tokio::spawn(async move {
                loop {
                    let Some(worker) = weak.upgrade() else { break };
                    if let Err(code) = worker.maintain().await {
                        log::warn!("media: operation reconciliation failed code={code}");
                    }
                    worker.flush_events(&app).await;
                    drop(worker);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            });
            Ok::<Arc<MediaService>, Error>(service)
        })
        .await?;
    Ok(result.clone())
}

pub async fn owns(app: &AppHandle, gid: &str) -> bool {
    match app.try_state::<TaskServiceState>() {
        Some(state) => state.0.tasks.is_internal(gid).await,
        None => false,
    }
}

impl MediaService {
    pub async fn defer_event(&self, event: &'static str, task: crate::aria2::types::Aria2Task) {
        self.deferred_events
            .lock()
            .await
            .insert(task.gid.clone(), (event, task));
    }
    async fn flush_events(&self, app: &AppHandle) {
        let submitted: std::collections::HashSet<_> = self
            .operations
            .lock()
            .await
            .values()
            .filter(|op| op.state == State::Submitted)
            .map(|op| op.gid.clone())
            .collect();
        let mut pending = self.deferred_events.lock().await;
        let events: Vec<_> = submitted
            .iter()
            .filter_map(|gid| pending.remove(gid))
            .collect();
        drop(pending);
        for (event, task) in events {
            if let Err(_error) =
                super::super::monitor::process_lifecycle_task(app, event, &task, true).await
            {
                log::warn!(
                    "media: deferred lifecycle event failed code={}",
                    Error::Unavailable
                );
            }
        }
    }
}
