//! Native task creation shared by browser handoffs and the desktop dialog.
use crate::{error::AppError, services::tasks::TaskService};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
pub(super) async fn prepare(
    app: &AppHandle,
    engine: &TaskService,
    uris: &[String],
    options: &mut serde_json::Value,
) -> Result<Option<String>, AppError> {
    if options
        .get("out")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|name| name.contains('\0'))
    {
        return Err(AppError::Aria2("Output names cannot contain NUL".into()));
    }
    if uris.iter().any(|uri| {
        uri.trim_start()
            .to_ascii_lowercase()
            .starts_with("ed2k://|file|")
    }) {
        crate::commands::ed2k::inject_managed_ed2k_bootstrap_options(app, options)?;
    }
    let database = app.state::<crate::database::DatabaseState>();
    apply_saved_credentials(&database.0, uris, options).await?;
    let mut automatic = false;
    if uris
        .iter()
        .all(|uri| uri.starts_with("http://") || uri.starts_with("https://"))
    {
        if let Some(options) = options.as_object_mut() {
            let config = app
                .state::<crate::services::config::RuntimeConfigState>()
                .snapshot()
                .await;
            automatic = options.get("media").and_then(serde_json::Value::as_str) != Some("file")
                && !options.contains_key("media-pause-after-probe")
                && !config.media_select_before_download;
            options
                .entry("media-pause-after-probe")
                .or_insert_with(|| "true".into());
            options
                .entry("media-format")
                .or_insert_with(|| config.media_default_format.into());
            if automatic {
                options.entry("gid").or_insert_with(|| {
                    uuid::Uuid::new_v4().simple().to_string()[..16]
                        .to_string()
                        .into()
                });
            }
        }
    }
    let automatic_gid = if automatic {
        options["gid"].as_str().map(str::to_owned)
    } else {
        None
    };
    if let Some(gid) = &automatic_gid {
        engine.tasks.set_automatic(gid, true).await;
    }
    Ok(automatic_gid)
}

pub(super) async fn finish(
    app: AppHandle,
    engine: Arc<TaskService>,
    automatic_gid: Option<String>,
    generation: u64,
) {
    if let Some(gid) = automatic_gid {
        if generation == engine.generation() {
            crate::services::media::start_automatic_selection(app, engine.clone());
        } else {
            engine.tasks.set_automatic(&gid, false).await;
        }
    }
}

pub(super) async fn apply_saved_credentials(
    database: &crate::database::Database,
    uris: &[String],
    options: &mut serde_json::Value,
) -> Result<(), AppError> {
    if options.get("http-user").is_some() || !database.is_ready().await {
        return Ok(());
    }
    let Some(first) = uris.first().and_then(|uri| url::Url::parse(uri).ok()) else {
        return Ok(());
    };
    if !matches!(first.scheme(), "http" | "https")
        || !uris
            .iter()
            .all(|uri| url::Url::parse(uri).is_ok_and(|url| url.origin() == first.origin()))
    {
        return Ok(());
    }
    if let Some(credential) = database.credential_for_url(first.as_str()).await? {
        options["http-user"] = credential.username.into();
        options["http-passwd"] = credential.password.into();
        database.mark_credential_used(credential.id).await?;
    }
    Ok(())
}
