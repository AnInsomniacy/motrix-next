import {
    camelCase,
    compact,
    difference,
    isEmpty,
    isFunction,
    isNaN,
    isPlainObject,
    kebabCase,
    omitBy,
    parseInt,
    pick,
    isArray,
} from 'lodash-es'

import { userKeys, systemKeys, needRestartKeys } from '@shared/configKeys'
import {
    APP_THEME,
    ENGINE_RPC_HOST,
    GRAPHIC,
    NONE_SELECTED_FILES,
    SELECTED_ALL_FILES,
    RESOURCE_TAGS,
    IMAGE_SUFFIXES,
    AUDIO_SUFFIXES,
    VIDEO_SUFFIXES,
    SUB_SUFFIXES,
    UNKNOWN_PEERID,
    UNKNOWN_PEERID_NAME,
    DOCUMENT_SUFFIXES,
    SUPPORT_RTL_LOCALES,
} from '@shared/constants'

export const bytesToSize = (bytes: string | number, precision = 1): string => {
    const b = parseInt(String(bytes), 10)
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    if (b === 0) return '0 KB'
    const i = parseInt(String(Math.floor(Math.log(b) / Math.log(1024))), 10)
    if (i === 0) return `${b} ${sizes[i]}`
    return `${(b / 1024 ** i).toFixed(precision)} ${sizes[i]}`
}

export const extractSpeedUnit = (speed = ''): string => {
    if (parseInt(speed) === 0) return 'K'
    const regex = /^(\d+\.?\d*)([KMG])$/
    const match = regex.exec(speed)
    if (!match) return 'K'
    return match[2]
}

export const bitfieldToPercent = (text: string): string => {
    const len = text.length - 1
    let p: number
    let one = 0
    for (let i = 0; i < len; i++) {
        p = parseInt(text[i], 16)
        for (let j = 0; j < 4; j++) {
            one += p & 1
            p >>= 1
        }
    }
    return Math.floor((one / (4 * len)) * 100).toString()
}

export const bitfieldToGraphic = (text: string): string => {
    const len = text.length
    let result = ''
    for (let i = 0; i < len; i++) {
        result += GRAPHIC[Math.floor(parseInt(text[i], 16) / 4)] + ' '
    }
    return result
}

export const peerIdParser = (str: string): string => {
    if (!str || str === UNKNOWN_PEERID) {
        return UNKNOWN_PEERID_NAME
    }
    return UNKNOWN_PEERID_NAME
}

export const calcProgress = (totalLength: string | number, completedLength: string | number, decimal = 2): number => {
    const total = parseInt(String(totalLength), 10)
    const completed = parseInt(String(completedLength), 10)
    if (total === 0 || completed === 0) return 0
    const percentage = (completed / total) * 100
    return parseFloat(percentage.toFixed(decimal))
}

export const calcRatio = (totalLength: string | number, uploadLength: string | number): number => {
    const total = parseInt(String(totalLength), 10)
    const upload = parseInt(String(uploadLength), 10)
    if (total === 0 || upload === 0) return 0
    const percentage = upload / total
    return parseFloat(percentage.toFixed(4))
}

export const timeRemaining = (totalLength: number, completedLength: number, downloadSpeed: number): number => {
    if (!downloadSpeed || downloadSpeed <= 0) return 0
    const remainingLength = totalLength - completedLength
    const result = Math.ceil(remainingLength / downloadSpeed)
    if (!isFinite(result) || isNaN(result)) return 0
    return result
}

export const timeFormat = (
    seconds: number,
    { prefix = '', suffix = '', i18n }: { prefix?: string; suffix?: string; i18n?: Record<string, string> }
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
    if (str.length < maxLen) return str
    if (maxLen > 0) return `${str.substring(0, maxLen)}...`
    return str
}

interface TaskFile {
    path: string
    selected?: boolean
    uris?: { uri: string }[]
    extension?: string
}

interface Task {
    files: TaskFile[]
    bittorrent?: { info?: { name: string }; announceList?: string[] }
    infoHash?: string
    seeder?: string
    totalLength?: string | number
    completedLength?: string | number
    downloadSpeed?: string | number
    uploadLength?: string | number
    status?: string
}

