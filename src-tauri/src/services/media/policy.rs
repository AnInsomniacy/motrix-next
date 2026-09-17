//! Apply creation preferences to new tasks; restored tasks never auto-resume.
use crate::{aria2::types::Aria2Task, services::tasks::TaskService};
use std::{sync::Arc, time::Duration};
use tauri::Emitter;

fn should_continue(task: &Aria2Task) -> bool {
    task.status == "paused"
        && task
            .media
            .as_ref()
            .is_some_and(|media| media.state == "awaiting-selection" && media.live == "false")
}

pub fn start_automatic_selection(app: tauri::AppHandle, engine: Arc<TaskService>) {
    if !engine.tasks.begin_automatic_worker() {
        return;
    }
    tokio::spawn(async move {
        let mut missing_since = std::collections::HashMap::new();
        loop {
            let ids = engine.tasks.automatic_ids().await;
            if ids.is_empty() {
                engine.tasks.end_automatic_worker();
                // Hand off without losing a task added while the worker was exiting.
                if engine.tasks.automatic_ids().await.is_empty()
                    || !engine.tasks.begin_automatic_worker()
                {
                    return;
                }
                continue;
            }
            let generation = engine.generation();
            let tasks = match engine.tell_task_snapshot(true).await {
                Ok(tasks) => tasks,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            if engine.generation() != generation {
                continue;
            }
            let seen: std::collections::HashSet<_> =
                tasks.iter().map(|task| task.gid.clone()).collect();
            let mut changed = None;
            for task in tasks.iter().filter(|task| ids.contains(&task.gid)) {
                if !engine.tasks.is_automatic(&task.gid).await {
                    continue;
                }
                if should_continue(task) {
                    if engine.generation() == generation
                        && engine.tasks.is_automatic(&task.gid).await
                    {
                        if let Err(error) = super::native::start(
                            &engine,
                            task,
                            serde_json::json!({}),
                            super::native::StartMode::Automatic,
                        )
                        .await
                        {
                            log::debug!("media: automatic selection failed: {error}");
                        }
                    }
                } else if !matches!(
                    task.status.as_str(),
                    "paused" | "complete" | "error" | "removed"
                ) && !(task.media.is_none()
                    && task.completed_length.parse::<u64>().unwrap_or(0) > 0)
                {
                    continue;
                }
                engine.tasks.set_automatic(&task.gid, false).await;
                changed.get_or_insert_with(|| task.gid.clone());
            }
            missing_since.retain(|gid, _| ids.contains(gid) && !seen.contains(gid));
            for gid in ids.difference(&seen) {
                let since = missing_since
                    .entry(gid.clone())
                    .or_insert_with(tokio::time::Instant::now);
                if since.elapsed() >= Duration::from_secs(30) {
                    engine.tasks.set_automatic(gid, false).await;
                }
            }
            if let Some(gid) = changed {
                let _ = app.emit(
                    super::super::aria2_events::DOWNLOAD_PAUSE,
                    super::super::aria2_events::DownloadPauseEvent { gid },
                );
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aria2::types::Aria2Media;
    #[test]
    fn only_new_finite_presentations_can_auto_continue() {
        let mut task = Aria2Task {
            status: "paused".into(),
            media: Some(Aria2Media {
                state: "awaiting-selection".into(),
                live: "false".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(should_continue(&task));
        task.media.as_mut().expect("media fixture").live = "true".into();
        assert!(!should_continue(&task));
        task.media.as_mut().expect("media fixture").live = "false".into();
        task.media.as_mut().expect("media fixture").state = "paused".into();
        assert!(!should_continue(&task));
    }
}
