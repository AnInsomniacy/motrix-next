//! Native selection and queue transitions shared by every desktop entry point.
use crate::{aria2::types::Aria2Task, error::AppError, services::tasks::TaskService};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StartMode {
    User,
    Browser,
    Automatic,
}

pub async fn start(
    engine: &TaskService,
    task: &Aria2Task,
    mut options: Value,
    mode: StartMode,
) -> Result<String, AppError> {
    let generation = engine.generation();
    if !options.is_object() {
        return Err(AppError::Aria2("Media options must be an object".into()));
    }
    let media = task
        .media
        .as_ref()
        .ok_or_else(|| AppError::Aria2("The task is not a media presentation".into()))?;
    if media.state == "awaiting-selection" && task.status != "paused" {
        return Err(AppError::Aria2("Media inspection is still pausing".into()));
    }
    options["media-pause-after-probe"] = "false".into();
    if task.status == "error" && mode == StartMode::User {
        engine.retry_media(&task.gid, options).await?;
    } else if task.status == "paused"
        && matches!(media.state.as_str(), "awaiting-selection" | "paused")
    {
        engine.change_option(&task.gid, options).await?;
        if engine.generation() != generation
            || (mode == StartMode::Automatic && !engine.tasks.is_automatic(&task.gid).await)
        {
            return Err(AppError::Aria2("Media selection was interrupted".into()));
        }
        engine.unpause(&task.gid).await?;
    } else if !matches!(task.status.as_str(), "active" | "waiting" | "complete") {
        return Err(AppError::Aria2(format!(
            "Media task cannot start from {} / {}",
            task.status, media.state
        )));
    }
    // Reconciliation may observe an already-started or completed task.
    engine.save_session().await?;
    Ok(task.gid.clone())
}
