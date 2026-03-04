type Listener = (...args: unknown[]) => void

export class EventEmitter {
    private _listeners: Record<string, Listener[]> = {}

    on(event: string, fn: Listener): this {
        if (!this._listeners[event]) this._listeners[event] = []
        this._listeners[event].push(fn)
        return this
    }

    addListener(event: string, fn: Listener): this {
        return this.on(event, fn)
    }

    off(event: string, fn: Listener): this {
        const list = this._listeners[event]
        if (!list) return this
        this._listeners[event] = list.filter((f) => f !== fn)
        return this
    }

    removeListener(event: string, fn: Listener): this {
        return this.off(event, fn)
    }

    emit(event: string, ...args: unknown[]): boolean {
        const list = this._listeners[event]
        if (!list || list.length === 0) return false
        for (const fn of list) fn(...args)
        return true
    }

    removeAllListeners(event?: string): this {
        if (event) {
            delete this._listeners[event]
        } else {
            this._listeners = {}
        }
        return this
    }
}
