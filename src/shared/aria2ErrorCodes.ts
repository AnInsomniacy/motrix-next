/**
 * @fileoverview Mapping of aria2 error codes to i18n keys for user-facing notifications.
 *
 * Source of truth: aria2 C++ enum `error_code::Value`
 * https://github.com/aria2/aria2/blob/master/src/error_code.h
 *
 * Codes 0 (FINISHED) and 31 (REMOVED/reserved) are intentionally excluded.
 * Unknown codes fall back to displaying aria2's raw errorMessage.
 */
import type { I18nKey } from '@shared/i18nTypes'

export const ARIA2_ERROR_CODES: Record<string, I18nKey> = {
  '1': 'task.error-unknown',
  '2': 'task.error-timeout',
  '3': 'task.error-not-found',
  '4': 'task.error-max-file-not-found',
  '5': 'task.error-too-slow',
  '6': 'task.error-network',
  '7': 'task.error-unfinished',
  '8': 'task.error-resume-failed',
  '9': 'task.error-disk-full',
  '10': 'task.error-piece-length',
  '11': 'task.error-duplicate-file',
  '12': 'task.error-duplicate-torrent',
  '13': 'task.error-file-exists',
  '14': 'task.error-rename-failed',
  '15': 'task.error-file-open',
  '16': 'task.error-file-create',
  '17': 'task.error-io',
  '18': 'task.error-dir-create',
  '19': 'task.error-dns',
  '22': 'task.error-http-response',
  '23': 'task.error-too-many-redirects',
  '24': 'task.error-http-auth',
  '25': 'task.error-bencode-parse',
  '26': 'task.error-torrent-corrupt',
  '27': 'task.error-magnet-bad',
  '28': 'task.error-bad-option',
  '29': 'task.error-server-unavailable',
  '30': 'task.error-json-rpc-parse',
  '32': 'task.error-checksum',
}
