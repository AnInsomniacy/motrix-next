export class JSONRPCError extends Error {
    code: number
    data?: unknown

    constructor({ message, code, data }: { message: string; code: number; data?: unknown }) {
        super(message)
        this.code = code
        if (data) this.data = data
        this.name = this.constructor.name
    }
}
