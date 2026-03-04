import { isEmpty } from 'lodash-es'
import axios from 'axios'
import { MAX_BT_TRACKER_LENGTH, ONE_SECOND, PROXY_SCOPES } from '@shared/constants'

export const convertToAxiosProxy = (proxyServer = '') => {
    if (!proxyServer) {
        return undefined
    }

    const url = new URL(proxyServer)
    const { username, password, protocol = 'http:', hostname, port } = url

    const result: Record<string, unknown> = {
        protocol: protocol.replace(':', ''),
        host: hostname,
        port,
    }

    if (username || password) {
        result.auth = { username, password }
    }

    return result
}

export const fetchBtTrackerFromSource = async (
    source: string[],
    proxyConfig: Record<string, unknown> = {}
): Promise<string[]> => {
    if (isEmpty(source)) {
        return []
    }

    const now = Date.now()
    const { enable, server, scope = [] } = proxyConfig as {
        enable?: boolean
        server?: string
        scope?: string[]
    }
    const proxy =
        enable && server && scope.includes(PROXY_SCOPES.UPDATE_TRACKERS)
            ? convertToAxiosProxy(server)
            : undefined

    const promises = source.map(async (url: string) => {
        return axios
            .get(`${url}?t=${now}`, {
                timeout: 30 * ONE_SECOND,
                proxy: proxy as never,
            })
            .then((value) => value.data as string)
    })

    const results = await Promise.allSettled(promises)
    const values = results
        .filter((item): item is PromiseFulfilledResult<string> => item.status === 'fulfilled')
        .map((item) => item.value)
    return [...new Set(values)]
}

export const convertTrackerDataToLine = (arr: string[] = []): string => {
    return arr
        .join('\r\n')
        .replace(/^\s*[\r\n]/gm, '')
        .trim()
}

export const convertTrackerDataToComma = (arr: string[] = []): string => {
    return convertTrackerDataToLine(arr)
        .replace(/(?:\r\n|\r|\n)/g, ',')
        .trim()
}

export const reduceTrackerString = (str = ''): string => {
    if (str.length <= MAX_BT_TRACKER_LENGTH) {
        return str
    }

    const subStr = str.substring(0, MAX_BT_TRACKER_LENGTH)
    const index = subStr.lastIndexOf(',')
    if (index === -1) {
        return subStr
    }

    return subStr.substring(0, index)
}