export const getFileSelection = (files: TaskFile[] = []): string => {
    const selectedFiles = files.filter((file) => file.selected)
    if (files.length === 0 || selectedFiles.length === 0) return NONE_SELECTED_FILES
    if (files.length === selectedFiles.length) return SELECTED_ALL_FILES
    const indexArr: number[] = []
    files.forEach((_, index) => indexArr.push(index))
    return indexArr.join(',')
}

export const getFileNameFromFile = (file?: TaskFile): string => {
    if (!file) return ''
    let { path } = file
    if (!path && file.uris && file.uris.length > 0) {
        path = decodeURI(file.uris[0].uri)
    }
    const index = path.lastIndexOf('/')
    if (index <= 0 || index === path.length) return path
    return path.substring(index + 1)
}

export const getTaskName = (task: Task | null, options: { defaultName?: string; maxLen?: number } = {}): string => {
    const o = { defaultName: '', maxLen: 64, ...options }
    const { defaultName, maxLen } = o
    let result = defaultName
    if (!task) return result

    const { files, bittorrent } = task
    const total = files.length

    if (bittorrent && bittorrent.info && bittorrent.info.name) {
        result = ellipsis(bittorrent.info.name, maxLen)
    } else if (total === 1) {
        result = getFileNameFromFile(files[0])
        result = ellipsis(result, maxLen)
    }

    return result
}

export const isMagnetTask = (task: Task): boolean => {
    const { bittorrent } = task
    return !!bittorrent && !bittorrent.info
}

export const checkTaskIsSeeder = (task: Task): boolean => {
    const { bittorrent, seeder } = task
    return !!bittorrent && seeder === 'true'
}

export const checkTaskIsBT = (task: Partial<Task> = {}): boolean => {
    return !!task.bittorrent
}

export const buildMagnetLink = (task: Task, withTracker = false, btTracker: string[] = []): string => {
    const { bittorrent, infoHash } = task
    const info = bittorrent?.info

    const params = [`magnet:?xt=urn:btih:${infoHash}`]
    if (info && info.name) {
        params.push(`dn=${encodeURI(info.name)}`)
    }

    if (withTracker && bittorrent?.announceList) {
        const trackers = difference(bittorrent.announceList, btTracker)
        trackers.forEach((tracker) => {
            params.push(`tr=${encodeURI(tracker)}`)
        })
    }

    return params.join('&')
}

export const getTaskUri = (task: Task, withTracker = false): string => {
    const { files } = task
    if (checkTaskIsBT(task)) {
        return buildMagnetLink(task, withTracker)
    }
    if (files && files.length === 1) {
        const { uris } = files[0]
        if (uris && uris.length > 0) return uris[0].uri
    }
    return ''
}

export const checkTaskTitleIsEmpty = (task: Task): boolean => {
    const { files, bittorrent } = task
    const [file] = files
    const { path } = file
    let result = path
    if (bittorrent && bittorrent.info && bittorrent.info.name) {
        result = bittorrent.info.name
    }
    return result === ''
}

export const isTorrent = (file: { name: string; type: string }): boolean => {
    const { name, type } = file
    return name.endsWith('.torrent') || type === 'application/x-bittorrent'
}

export const getAsBase64 = (file: File, callback: (result: string) => void): void => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
        const result = (reader.result as string).split('base64,')[1]
        callback(result)
    })
    reader.readAsDataURL(file)
}

export const mergeTaskResult = (response: unknown[][] = []): unknown[] => {
    let result: unknown[] = []
    for (const res of response) {
        result = result.concat(...res)
    }
    return result
}

export const changeKeysCase = (obj: Record<string, unknown>, caseConverter: (s: string) => string): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    if (isEmpty(obj) || !isFunction(caseConverter)) return result
    for (const [k, value] of Object.entries(obj)) {
        result[caseConverter(k)] = value
    }
    return result
}

export const changeKeysToCamelCase = (obj: Record<string, unknown> = {}): Record<string, unknown> => {
    return changeKeysCase(obj, camelCase)
}

