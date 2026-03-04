import curlParser from '@bany/curl-to-json'

export const buildUrisFromCurl = (uris: string[] = []): string[] => {
    return uris.map((uri) => {
        if (uri.startsWith('curl')) {
            const parsedUri = curlParser(uri) as { url: string; params?: Record<string, string> }
            let url = parsedUri.url
            if (parsedUri.params && Object.keys(parsedUri.params).length > 0) {
                const paramsStr = Object.keys(parsedUri.params)
                    .map((k) => `${k}=${parsedUri.params![k]}`)
                    .join('&')
                url = `${url}?${paramsStr}`
            }
            return url
        }
        return uri
    })
}

export const buildHeadersFromCurl = (uris: string[] = []): (Record<string, string> | undefined)[] => {
    return uris.map((uri) => {
        if (uri.startsWith('curl')) {
            const parsed = curlParser(uri) as unknown as Record<string, unknown>
            const header: Record<string, string> = (parsed.header ?? {}) as Record<string, string>
            if (parsed.cookie) header.cookie = parsed.cookie as string
            if (parsed['user-agent']) header['user-agent'] = parsed['user-agent'] as string
            if (parsed.referer) header.referer = parsed.referer as string
            return header
        }
        return undefined
    })
}

interface FormOptions {
    cookie?: string
    referer?: string
    userAgent?: string
    authorization?: string
}

export const buildDefaultOptionsFromCurl = (form: FormOptions, headers: (Record<string, string> | undefined)[] = []): FormOptions => {
    const firstNonNullHeader = headers.find((elem) => elem)
    if (firstNonNullHeader) {
        form.cookie = !form.cookie && firstNonNullHeader.cookie ? firstNonNullHeader.cookie : form.cookie
        form.referer = !form.referer && firstNonNullHeader.referer ? firstNonNullHeader.referer : form.referer
        form.userAgent = !form.userAgent && firstNonNullHeader['user-agent'] ? firstNonNullHeader['user-agent'] : form.userAgent
        form.authorization = !form.authorization && firstNonNullHeader.authorization ? firstNonNullHeader.authorization : form.authorization
    }
    return form
}
