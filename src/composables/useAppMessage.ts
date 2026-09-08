/** @fileoverview Composable providing application-level message notifications. */
import { h, type VNodeChild } from 'vue'
import { useMessage, type MessageOptions, type MessageReactive, type MessageType } from 'naive-ui'
import { MESSAGE_DURATION, MESSAGE_MAX_COUNT } from '@shared/timing'
import { ellipsis } from '@shared/utils/format'

/** Maximum display length for toast notification content. */
const TOAST_MAX_LENGTH = 128

/** Content accepted by message methods — plain text or VNode render function. */
export type MessageContent = string | (() => VNodeChild)

type MessageApi = ReturnType<typeof useMessage>
type MessageHandle = ReturnType<MessageApi['error']>
type MessageFn = (content: MessageContent, options?: MessageOptions) => MessageHandle

export interface AppProgressMessage {
  update: (content: string, type?: MessageType) => void
  finish: (content: string, type: 'success' | 'error') => void
  destroy: () => void
}

const DEFAULTS: MessageOptions = {
  closable: true,
  duration: MESSAGE_DURATION,
  keepAliveOnHover: true,
}

const activeMessages = new Map<string, { el: MessageHandle; timer: ReturnType<typeof setTimeout> }>()
const messageQueue: MessageHandle[] = []

function renderTextToast(content: string): () => VNodeChild {
  return () =>
    h(
      'span',
      {
        class: 'technical-text-wrap',
        style: {
          display: 'inline-block',
          maxWidth: 'min(560px, calc(100vw - 96px))',
        },
      },
      content,
    )
}

function renderNormalizedTextToast(content: string): () => VNodeChild {
  return renderTextToast(ellipsis(content, TOAST_MAX_LENGTH))
}

function forgetMessage(el: MessageHandle): void {
  const index = messageQueue.indexOf(el)
  if (index >= 0) messageQueue.splice(index, 1)
}

function dismissOverflowMessages(): void {
  while (messageQueue.length >= MESSAGE_MAX_COUNT) {
    const oldest = messageQueue.shift()
    oldest?.destroy()
  }
}

function showTrackedMessage(
  fn: MessageFn,
  content: MessageContent,
  options?: MessageOptions,
  onAfterLeave?: () => void,
): MessageHandle {
  let el: MessageHandle | null = null
  const mergedOptions: MessageOptions = {
    ...DEFAULTS,
    ...options,
    onAfterLeave: () => {
      if (el) forgetMessage(el)
      onAfterLeave?.()
      options?.onAfterLeave?.()
    },
  }

  dismissOverflowMessages()
  el = fn(content, mergedOptions)
  messageQueue.push(el)
  return el
}

/**
 * Dedup-aware message dispatcher.
 *
 * For plain string content: applies ellipsis truncation and deduplication.
 * For render functions: passes through directly to Naive UI (no dedup —
 * render functions are unique closures that cannot be compared by value).
 */
function dedupShow(fn: MessageFn, content: MessageContent, options?: MessageOptions) {
  // VNode render functions: pass through directly to Naive UI.
  // No dedup — each render closure is unique and cannot be compared.
  if (typeof content === 'function') {
    return showTrackedMessage(fn, content, options)
  }

  const key = content
  const existing = activeMessages.get(key)
  const duration = options?.duration ?? DEFAULTS.duration ?? MESSAGE_DURATION

  if (existing) {
    existing.el.destroy()
    forgetMessage(existing.el)
    clearTimeout(existing.timer)
    activeMessages.delete(key)
    setTimeout(() => {
      const el = showTrackedMessage(fn, renderNormalizedTextToast(content), options, () => activeMessages.delete(key))
      const timer = setTimeout(() => activeMessages.delete(key), duration)
      activeMessages.set(key, { el, timer })
    }, 80)
    return existing.el
  }

  const el = showTrackedMessage(fn, renderNormalizedTextToast(content), options, () => activeMessages.delete(key))
  const timer = setTimeout(() => activeMessages.delete(key), duration)
  activeMessages.set(key, { el, timer })
  return el
}

export function useAppMessage() {
  const message = useMessage()

  function progress(content: string): AppProgressMessage {
    let finishTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false
    const reactive: MessageReactive = showTrackedMessage(
      message.loading.bind(message),
      renderNormalizedTextToast(content),
      { duration: 0, closable: false },
      () => {
        destroyed = true
        if (finishTimer) clearTimeout(finishTimer)
      },
    )

    function update(nextContent: string, type: MessageType = 'loading') {
      if (destroyed) return
      reactive.content = renderNormalizedTextToast(nextContent)
      reactive.type = type
    }

    function destroy() {
      if (destroyed) return
      destroyed = true
      if (finishTimer) clearTimeout(finishTimer)
      reactive.destroy()
    }

    function finish(nextContent: string, type: 'success' | 'error') {
      if (destroyed) return
      update(nextContent, type)
      reactive.closable = true
      finishTimer = setTimeout(destroy, MESSAGE_DURATION)
    }

    return { update, finish, destroy }
  }

  return {
    success: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.success.bind(message), content, options),
    error: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.error.bind(message), content, options),
    warning: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.warning.bind(message), content, options),
    info: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.info.bind(message), content, options),
    progress,
  }
}