export const changeKeysToKebabCase = (obj: Record<string, unknown> = {}): Record<string, unknown> => {
    return changeKeysCase(obj, kebabCase)
}

export const validateNumber = (n: unknown): boolean => {
    return !isNaN(parseFloat(String(n))) && isFinite(Number(n)) && Number(n) === n
}

export const fixValue = (obj: Record<string, unknown> = {}): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (v === 'true') result[k] = true
        else if (v === 'false') result[k] = false
        else if (validateNumber(v)) result[k] = Number(v)
        else result[k] = v
    }
    return result
}

export const separateConfig = (options: Record<string, unknown>) => {
    const user: Record<string, unknown> = {}
    const system: Record<string, unknown> = {}
    const others: Record<string, unknown> = {}

    for (const [k, v] of Object.entries(options)) {
        if (userKeys.indexOf(k) !== -1) user[k] = v
        else if (systemKeys.indexOf(k) !== -1) system[k] = v
        else others[k] = v
    }
    return { user, system, others }
}

export const compactUndefined = <T>(arr: (T | undefined)[] = []): T[] => {
    return arr.filter((item): item is T => item !== undefined)
}

export const splitTextRows = (text = ''): string[] => {
    let result =
        `${text}`
            .replace(/(?:\\\r\\\n|\\\r|\\\n)/g, ' ')
            .replace(/(?:\r\n|\r|\n)/g, '\n')
            .split('\n') || []
    result = result.map((row) => row.trim())
    return result
}

export const convertCommaToLine = (text = ''): string => {
    let arr = `${text}`.split(',')
    arr = arr.map((row) => row.trim())
    return arr.join('\n').trim()
}

export const convertLineToComma = (text = ''): string => {
    return text.trim().replace(/(?:\r\n|\r|\n)/g, ',')
}

export const filterVideoFiles = (files: TaskFile[] = []): TaskFile[] => {
    const suffix = [...VIDEO_SUFFIXES, ...SUB_SUFFIXES]
    return files.filter((item) => item.extension && suffix.includes(item.extension))
}

export const filterAudioFiles = (files: TaskFile[] = []): TaskFile[] => {
    return files.filter((item) => item.extension && AUDIO_SUFFIXES.includes(item.extension))
}

export const filterImageFiles = (files: TaskFile[] = []): TaskFile[] => {
    return files.filter((item) => item.extension && IMAGE_SUFFIXES.includes(item.extension))
}

export const filterDocumentFiles = (files: TaskFile[] = []): TaskFile[] => {
    return files.filter((item) => item.extension && DOCUMENT_SUFFIXES.includes(item.extension))
}

export const isAudioOrVideo = (uri = ''): boolean => {
    const suffixs = [...AUDIO_SUFFIXES, ...VIDEO_SUFFIXES]
    return suffixs.some((suffix) => uri.includes(suffix))
}

export const needCheckCopyright = (links = ''): boolean => {
    const uris = splitTaskLinks(links)
    const avs = uris.filter((uri) => isAudioOrVideo(uri))
    return avs.length > 0
}

export const decodeThunderLink = (url = ''): string => {
    if (!url.startsWith('thunder://')) return url
    let result = url.trim()
    result = result.split('thunder://')[1]
    result = atob(result)
    result = result.substring(2, result.length - 2)
    return result
}

export const splitTaskLinks = (links = ''): string[] => {
    const temp = compact(splitTextRows(links))
    return temp.map((item) => decodeThunderLink(item))
}

export const detectResource = (content: string): boolean => {
    return RESOURCE_TAGS.some((type) => content.includes(type))
}

export const buildFileList = (rawFile: File) => {
    const uid = Date.now()
    const file = {
        status: 'ready',
        name: rawFile.name,
        size: rawFile.size,
        percentage: 0,
        uid,
        raw: rawFile,
    }
    return [file]
}

export const isRTL = (locale = 'en-US'): boolean => {
    return SUPPORT_RTL_LOCALES.includes(locale)
}

export const getLangDirection = (locale = 'en-US'): string => {
    return isRTL(locale) ? 'rtl' : 'ltr'
}

