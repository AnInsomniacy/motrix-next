/** @fileoverview Formatting utilities: byte sizes, time display, text splitting. */
import { parseInt } from 'lodash-es'

/** Converts raw byte count to human-readable size string (e.g. "1.5 GB"). */
export const bytesToSize = (bytes: string | number, precision = 1): string => {
  const b = parseInt(String(bytes), 10)
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  if (b === 0) return '0 KB'
  const i = parseInt(String(Math.floor(Math.log(b) / Math.log(1024))), 10)
  if (i === 0) return `${b} ${sizes[i]}`
  return `${(b / 1024 ** i).toFixed(precision)} ${sizes[i]}`
}

/** Extracts the unit suffix (K, M, G) from a formatted speed string. */
export const extractSpeedUnit = (speed = ''): string => {
  if (parseInt(speed) === 0) return 'K'
  const regex = /^(\d+\.?\d*)([KMG])$/
  const match = regex.exec(speed)
  if (!match) return 'K'
  return match[2]
}

export const timeRemaining = (totalLength: number, completedLength: number, downloadSpeed: number): number => {
  if (!downloadSpeed || downloadSpeed <= 0) return 0
  const remainingLength = totalLength - completedLength
  const result = Math.ceil(remainingLength / downloadSpeed)
  if (!isFinite(result) || Number.isNaN(result)) return 0
  return result
}

export const timeFormat = (
  seconds: number,
  { prefix = '', suffix = '', i18n }: { prefix?: string; suffix?: string; i18n?: Record<string, string> },
): string => {
  let result = ''
  let hours = ''
  let minutes = ''
  let secs = seconds || 0
  const i = {
    gt1d: '> 1 day',
    hour: 'h',
    minute: 'm',
    second: 's',
    ...i18n,
  }

  if (secs <= 0) return ''
  if (secs > 86400) return `${prefix} ${i.gt1d} ${suffix}`
  if (secs > 3600) {
    hours = `${Math.floor(secs / 3600)}${i.hour} `
    secs %= 3600
  }
  if (secs > 60) {
    minutes = `${Math.floor(secs / 60)}${i.minute} `
    secs %= 60
  }
  const secsStr = `${Math.floor(secs)}${i.second}`
  result = hours + minutes + secsStr
  return result ? `${prefix} ${result} ${suffix}` : result
}

export const localeDateTimeFormat = (timestamp: number | string, locale: string): string => {
  if (!timestamp) return ''
  let ts = Number(timestamp)
  if (`${timestamp}`.length === 10) ts *= 1000
  const date = new Date(ts)
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
}

export const ellipsis = (str = '', maxLen = 64): string => {
  if (!str) return ''
  if (str.length <= maxLen) return str
  if (maxLen > 0) return `${str.substring(0, maxLen)}...`
  return str
}

export const convertCommaToLine = (text = ''): string => {
  let arr = `${text}`.split(',')
  arr = arr.map((row) => row.trim())
  return arr.join('\n').trim()
}

export const convertLineToComma = (text = ''): string => {
  return text.trim().replace(/(?:\r\n|\r|\n)/g, ',')
}
