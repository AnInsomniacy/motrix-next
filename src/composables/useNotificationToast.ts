/**
 * @fileoverview Toast VNode rendering for download-completion notifications.
 *
 * Produces a Naive UI `message.success` render function with inline action
 * buttons that let the user open the downloaded file or reveal it in the
 * system file manager — directly from the toast notification.
 *
 * Visual layout:
 *   [✓ body text                      Open File · Show in Folder]
 */
import { h, type VNodeChild } from 'vue'
import { NButton } from 'naive-ui'

/** Options accepted by {@link renderCompletionToast}. */
export interface CompletionToastOptions {
  /** Localised notification body text (e.g. "movie.mp4 completed"). */
  body: string
  /** i18n translation function. */
  t: (key: string) => string
  /** Callback fired when the user clicks "Open File". */
  onOpenFile: () => void
  /** Callback fired when the user clicks "Show in Folder". */
  onShowInFolder: () => void
}

/**
 * Build a VNode render function for a download-complete toast.
 *
 * Returns a `() => VNodeChild` suitable for `message.success(renderFn)`.
 */
export function renderCompletionToast(options: CompletionToastOptions): () => VNodeChild {
  const { body, t, onOpenFile, onShowInFolder } = options

  return () =>
    h(
      'div',
      {
        style: {
          display: 'grid',
          alignItems: 'center',
          gridTemplateColumns: 'minmax(0, 1fr) max-content',
          gap: '16px',
          maxWidth: '100%',
          minWidth: '0',
        },
      },
      [
        h(
          'span',
          {
            class: 'technical-text-wrap',
            style: {
              minWidth: '0',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: '2',
              WebkitBoxOrient: 'vertical',
            },
          },
          body,
        ),
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'nowrap',
              whiteSpace: 'nowrap',
            },
          },
          [
            h(
              NButton,
              {
                tertiary: true,
                type: 'primary',
                size: 'small',
                onClick: (e: MouseEvent) => {
                  e.stopPropagation()
                  onOpenFile()
                },
              },
              { default: () => t('task.open-file') },
            ),
            h(
              NButton,
              {
                tertiary: true,
                type: 'primary',
                size: 'small',
                onClick: (e: MouseEvent) => {
                  e.stopPropagation()
                  onShowInFolder()
                },
              },
              { default: () => t('task.show-in-folder') },
            ),
          ],
        ),
      ],
    )
}
