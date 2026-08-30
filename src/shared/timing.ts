/** @fileoverview Named timing constants eliminating magic numbers throughout the codebase. */

/** Polling interval for refreshing the active task list (ms). */
export const TASK_POLLING_INTERVAL = 1000

/** Base interval for global stat refresh (ms). */
export const STAT_BASE_INTERVAL = 500

/** Additional per-active-task stat interval increment (ms). */
export const STAT_PER_TASK_INTERVAL = 100

/** Minimum stat refresh interval cap (ms). */
export const STAT_MIN_INTERVAL = 500

/** Maximum stat refresh interval cap (ms). */
export const STAT_MAX_INTERVAL = 6000

/** Delay before showing the loading spinner in the add-task dialog (ms). */
export const ADD_TASK_LOADING_DELAY = 300

/** Default timeout for file operation retries (ms). */
export const FILE_OP_TIMEOUT = 5000

/** Engine health-check retry interval (ms). */
export const ENGINE_RETRY_INTERVAL = 500

/** Maximum number of engine health-check retries before giving up. */
export const ENGINE_MAX_RETRIES = 10

/** Time the successful engine recovery state remains visible (ms). */
export const ENGINE_RECOVERY_SUCCESS_DURATION = 1200

/** Default duration for notification messages (ms). */
export const MESSAGE_DURATION = 3000

/** Maximum number of in-app notification messages shown at once. */
export const MESSAGE_MAX_COUNT = 3

/** JSON-RPC call timeout (ms). */
export const RPC_TIMEOUT = 15_000

/** Default aria2 RPC listen port. */
export const DEFAULT_ARIA2_PORT = 29100

/** Minimum visible loading duration for tracker sync animation (ms). */
export const SYNC_MIN_DURATION = 600

/** Minimum visible loading duration for system proxy detection (ms). */
export const DETECT_MIN_DURATION = 500

/** Debounce delay before a task search keyword triggers a list refetch (ms). */
export const TASK_SEARCH_DEBOUNCE = 250
