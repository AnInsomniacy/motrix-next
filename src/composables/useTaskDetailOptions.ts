/**
 * @fileoverview Composable for managing per-task options in the Task Detail drawer.
 *
 * Reads the current task's options via `getTaskOption`, exposes a reactive form
 * for UA, referer, cookie, authorization, and proxy,
 * and applies changes via `changeTaskOption`.
 *
 * Native request options use the engine's pending-option restart path.
 * Media options are only editable while paused to preserve recording continuity.
 *
 * Pure dependency-injection design — no direct store/API imports — fully testable.
 */
import { ref, reactive, computed, watch, type Ref } from 'vue'
import { isEngineReady } from '@/api/aria2'
import { sanitizeHeaderValue, sanitizeHttpHeaderOptions } from '@shared/utils/headerSanitize'
import { TASK_STATUS } from '@shared/constants'
import type { Aria2Task, Aria2EngineOptions, ProxyConfig } from '@shared/types'
import { logger } from '@shared/logger'
import { buildTaskProxyOptions, hasInvalidManualProxy, type TaskProxyMode } from '@shared/utils/proxy'

// ── Constants ─────────────────────────────────────────────────────

/** Task statuses where aria2 allows option modification. */
const MODIFIABLE_STATUSES = new Set([TASK_STATUS.ACTIVE, TASK_STATUS.WAITING, TASK_STATUS.PAUSED])

// ── Public types ──────────────────────────────────────────────────

/** Proxy configuration mode for a specific task. */
export type ProxyMode = TaskProxyMode

export interface TaskDetailOptionsForm {
  userAgent: string
  referer: string
  cookie: string
  authorization: string
  httpAuthUsername: string
  httpAuthPassword: string
  proxyMode: ProxyMode
  customProxy: string
  customProxyUsername: string
  customProxyPassword: string
}

export interface UseTaskDetailOptionsConfig {
  task: Ref<Aria2Task | null>
  getTaskOption: (gid: string) => Promise<Record<string, string>>
  changeTaskOption: (payload: { gid: string; options: Aria2EngineOptions }) => Promise<void>
  proxyConfig: () => ProxyConfig
  message: {
    success: (content: string) => void
    error: (content: string) => void
  }
  t: (key: string) => string
}

// ── Pure header utilities ─────────────────────────────────────────

/**
 * Extracts Cookie and Authorization values from aria2's `header` option.
 *
 * aria2 may return `header` as a single newline-separated string, an array
 * of strings, or undefined. This function handles all forms gracefully.
 */
export function parseHeaders(raw: string | string[] | undefined): {
  cookie: string
  authorization: string
} {
  const result = { cookie: '', authorization: '' }
  if (!raw) return result

  const lines = Array.isArray(raw) ? raw : raw.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^Cookie:\s*/i.test(trimmed)) {
      result.cookie = trimmed.replace(/^Cookie:\s*/i, '').trim()
    } else if (/^Authorization:\s*/i.test(trimmed)) {
      result.authorization = trimmed.replace(/^Authorization:\s*/i, '').trim()
    }
  }
  return result
}

/**
 * Builds an aria2 `header` array from cookie and authorization values.
 * Returns an empty array when both are empty.
 */
export function buildHeaders(cookie: string, authorization: string): string[] {
  const headers: string[] = []
  const cleanCookie = sanitizeHeaderValue(cookie)
  const cleanAuthorization = sanitizeHeaderValue(authorization)
  if (cleanCookie) headers.push(`Cookie: ${cleanCookie}`)
  if (cleanAuthorization) headers.push(`Authorization: ${cleanAuthorization}`)
  return headers
}

// ── Form snapshot helpers ─────────────────────────────────────────

function createEmptyForm(): TaskDetailOptionsForm {
  return {
    userAgent: '',
    referer: '',
    cookie: '',
    authorization: '',
    httpAuthUsername: '',
    httpAuthPassword: '',
    proxyMode: 'direct',
    customProxy: '',
    customProxyUsername: '',
    customProxyPassword: '',
  }
}

function snapshotForm(source: TaskDetailOptionsForm, target: TaskDetailOptionsForm) {
  Object.assign(target, { ...source })
}

// ── Proxy detection ───────────────────────────────────────────────

function detectProxyMode(opts: Record<string, string>): { mode: ProxyMode; custom: string } {
  const allProxy = (opts.allProxy as string) ?? ''
  if (allProxy) return { mode: 'manual', custom: allProxy }
  return { mode: 'direct', custom: '' }
}

// ── Options loader ────────────────────────────────────────────────

