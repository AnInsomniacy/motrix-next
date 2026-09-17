//! Admission and visibility of browser probes and automatically selected tasks.
use crate::aria2::types::Aria2Task;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::RwLock;

#[derive(Default)]
pub struct TaskPolicy {
    internal: RwLock<HashSet<String>>,
    automatic: RwLock<HashSet<String>>,
    worker: AtomicBool,
}
impl TaskPolicy {
    pub async fn has_internal(&self) -> bool {
        !self.internal.read().await.is_empty()
    }
    pub async fn internal_ids(&self) -> HashSet<String> {
        self.internal.read().await.clone()
    }
    pub async fn clear_automatic(&self) {
        self.automatic.write().await.clear();
    }
    pub fn begin_automatic_worker(&self) -> bool {
        !self.worker.swap(true, Ordering::AcqRel)
    }
    pub fn end_automatic_worker(&self) {
        self.worker.store(false, Ordering::Release);
    }
    pub async fn automatic_ids(&self) -> std::collections::HashSet<String> {
        self.automatic.read().await.clone()
    }
    pub async fn set_automatic(&self, gid: &str, enabled: bool) {
        let mut gids = self.automatic.write().await;
        if enabled {
            gids.insert(gid.into());
        } else {
            gids.remove(gid);
        }
    }
    pub async fn is_automatic(&self, gid: &str) -> bool {
        self.automatic.read().await.contains(gid)
    }
    pub async fn set_internal(&self, gid: &str, internal: bool) {
        let mut gids = self.internal.write().await;
        if internal {
            gids.insert(gid.to_string());
        } else {
            gids.remove(gid);
        }
    }
    pub async fn is_internal(&self, gid: &str) -> bool {
        self.internal.read().await.contains(gid)
    }
    pub async fn visible_tasks(&self, mut tasks: Vec<Aria2Task>) -> Vec<Aria2Task> {
        let gids = self.internal.read().await;
        tasks.retain(|task| !gids.contains(&task.gid));
        let automatic = self.automatic.read().await;
        for task in &mut tasks {
            task.selection_managed = automatic.contains(&task.gid);
        }
        tasks
    }
}
