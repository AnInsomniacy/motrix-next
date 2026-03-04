import { JSONRPCClient, JSONRPCClientOptions } from './JSONRPCClient'

export interface Aria2Options extends JSONRPCClientOptions {
    secret?: string
}

export class Aria2 extends JSONRPCClient {
    static override defaultOptions: Aria2Options = {
        ...JSONRPCClient.defaultOptions,
        secure: false,
        host: 'localhost',
        port: 16800,
        secret: '',
        path: '/jsonrpc',
    }

    constructor(options: Aria2Options = {}) {
        super({ ...Aria2.defaultOptions, ...options })
    }

    private prefix(str: string): string {
        if (!str.startsWith('system.') && !str.startsWith('aria2.')) {
            str = 'aria2.' + str
        }
        return str
    }

    private unprefix(str: string): string {
        const suffix = str.split('aria2.')[1]
        return suffix || str
    }

    private addSecret(parameters: unknown[]): unknown[] {
        let params: unknown[] = this.secret ? ['token:' + this.secret] : []
        if (Array.isArray(parameters)) {
            params = params.concat(parameters)
        }
        return params
    }

    protected override _onnotification(notification: { method?: string; params?: unknown[] }): void {
        const { method, params } = notification
        if (!method) return
        const event = this.unprefix(method)
        if (event !== method) this.emit(event, params)
        super._onnotification(notification as never)
    }

    override async call(method: string, ...params: unknown[]): Promise<unknown> {
        return super.call(this.prefix(method), this.addSecret(params))
    }

    async multicall(calls: [string, ...unknown[]][]): Promise<unknown> {
        const multi = [
            calls.map(([method, ...params]) => {
                return { methodName: this.prefix(method), params: this.addSecret(params) }
            }),
        ]
        return super.call('system.multicall', multi)
    }

    override async batch(calls: [string, ...unknown[]][]): Promise<Promise<unknown>[]> {
        return super.batch(
            calls.map(([method, ...params]) => [
                this.prefix(method),
                ...this.addSecret(params),
            ] as [string, ...unknown[]])
        )
    }

    async listNotifications(): Promise<string[]> {
        const events = (await this.call('system.listNotifications')) as string[]
        return events.map((event) => this.unprefix(event))
    }

    async listMethods(): Promise<string[]> {
        const methods = (await this.call('system.listMethods')) as string[]
        return methods.map((method) => this.unprefix(method))
    }
}
