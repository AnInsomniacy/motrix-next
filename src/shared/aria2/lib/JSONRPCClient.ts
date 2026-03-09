/** @fileoverview JSON-RPC 2.0 WebSocket client with reconnection and batch support. */
import { EventEmitter } from './EventEmitter'
import { Deferred } from './Deferred'
import { JSONRPCError } from './JSONRPCError'
import { RPC_TIMEOUT } from '../../timing'

interface RPCMessage {
  method: string
  jsonrpc: string
  id: number
  params?: unknown[]
}

interface RPCResponse {
  id: number
  error?: { message: string; code: number; data?: unknown }
  result?: unknown
  method?: string
  params?: unknown[]
}

export interface JSONRPCClientOptions {
  secure?: boolean
  host?: string
  port?: number
  secret?: string
  path?: string
}

export class JSONRPCClient extends EventEmitter {
  secure: boolean
  host: string
  port: number
  secret: string
  path: string
  socket: WebSocket | null = null
  private deferreds: Record<number, Deferred> = Object.create(null)
  private lastId = 0

  static defaultOptions: JSONRPCClientOptions = {
    secure: false,
    host: 'localhost',
    port: 80,
    secret: '',
    path: '/jsonrpc',
  }

  constructor(options: JSONRPCClientOptions = {}) {
    super()
    const merged = { ...JSONRPCClient.defaultOptions, ...options }
    this.secure = merged.secure ?? false
    this.host = merged.host ?? 'localhost'
    this.port = merged.port ?? 80
    this.secret = merged.secret ?? ''
    this.path = merged.path ?? '/jsonrpc'
  }

  private id(): number {
    return this.lastId++
  }

  private url(protocol: string): string {
    return protocol + (this.secure ? 's' : '') + '://' + this.host + ':' + this.port + this.path
  }

  private websocketSend(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket!.send(JSON.stringify(message))
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }

  private async httpSend(message: unknown): Promise<Response> {
    const response = await fetch(this.url('http'), {
      method: 'POST',
      body: JSON.stringify(message),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    })

    response
      .json()
      .then((data) => this._onmessage(data as RPCResponse))
      .catch((err) => this.emit('error', err))

    return response
  }

  private _buildMessage(method: string, params?: unknown[]): RPCMessage {
    if (typeof method !== 'string') {
      throw new TypeError(method + ' is not a string')
    }

    const message: RPCMessage = {
      method,
      jsonrpc: '2.0',
      id: this.id(),
    }

    if (params) Object.assign(message, { params })
    return message
  }

  async batch(calls: [string, ...unknown[]][]): Promise<Promise<unknown>[]> {
    const message = calls.map(([method, ...params]) => {
      return this._buildMessage(method as string, params)
    })

    // Register deferreds BEFORE sending to prevent race with fast HTTP responses
    const promises = message.map(({ id }) => {
      const deferred = new Deferred(RPC_TIMEOUT, () => {
        delete this.deferreds[id]
      })
      this.deferreds[id] = deferred
      return deferred.promise
    })

    try {
      await this._send(message)
    } catch (err) {
      for (const { id } of message) {
        const deferred = this.deferreds[id]
        if (deferred) deferred.reject(err instanceof Error ? err : new Error(String(err)))
        delete this.deferreds[id]
      }
      throw err
    }

    return promises
  }

  async call(method: string, parameters?: unknown[]): Promise<unknown> {
    const message = this._buildMessage(method, parameters)
    const id = message.id

    // Register deferred BEFORE sending to prevent race with fast HTTP responses
    const deferred = new Deferred(RPC_TIMEOUT, () => {
      delete this.deferreds[id]
    })
    this.deferreds[id] = deferred

    try {
      await this._send(message)
    } catch (err) {
      deferred.reject(err instanceof Error ? err : new Error(String(err)))
      delete this.deferreds[id]
      throw err
    }

    return deferred.promise
  }

  private async _send(message: unknown): Promise<void | Response> {
    this.emit('output', message)

    const { socket } = this
    return socket && socket.readyState === 1 ? this.websocketSend(message) : this.httpSend(message)
  }

  private _onresponse({ id, error, result }: RPCResponse): void {
    const deferred = this.deferreds[id]
    if (!deferred) return
    if (error) deferred.reject(new JSONRPCError(error))
    else deferred.resolve(result)
    delete this.deferreds[id]
  }

  protected _onnotification({ method, params }: RPCResponse): void {
    if (method) this.emit(method, params)
  }

  private _onrequest({ method, params }: RPCResponse): void {
    if (method) this.emit('request', method, params)
  }

  private _onmessage = (message: RPCResponse | RPCResponse[]): void => {
    this.emit('input', message)

    if (Array.isArray(message)) {
      for (const object of message) {
        this._onobject(object)
      }
    } else {
      this._onobject(message)
    }
  }

  private _onobject(message: RPCResponse): void {
    if (message.method === undefined) this._onresponse(message)
    else if (message.id === undefined) this._onnotification(message)
    else this._onrequest(message)
  }

  private _rejectAllDeferreds(reason: string): void {
    const ids = Object.keys(this.deferreds)
    for (const id of ids) {
      const numId = Number(id)
      const deferred = this.deferreds[numId]
      if (deferred) deferred.reject(new Error(reason))
      delete this.deferreds[numId]
    }
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = (this.socket = new WebSocket(this.url('ws')))

      socket.onclose = (...args: unknown[]) => {
        this._rejectAllDeferreds('WebSocket closed')
        this.emit('close', ...args)
      }
      socket.onmessage = (event: MessageEvent) => {
        let message: RPCResponse | RPCResponse[]
        try {
          message = JSON.parse(event.data as string)
        } catch (err) {
          this.emit('error', err)
          return
        }
        this._onmessage(message)
      }
      socket.onopen = () => {
        this.emit('open')
        resolve()
      }
      socket.onerror = (err: unknown) => {
        this.emit('error', err)
        reject(err)
      }
    })
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      const { socket } = this
      if (!socket) {
        resolve()
        return
      }
      this.on('close', () => resolve())
      socket.close()
    })
  }
}