export const listTorrentFiles = (files: TaskFile[]) => {
    return files.map((file, index) => {
        const extension = getFileExtension(file.path)
        return {
            idx: index + 1,
            extension: `.${extension}`,
            ...file,
        }
    })
}

export const getFileName = (fullPath: string): string => {
    return fullPath.replace(/^.*[/\\]/, '')
}

export const getFileExtension = (filename: string): string => {
    return filename.slice(((filename.lastIndexOf('.') - 1) >>> 0) + 2)
}

export const removeExtensionDot = (extension = ''): string => {
    return extension.replace('.', '')
}

export const diffConfig = (current: Record<string, unknown> = {}, next: Record<string, unknown> = {}): Record<string, unknown> => {
    const curr = pick(current, Object.keys(next))
    return omitBy(next, (val, key) => {
        if (isArray(val) || isPlainObject(val)) {
            return JSON.stringify(curr[key]) === JSON.stringify(val)
        }
        return curr[key] === val
    })
}

export const calcFormLabelWidth = (locale: string): string => {
    return locale.startsWith('de') ? '28%' : '25%'
}

export const parseHeader = (header = ''): Record<string, string> => {
    header = header.trim()
    let result: Record<string, string> = {}
    if (!header) return result
    const headers = splitTextRows(header)
    headers.forEach((line) => {
        const index = line.indexOf(':')
        const name = line.substring(0, index)
        const value = line.substring(index + 1).trim()
        result[name] = value
    })
    result = changeKeysToCamelCase(result) as Record<string, string>
    return result
}

export const formatOptionsForEngine = (options: Record<string, unknown> = {}): Record<string, string> => {
    const result: Record<string, string> = {}
    Object.keys(options).forEach((key) => {
        const kebabCaseKey = kebabCase(key)
        if (Array.isArray(options[key])) {
            result[kebabCaseKey] = (options[key] as string[]).join('\n')
        } else {
            result[kebabCaseKey] = `${options[key]}`
        }
    })
    return result
}

export const buildRpcUrl = (options: { port: number; secret?: string } = { port: 16800 }): string => {
    const { port, secret } = options
    let result = `${ENGINE_RPC_HOST}:${port}/jsonrpc`
    if (secret) result = `token:${secret}@${result}`
    return `http://${result}`
}

export const checkIsNeedRestart = (changed: Record<string, unknown> = {}): boolean => {
    if (isEmpty(changed)) return false
    const kebabCaseChanged = changeKeysToKebabCase(changed)
    let result = false
    needRestartKeys.some((key) => {
        if (Object.keys(kebabCaseChanged).includes(key)) {
            result = true
            return true
        }
        return false
    })
    return result
}

export const checkIsNeedRun = (enable: boolean, lastTime: number, interval: number): boolean => {
    if (!enable) return false
    return Date.now() - lastTime > interval
}

export const generateRandomInt = (min = 0, max = 10000): number => {
    const range = max - min
    return min + Math.floor(Math.random() * Math.floor(range))
}

export const intersection = <T>(array1: T[] = [], array2: T[] = []): T[] => {
    if (array1.length === 0 || array2.length === 0) return []
    return array1.filter((value) => array2.includes(value))
}

export const cloneArray = <T>(arr: T[] = [], reversed = false): T[] => {
    if (!Array.isArray(arr)) return arr
    const result = [...arr]
    return reversed ? result.reverse() : result
}

export const pushItemToFixedLengthArray = <T>(arr: T[] = [], maxLength: number, item: T): T[] => {
    return arr.length >= maxLength ? [...arr.slice(1, maxLength - 1), item] : [...arr, item]
}

export const removeArrayItem = <T>(arr: T[] = [], item: T): T[] => {
    const idx = arr.indexOf(item)
    if (idx === -1) return [...arr]
    return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
}

export const getInverseTheme = (theme: string): string => {
    return theme === APP_THEME.LIGHT ? APP_THEME.DARK : APP_THEME.LIGHT
}

export const changedConfig: { basic: Record<string, unknown>; advanced: Record<string, unknown> } = { basic: {}, advanced: {} }
export const backupConfig: { theme?: string; locale?: string } = { theme: undefined, locale: undefined }

