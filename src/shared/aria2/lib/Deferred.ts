const DEFAULT_TIMEOUT = 15000

export class Deferred<T = unknown> {
    settled = false
    promise: Promise<T>
    resolve!: (value: T) => void
    reject!: (reason?: unknown) => void
    private _timer?: ReturnType<typeof setTimeout>

    constructor(timeout = DEFAULT_TIMEOUT, onTimeout?: () => void) {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = (value: T) => {
                if (this.settled) return
                this.settled = true
                clearTimeout(this._timer)
                resolve(value)
            }
            this.reject = (reason?: unknown) => {
                if (this.settled) return
                this.settled = true
                clearTimeout(this._timer)
                reject(reason)
            }
        })
        if (timeout > 0) {
            this._timer = setTimeout(() => {
                this.reject(new Error('RPC request timed out'))
                if (onTimeout) onTimeout()
            }, timeout)
        }
    }
}
