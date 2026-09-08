use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::aria2::client::Aria2State;
use crate::aria2::types::Aria2Task;
use crate::error::AppError;
use crate::history::HistoryDbState;
use crate::services::{self, port_guard};

use super::{
    start_engine, stop_engine, wait_for_engine_exit, wait_for_engine_ports_release, EngineState,
};

const START_ATTEMPTS: u32 = 5;
const PROBE_ATTEMPTS: u32 = 5;
const PROBE_BASE_DELAY_MS: u64 = 200;
const RECOVERY_BASE_DELAY_MS: u64 = 500;
const STABILITY_CHECKS: u32 = 3;
const STABILITY_CHECK_INTERVAL_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EnginePhase {
    Stopped,
    Preparing,
    Starting,
    Probing,
    Initializing,
    Stabilizing,
    Running,
    Recovering,
    Stopping,
    Cleaning,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesiredEngineState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineOperationCause {
    Initial,
    Startup,
    ManualRestart,
    SettingsChange,
    FailureRetry,
    SessionRecovery,
    RuntimeCrash,
    RpcUnhealthy,
    PortConflict,
    UpdateInstall,
    UpdateInstallFailed,
    AppRelaunch,
    AppExit,
    UserCancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineFailureStage {
    Spawn,
    Probe,
    Contract,
    Initialization,
    Stability,
    Runtime,
    Shutdown,
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFailure {
    pub stage: EngineFailureStage,
    pub message: String,
    pub retryable: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr_tail: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    pub phase: EnginePhase,
    pub desired: DesiredEngineState,
    pub revision: u64,
    pub operation_id: u64,
    pub attempt: u32,
    pub max_attempts: u32,
    pub cause: EngineOperationCause,
    pub failure: Option<EngineFailure>,
}

impl Default for EngineSnapshot {
    fn default() -> Self {
        Self {
            phase: EnginePhase::Stopped,
            desired: DesiredEngineState::Stopped,
            revision: 0,
            operation_id: 0,
            attempt: 0,
            max_attempts: START_ATTEMPTS,
            cause: EngineOperationCause::Initial,
            failure: None,
        }
    }
}

pub struct EngineSupervisor {
    snapshot: RwLock<EngineSnapshot>,
    operation_lock: AsyncMutex<()>,
    active_cancel: Mutex<Option<(u64, watch::Sender<bool>)>>,
    revision: AtomicU64,
    operation_id: AtomicU64,
    desired: AtomicU8,
}

impl EngineSupervisor {
    pub fn new() -> Self {
        Self {
            snapshot: RwLock::new(EngineSnapshot::default()),
            operation_lock: AsyncMutex::new(()),
            active_cancel: Mutex::new(None),
            revision: AtomicU64::new(0),
            operation_id: AtomicU64::new(0),
            desired: AtomicU8::new(0),
        }
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        self.snapshot
            .read()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn is_running(&self) -> bool {
        self.snapshot().phase == EnginePhase::Running
    }

    pub(crate) fn is_process_exit_expected(&self) -> bool {
        let snapshot = self.snapshot();
        self.desired_state() == DesiredEngineState::Stopped
            || snapshot.phase != EnginePhase::Running
    }

    pub(crate) fn allows_process_spawn(&self) -> bool {
        self.desired_state() == DesiredEngineState::Running
    }

    fn desired_state(&self) -> DesiredEngineState {
        if self.desired.load(Ordering::SeqCst) == 1 {
            DesiredEngineState::Running
        } else {
            DesiredEngineState::Stopped
        }
    }

    fn begin_operation(&self, desired: DesiredEngineState) -> (u64, watch::Receiver<bool>) {
        if let Ok(mut active) = self.active_cancel.lock() {
            if let Some((_, sender)) = active.take() {
                let _ = sender.send(true);
            }
        }
        self.desired.store(
            if desired == DesiredEngineState::Running {
                1
            } else {
                0
            },
            Ordering::SeqCst,
        );
        let operation_id = self.operation_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = watch::channel(false);
        if let Ok(mut active) = self.active_cancel.lock() {
            *active = Some((operation_id, sender));
        }
        (operation_id, receiver)
    }

    fn is_current(&self, operation_id: u64) -> bool {
        self.operation_id.load(Ordering::SeqCst) == operation_id
    }

    fn finish_operation(&self, operation_id: u64) {
        if let Ok(mut active) = self.active_cancel.lock() {
            if active.as_ref().is_some_and(|(id, _)| *id == operation_id) {
                *active = None;
            }
        }
    }

    fn publish(
        &self,
        app: &AppHandle,
        operation_id: u64,
        phase: EnginePhase,
        attempt: u32,
        cause: EngineOperationCause,
        failure: Option<EngineFailure>,
    ) {
        if !self.is_current(operation_id) {
            return;
        }
        let snapshot = EngineSnapshot {
            phase,
            desired: self.desired_state(),
            revision: self.revision.fetch_add(1, Ordering::SeqCst) + 1,
            operation_id,
            attempt,
            max_attempts: START_ATTEMPTS,
            cause,
            failure,
        };
        if let Ok(mut state) = self.snapshot.write() {
            *state = snapshot.clone();
        }
        let _ = app.emit("engine-state-changed", &snapshot);
        log::info!(
            target: "engine_supervisor",
            event = "engine_state_changed",
            operation_id,
            phase:? = phase,
            attempt,
            cause:? = cause;
            "engine_state_changed"
        );
    }

    pub async fn ensure_running(
        &self,
        app: &AppHandle,
        cause: EngineOperationCause,
    ) -> Result<EngineSnapshot, AppError> {
        if self.is_running()
            && app
                .try_state::<EngineState>()
                .is_some_and(|state| state.is_running())
        {
            return Ok(self.snapshot());
        }
        self.run_running_operation(app, cause, false, None).await
    }

    pub async fn restart(
        &self,
        app: &AppHandle,
        cause: EngineOperationCause,
    ) -> Result<EngineSnapshot, AppError> {
        self.run_running_operation(app, cause, true, None).await
    }

    pub async fn recover_runtime_state(&self, app: &AppHandle) -> Result<EngineSnapshot, AppError> {
        let cause = EngineOperationCause::SessionRecovery;
        let (operation_id, mut cancelled) = self.begin_operation(DesiredEngineState::Running);
        let _guard = self.operation_lock.lock().await;
        ensure_active(self, operation_id, &cancelled)?;

        self.publish(app, operation_id, EnginePhase::Stopping, 0, cause, None);
        if let Err(error) = self.stop_runtime(app, false, None).await {
            let failure = failure_from_error(EngineFailureStage::Shutdown, &error, false, app);
            let result = self.fail(app, operation_id, 0, cause, failure);
            self.finish_operation(operation_id);
            return result;
        }

        ensure_active(self, operation_id, &cancelled)?;
        self.publish(app, operation_id, EnginePhase::Cleaning, 0, cause, None);
        if let Err(message) = crate::engine::clear_engine_runtime_state(app) {
            let failure = failure_from_message(EngineFailureStage::Recovery, message, false, app);
            let result = self.fail(app, operation_id, 0, cause, failure);
            self.finish_operation(operation_id);
            return result;
        }

        let result = self
            .start_with_recovery(app, operation_id, cause, &mut cancelled, None)
            .await;
        self.finish_operation(operation_id);
        result
    }

    async fn run_running_operation(
        &self,
        app: &AppHandle,
        cause: EngineOperationCause,
        force_restart: bool,
        initial_failure: Option<EngineFailure>,
    ) -> Result<EngineSnapshot, AppError> {
        let (operation_id, mut cancelled) = self.begin_operation(DesiredEngineState::Running);
        let _guard = self.operation_lock.lock().await;
        if !self.is_current(operation_id) {
            return Err(cancelled_error());
        }

        if force_restart {
            self.publish(app, operation_id, EnginePhase::Stopping, 0, cause, None);
            if let Err(error) = self.stop_runtime(app, false, None).await {
                let failure = failure_from_error(EngineFailureStage::Shutdown, &error, false, app);
                let result = self.fail(app, operation_id, 0, cause, failure);
                self.finish_operation(operation_id);
                return result;
            }
        }

        let result = self
            .start_with_recovery(app, operation_id, cause, &mut cancelled, initial_failure)
            .await;
        self.finish_operation(operation_id);
        result
    }

    async fn start_with_recovery(
        &self,
        app: &AppHandle,
        operation_id: u64,
        cause: EngineOperationCause,
        cancelled: &mut watch::Receiver<bool>,
        mut last_failure: Option<EngineFailure>,
    ) -> Result<EngineSnapshot, AppError> {
        for attempt in 1..=START_ATTEMPTS {
            ensure_active(self, operation_id, cancelled)?;

            if attempt > 1 {
                self.publish(
                    app,
                    operation_id,
                    EnginePhase::Recovering,
                    attempt,
                    cause,
                    last_failure.clone(),
                );
                cancellable_delay(
                    cancelled,
                    Duration::from_millis(RECOVERY_BASE_DELAY_MS * 2u64.pow(attempt - 2)),
                )
                .await?;
            }

            self.publish(
                app,
                operation_id,
                EnginePhase::Preparing,
                attempt,
                cause,
                last_failure.clone(),
            );
            if let Err(error) = port_guard::reconcile_engine_ports(app) {
                log::warn!("engine_supervisor: port reconciliation failed: {error}");
            }

            if app
                .try_state::<EngineState>()
                .is_some_and(|state| state.is_running())
            {
                if let Err(error) = self.stop_runtime(app, false, None).await {
                    let failure =
                        failure_from_error(EngineFailureStage::Shutdown, &error, false, app);
                    return self.fail(app, operation_id, attempt, cause, failure);
                }
            }

            self.publish(
                app,
                operation_id,
                EnginePhase::Starting,
                attempt,
                cause,
                last_failure.clone(),
            );
            let app_for_start = app.clone();
            let start_result =
                match tokio::task::spawn_blocking(move || start_engine(&app_for_start)).await {
                    Ok(result) => result,
                    Err(error) => {
                        let failure = failure_from_message(
                            EngineFailureStage::Spawn,
                            error.to_string(),
                            false,
                            app,
                        );
                        return self.fail(app, operation_id, attempt, cause, failure);
                    }
                };
            match start_result {
                Ok(super::StartEngineOutcome::Started) => {}
                Ok(super::StartEngineOutcome::Cancelled) => return Err(cancelled_error()),
                Err(message) => {
                    let failure =
                        failure_from_message(EngineFailureStage::Spawn, message, false, app);
                    return self.fail(app, operation_id, attempt, cause, failure);
                }
            }

            self.publish(
                app,
                operation_id,
                EnginePhase::Probing,
                attempt,
                cause,
                last_failure.clone(),
            );
            match probe_engine(app, cancelled).await {
                Ok(()) => {}
                Err(error) if is_cancelled_error(&error) => return Err(error),
                Err(error) => {
                    last_failure = Some(failure_from_error(
                        EngineFailureStage::Probe,
                        &error,
                        true,
                        app,
                    ));
                    if let Err(stop_error) = self.stop_runtime(app, false, None).await {
                        let failure = failure_from_error(
                            EngineFailureStage::Shutdown,
                            &stop_error,
                            false,
                            app,
                        );
                        return self.fail(app, operation_id, attempt, cause, failure);
                    }
                    if attempt < START_ATTEMPTS {
                        continue;
                    }
                    return self.fail(
                        app,
                        operation_id,
                        attempt,
                        cause,
                        last_failure.expect("probe failure must exist"),
                    );
                }
            }

            self.publish(
                app,
                operation_id,
                EnginePhase::Initializing,
                attempt,
                cause,
                None,
            );
            let initialization = tokio::select! {
                biased;
                changed = cancelled.changed() => {
                    let _ = changed;
                    Err(cancelled_error())
                }
                result = services::on_engine_ready(app) => result,
            };
            if let Err(error) = initialization {
                if is_cancelled_error(&error) {
                    return Err(error);
                }
                let stage = if matches!(error, AppError::Engine(_)) {
                    EngineFailureStage::Contract
                } else {
                    EngineFailureStage::Initialization
                };
                let failure = failure_from_error(stage, &error, false, app);
                if let Err(stop_error) = self.stop_runtime(app, false, None).await {
                    log::error!(
                        "engine_supervisor: cleanup after initialization failure failed: {stop_error}"
                    );
                }
                return self.fail(app, operation_id, attempt, cause, failure);
            }

            self.publish(
                app,
                operation_id,
                EnginePhase::Stabilizing,
                attempt,
                cause,
                None,
            );
            match confirm_engine_stability(app, cancelled).await {
                Ok(()) => {}
                Err(error) if is_cancelled_error(&error) => return Err(error),
                Err(error) => {
                    last_failure = Some(failure_from_error(
                        EngineFailureStage::Stability,
                        &error,
                        true,
                        app,
                    ));
                    if let Err(stop_error) = self.stop_runtime(app, false, None).await {
                        let failure = failure_from_error(
                            EngineFailureStage::Shutdown,
                            &stop_error,
                            false,
                            app,
                        );
                        return self.fail(app, operation_id, attempt, cause, failure);
                    }
                    if attempt < START_ATTEMPTS {
                        continue;
                    }
                    return self.fail(
                        app,
                        operation_id,
                        attempt,
                        cause,
                        last_failure.expect("stability failure must exist"),
                    );
                }
            }

            ensure_active(self, operation_id, cancelled)?;
            self.publish(
                app,
                operation_id,
                EnginePhase::Running,
                attempt,
                cause,
                None,
            );
            return Ok(self.snapshot());
        }

        Err(AppError::Engine("Engine recovery exhausted".into()))
    }

    fn fail(
        &self,
        app: &AppHandle,
        operation_id: u64,
        attempt: u32,
        cause: EngineOperationCause,
        failure: EngineFailure,
    ) -> Result<EngineSnapshot, AppError> {
        let message = failure.message.clone();
        self.publish(
            app,
            operation_id,
            EnginePhase::Failed,
            attempt,
            cause,
            Some(failure),
        );
        Err(AppError::Engine(message))
    }

    pub async fn stop(
        &self,
        app: &AppHandle,
        cause: EngineOperationCause,
        fast: bool,
    ) -> Result<EngineSnapshot, AppError> {
        self.stop_internal(app, cause, fast, None).await
    }

    pub async fn stop_for_app_exit(
        &self,
        app: &AppHandle,
        clear_completed: bool,
    ) -> Result<EngineSnapshot, AppError> {
        self.stop_internal(
            app,
            EngineOperationCause::AppExit,
            true,
            Some(clear_completed),
        )
        .await
    }

    async fn stop_internal(
        &self,
        app: &AppHandle,
        cause: EngineOperationCause,
        fast: bool,
        clear_completed_on_exit: Option<bool>,
    ) -> Result<EngineSnapshot, AppError> {
        let (operation_id, _cancelled) = self.begin_operation(DesiredEngineState::Stopped);
        let _guard = self.operation_lock.lock().await;
        if !self.is_current(operation_id) {
            return Err(cancelled_error());
        }
        self.publish(app, operation_id, EnginePhase::Stopping, 0, cause, None);
        let result = self.stop_runtime(app, fast, clear_completed_on_exit).await;
        match result {
            Ok(()) => {
                self.publish(app, operation_id, EnginePhase::Stopped, 0, cause, None);
                self.finish_operation(operation_id);
                Ok(self.snapshot())
            }
            Err(error) => {
                let failure = failure_from_error(EngineFailureStage::Shutdown, &error, false, app);
                self.publish(
                    app,
                    operation_id,
                    EnginePhase::Failed,
                    0,
                    cause,
                    Some(failure),
                );
                self.finish_operation(operation_id);
                Err(error)
            }
        }
    }

    async fn stop_runtime(
        &self,
        app: &AppHandle,
        fast: bool,
        clear_completed_on_exit: Option<bool>,
    ) -> Result<(), AppError> {
        let was_running = app
            .try_state::<EngineState>()
            .is_some_and(|state| state.is_running());
        services::stop_engine_services(app).await;
        if let Some(clear_completed) = clear_completed_on_exit {
            if let Err(error) = prepare_app_exit(app, was_running, clear_completed).await {
                log::warn!("engine_supervisor: app exit preparation failed: {error}");
            }
        }
        if !fast && was_running {
            request_graceful_shutdown(app).await;
        }
        let app_for_stop = app.clone();
        tokio::task::spawn_blocking(move || stop_engine(&app_for_stop, fast))
            .await
            .map_err(|error| AppError::Engine(error.to_string()))?
            .map_err(AppError::Engine)?;
        if !fast && was_running {
            let app_for_wait = app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let exited = wait_for_engine_exit(&app_for_wait, Duration::from_secs(2));
                wait_for_engine_ports_release(&app_for_wait);
                exited
            })
            .await;
        }
        Ok(())
    }

    async fn recover_after_exit(&self, app: &AppHandle, failure: EngineFailure) {
        if self.desired_state() != DesiredEngineState::Running {
            return;
        }
        let phase = self.snapshot().phase;
        if phase != EnginePhase::Running {
            return;
        }
        if let Err(error) = self
            .run_running_operation(
                app,
                EngineOperationCause::RuntimeCrash,
                false,
                Some(failure),
            )
            .await
        {
            if !is_cancelled_error(&error) {
                log::error!("engine_supervisor: crash recovery failed: {error}");
            }
        }
    }

    async fn recover_unhealthy_rpc(&self, app: &AppHandle, failure: EngineFailure) {
        if self.desired_state() != DesiredEngineState::Running
            || self.snapshot().phase != EnginePhase::Running
        {
            return;
        }
        if let Err(error) = self
            .run_running_operation(app, EngineOperationCause::RpcUnhealthy, true, Some(failure))
            .await
        {
            if !is_cancelled_error(&error) {
                log::error!("engine_supervisor: unhealthy RPC recovery failed: {error}");
            }
        }
    }

    async fn recover_port_conflict(
        &self,
        app: &AppHandle,
        generation: u32,
        kind: port_guard::PortKind,
    ) {
        if self.desired_state() != DesiredEngineState::Running
            || app
                .try_state::<EngineState>()
                .is_none_or(|state| !state.is_current_generation(generation))
            || self.snapshot().phase != EnginePhase::Running
        {
            return;
        }
        match port_guard::reconcile_runtime_ports(app, &[kind]) {
            Ok(switches) if !switches.is_empty() => {
                if let Err(error) = self.restart(app, EngineOperationCause::PortConflict).await {
                    if !is_cancelled_error(&error) {
                        log::error!("engine_supervisor: port recovery failed: {error}");
                    }
                }
            }
            Ok(_) => {
                log::warn!("engine_supervisor: port conflict produced no configuration change")
            }
            Err(error) => log::error!("engine_supervisor: port reconciliation failed: {error}"),
        }
    }
}

async fn prepare_app_exit(
    app: &AppHandle,
    engine_running: bool,
    clear_completed: bool,
) -> Result<(), AppError> {
    let mut removed = 0;
    if engine_running {
        let aria2 = app
            .try_state::<Aria2State>()
            .ok_or_else(|| AppError::Engine("Aria2State is not managed".into()))?;
        if clear_completed {
            let completed_gids = completed_result_gids(aria2.0.tell_all_stopped().await?);
            aria2.0.remove_download_results(&completed_gids).await?;
            removed = completed_gids.len();
        }
        aria2.0.save_session().await?;
    }

    if clear_completed {
        let history = app.try_state::<HistoryDbState>().ok_or_else(|| {
            AppError::Store("History database is unavailable during app exit".into())
        })?;
        if history.0.is_ready().await {
            history.0.clear_records(Some("complete")).await?;
        }
    }

    log::info!(
        "engine_supervisor: app exit prepared clear_completed={} removed_completed={}",
        clear_completed,
        removed
    );
    Ok(())
}

fn completed_result_gids(tasks: Vec<Aria2Task>) -> Vec<String> {
    tasks
        .into_iter()
        .filter(|task| task.status == "complete")
        .map(|task| task.gid)
        .collect()
}

async fn request_graceful_shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<Aria2State>() else {
        return;
    };
    let client = state.0.clone();
    let result = tokio::time::timeout(Duration::from_secs(2), async move {
        let _ = client.save_session().await;
        client.shutdown().await
    })
    .await;
    if !matches!(result, Ok(Ok(_))) {
        log::warn!("engine_supervisor: graceful shutdown timed out; using process fallback");
    }
}

async fn probe_engine(
    app: &AppHandle,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    let (port, secret) = services::read_engine_credentials_from_app(app)?;
    let aria2 = app
        .try_state::<Aria2State>()
        .ok_or_else(|| AppError::Engine("Aria2State is not managed".into()))?;
    aria2.0.update_credentials(port, secret).await;

    let mut last_error = None;
    for index in 0..PROBE_ATTEMPTS {
        ensure_not_cancelled(cancelled)?;
        match probe_engine_contract(&aria2.0).await {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if index + 1 < PROBE_ATTEMPTS {
            cancellable_delay(
                cancelled,
                Duration::from_millis(PROBE_BASE_DELAY_MS * 2u64.pow(index)),
            )
            .await?;
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::Engine("Engine probe failed".into())))
}

async fn probe_engine_contract(client: &crate::aria2::client::Aria2Client) -> Result<(), AppError> {
    const REQUIRED_METHODS: &[&str] = &[
        "aria2.addBtPeers",
        "aria2.ed2kSearch",
        "aria2.forceBtRecheck",
        "aria2.getBtSessionStatus",
        "aria2.getBtTrackers",
        "aria2.getEd2kSearchResults",
        "aria2.replaceBtTrackers",
        "aria2.replaceBtWebSeeds",
    ];

    let version = client.get_version().await?;
    if version.get("product").and_then(serde_json::Value::as_str) != Some("aria2-next") {
        return Err(AppError::Engine(
            "Unsupported download engine product".into(),
        ));
    }
    if version
        .get("rpcVersion")
        .and_then(serde_json::Value::as_str)
        != Some("1.1.0")
    {
        return Err(AppError::Engine(
            "Unsupported Aria2 Next RPC contract".into(),
        ));
    }

    let methods = client.list_methods().await?;
    let available = methods
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    if let Some(method) = REQUIRED_METHODS
        .iter()
        .find(|method| !available.contains(**method))
    {
        return Err(AppError::Engine(format!(
            "Aria2 Next RPC method is unavailable: {method}"
        )));
    }
    Ok(())
}

async fn confirm_engine_stability(
    app: &AppHandle,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    let engine = app
        .try_state::<EngineState>()
        .ok_or_else(|| AppError::Engine("EngineState is not managed".into()))?;
    let aria2 = app
        .try_state::<Aria2State>()
        .ok_or_else(|| AppError::Engine("Aria2State is not managed".into()))?;

    for index in 0..STABILITY_CHECKS {
        ensure_not_cancelled(cancelled)?;
        if !engine.is_running() {
            return Err(AppError::Engine(
                "Engine process exited during stability confirmation".into(),
            ));
        }
        aria2.0.get_version().await?;
        if index + 1 < STABILITY_CHECKS {
            cancellable_delay(
                cancelled,
                Duration::from_millis(STABILITY_CHECK_INTERVAL_MS),
            )
            .await?;
        }
    }
    Ok(())
}

fn ensure_active(
    supervisor: &EngineSupervisor,
    operation_id: u64,
    cancelled: &watch::Receiver<bool>,
) -> Result<(), AppError> {
    if !supervisor.is_current(operation_id) {
        return Err(cancelled_error());
    }
    ensure_not_cancelled(cancelled)
}

fn ensure_not_cancelled(cancelled: &watch::Receiver<bool>) -> Result<(), AppError> {
    if *cancelled.borrow() {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

async fn cancellable_delay(
    cancelled: &mut watch::Receiver<bool>,
    duration: Duration,
) -> Result<(), AppError> {
    tokio::select! {
        biased;
        changed = cancelled.changed() => {
            let _ = changed;
            Err(cancelled_error())
        }
        _ = tokio::time::sleep(duration) => Ok(()),
    }
}

fn cancelled_error() -> AppError {
    AppError::Engine("Engine operation cancelled".into())
}

fn is_cancelled_error(error: &AppError) -> bool {
    matches!(error, AppError::Engine(message) if message == "Engine operation cancelled")
}

fn failure_from_message(
    stage: EngineFailureStage,
    message: String,
    retryable: bool,
    app: &AppHandle,
) -> EngineFailure {
    EngineFailure {
        stage,
        message,
        retryable,
        exit_code: None,
        signal: None,
        stderr_tail: app
            .try_state::<EngineState>()
            .map(|state| state.stderr_tail())
            .unwrap_or_default(),
    }
}

fn failure_from_error(
    stage: EngineFailureStage,
    error: &AppError,
    retryable: bool,
    app: &AppHandle,
) -> EngineFailure {
    failure_from_message(stage, error.to_string(), retryable, app)
}

pub fn report_process_exit(app: AppHandle, generation: u32, exit_code: i32, signal: Option<i32>) {
    tauri::async_runtime::spawn(async move {
        if app
            .try_state::<EngineState>()
            .is_none_or(|state| !state.is_current_generation(generation))
        {
            return;
        }
        let stderr_tail = app
            .try_state::<EngineState>()
            .map(|state| state.stderr_tail())
            .unwrap_or_default();
        let failure = EngineFailure {
            stage: EngineFailureStage::Runtime,
            message: format!("Engine exited unexpectedly with code {exit_code}"),
            retryable: true,
            exit_code: Some(exit_code),
            signal,
            stderr_tail,
        };
        let supervisor = app.state::<EngineSupervisor>();
        supervisor.recover_after_exit(&app, failure).await;
    });
}

pub fn report_port_conflict(app: AppHandle, generation: u32, kind: port_guard::PortKind) {
    tauri::async_runtime::spawn(async move {
        let supervisor = app.state::<EngineSupervisor>();
        supervisor
            .recover_port_conflict(&app, generation, kind)
            .await;
    });
}

pub fn report_rpc_unhealthy(app: AppHandle, message: String) {
    tauri::async_runtime::spawn(async move {
        let stderr_tail = app
            .try_state::<EngineState>()
            .map(|state| state.stderr_tail())
            .unwrap_or_default();
        let failure = EngineFailure {
            stage: EngineFailureStage::Runtime,
            message: format!("Engine RPC remained unavailable: {message}"),
            retryable: true,
            exit_code: None,
            signal: None,
            stderr_tail,
        };
        let supervisor = app.state::<EngineSupervisor>();
        supervisor.recover_unhealthy_rpc(&app, failure).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_stopped() {
        let snapshot = EngineSnapshot::default();
        assert_eq!(snapshot.phase, EnginePhase::Stopped);
        assert_eq!(snapshot.desired, DesiredEngineState::Stopped);
        assert_eq!(snapshot.cause, EngineOperationCause::Initial);
        assert_eq!(snapshot.operation_id, 0);
    }

    #[test]
    fn operation_cause_uses_the_strict_camel_case_contract() {
        assert_eq!(
            serde_json::to_string(&EngineOperationCause::SettingsChange).unwrap(),
            "\"settingsChange\""
        );
        assert_eq!(
            serde_json::to_string(&EngineOperationCause::SessionRecovery).unwrap(),
            "\"sessionRecovery\""
        );
        assert!(serde_json::from_str::<EngineOperationCause>("\"arbitrary\"").is_err());
    }

    #[test]
    fn newer_operation_cancels_previous_operation() {
        let supervisor = EngineSupervisor::new();
        let (first_id, first_cancelled) = supervisor.begin_operation(DesiredEngineState::Running);
        let (second_id, _) = supervisor.begin_operation(DesiredEngineState::Stopped);
        assert!(second_id > first_id);
        assert!(*first_cancelled.borrow());
        assert!(!supervisor.is_current(first_id));
        assert_eq!(supervisor.desired_state(), DesiredEngineState::Stopped);
    }

    #[test]
    fn process_exit_is_unexpected_only_while_running_is_desired() {
        let supervisor = EngineSupervisor::new();
        assert!(supervisor.is_process_exit_expected());
        assert!(!supervisor.allows_process_spawn());

        let _ = supervisor.begin_operation(DesiredEngineState::Running);
        supervisor.snapshot.write().expect("snapshot").phase = EnginePhase::Running;
        assert!(!supervisor.is_process_exit_expected());
        assert!(supervisor.allows_process_spawn());

        supervisor.snapshot.write().expect("snapshot").phase = EnginePhase::Stopping;
        assert!(supervisor.is_process_exit_expected());

        let _ = supervisor.begin_operation(DesiredEngineState::Stopped);
        assert!(!supervisor.allows_process_spawn());
    }

    #[test]
    fn exit_cleanup_selects_only_completed_results() {
        let tasks = [
            ("complete", "done"),
            ("error", "failed"),
            ("removed", "removed"),
            ("paused", "paused"),
        ]
        .into_iter()
        .map(|(status, gid)| Aria2Task {
            gid: gid.into(),
            status: status.into(),
            ..Aria2Task::default()
        })
        .collect();

        assert_eq!(completed_result_gids(tasks), vec!["done"]);
    }
}