function populateFormFromResponse(opts: Record<string, string>, form: TaskDetailOptionsForm) {
  form.userAgent = (opts.userAgent as string) ?? ''
  form.referer = (opts.referer as string) ?? ''

  const headerRaw = opts.header as unknown as string | string[] | undefined
  const parsed = parseHeaders(headerRaw)
  form.cookie = parsed.cookie
  form.authorization = parsed.authorization
  form.httpAuthUsername = (opts.httpUser as string) ?? ''
  form.httpAuthPassword = (opts.httpPasswd as string) ?? ''

  const detected = detectProxyMode(opts)
  form.proxyMode = detected.mode
  form.customProxy = detected.custom
  form.customProxyUsername = (opts.allProxyUser as string) ?? ''
  form.customProxyPassword = (opts.allProxyPasswd as string) ?? ''
}

// ── Changed-options diff builder ──────────────────────────────────

function buildChangedOptions(
  form: TaskDetailOptionsForm,
  loaded: TaskDetailOptionsForm,
  proxyOptions: Aria2EngineOptions,
): Aria2EngineOptions {
  const options: Aria2EngineOptions = {}
  const sanitizedHeaders = sanitizeHttpHeaderOptions({
    userAgent: form.userAgent,
    referer: form.referer,
    cookie: form.cookie,
    authorization: form.authorization,
  })

  if (form.userAgent !== loaded.userAgent) {
    options['user-agent'] = sanitizedHeaders.userAgent ?? ''
  }
  if (form.referer !== loaded.referer) {
    options.referer = sanitizedHeaders.referer ?? ''
  }
  if (form.cookie !== loaded.cookie || form.authorization !== loaded.authorization) {
    options.header = buildHeaders(form.cookie, form.authorization)
  }
  if (form.httpAuthUsername !== loaded.httpAuthUsername || form.httpAuthPassword !== loaded.httpAuthPassword) {
    const username = sanitizeHeaderValue(form.httpAuthUsername)
    options['http-user'] = username
    options['http-passwd'] = sanitizeHeaderValue(form.httpAuthPassword)
  }
  if (
    form.proxyMode !== loaded.proxyMode ||
    form.customProxy !== loaded.customProxy ||
    form.customProxyUsername !== loaded.customProxyUsername ||
    form.customProxyPassword !== loaded.customProxyPassword
  ) {
    Object.assign(options, proxyOptions)
  }

  return options
}

// ── Composable ────────────────────────────────────────────────────

export function useTaskDetailOptions(config: UseTaskDetailOptionsConfig) {
  const { task, getTaskOption, changeTaskOption, proxyConfig, message, t } = config

  const form = reactive<TaskDetailOptionsForm>(createEmptyForm())
  const loaded = reactive<TaskDetailOptionsForm>(createEmptyForm())
  const applying = ref(false)

  const canModify = computed(() => {
    if (!task.value || !isEngineReady()) return false
    if (task.value.media && task.value.status !== 'paused') return false
    return MODIFIABLE_STATUSES.has(task.value.status)
  })

  const dirty = computed(
    () =>
      form.userAgent !== loaded.userAgent ||
      form.referer !== loaded.referer ||
      form.cookie !== loaded.cookie ||
      form.authorization !== loaded.authorization ||
      form.httpAuthUsername !== loaded.httpAuthUsername ||
      form.httpAuthPassword !== loaded.httpAuthPassword ||
      form.proxyMode !== loaded.proxyMode ||
      form.customProxy !== loaded.customProxy ||
      form.customProxyUsername !== loaded.customProxyUsername ||
      form.customProxyPassword !== loaded.customProxyPassword,
  )

  function resetForm() {
    Object.assign(form, createEmptyForm())
    snapshotForm(form, loaded)
  }

  async function loadOptions(gid: string) {
    try {
      const opts = await getTaskOption(gid)
      populateFormFromResponse(opts, form)

      snapshotForm(form, loaded)
    } catch (err) {
      logger.debug('[useTaskDetailOptions] getTaskOption failed', err)
      resetForm()
    }
  }

  watch(
    () => task.value?.gid,
    (gid) => (gid && canModify.value ? void loadOptions(gid) : resetForm()),
    { immediate: true },
  )

  async function applyOptions(): Promise<void> {
    if (applying.value || !task.value || !dirty.value) return
    applying.value = true
    try {
      const proxyOptions = buildTaskProxyOptions(
        form.proxyMode,
        form.customProxy,
        proxyConfig(),
        form.customProxyUsername,
        form.customProxyPassword,
      )

      // Validate proxy format before sending to aria2 — prevents errorCode=28 crash
      if (hasInvalidManualProxy(proxyOptions)) {
        message.error(t('task.proxy-unsupported-protocol'))
        return
      }

      const options = buildChangedOptions(form, loaded, proxyOptions)
      await changeTaskOption({ gid: task.value.gid, options })
      snapshotForm(form, loaded)
      const key = task.value.status === TASK_STATUS.ACTIVE ? 'task.options-applied-restart' : 'task.options-applied'
      message.success(t(key))
    } catch (err) {
      logger.debug('[useTaskDetailOptions] changeTaskOption failed', err)
      message.error(t('task.options-apply-failed'))
    } finally {
      applying.value = false
    }
  }

  return { form, canModify, dirty, applying, applyOptions }
}
