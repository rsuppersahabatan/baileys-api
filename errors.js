/**
 * Error carrying an HTTP status and a machine-readable code.
 *
 * Controllers can translate these straight into a response instead of guessing
 * from a bare rejection, and the terminal error handler in `routes.js` knows
 * how much detail is safe to expose to the client.
 */
export class AppError extends Error {
    constructor(message, { status = 500, code = 'INTERNAL_ERROR', cause } = {}) {
        super(message, cause ? { cause } : undefined)
        this.name = 'AppError'
        this.status = status
        this.code = code
    }
}

export const badRequest = (message, code = 'BAD_REQUEST') => new AppError(message, { status: 400, code })

export const notFound = (message, code = 'NOT_FOUND') => new AppError(message, { status: 404, code })

export const conflict = (message, code = 'CONFLICT') => new AppError(message, { status: 409, code })

/**
 * Run a Baileys operation, rethrowing any failure as an `AppError` that keeps
 * the original error as `cause`. Used to give every socket call a message that
 * means something to the API consumer.
 */
export const runOperation = async (operation, message, code = 'WHATSAPP_ERROR') => {
    try {
        return await operation()
    } catch (cause) {
        if (cause instanceof AppError) {
            throw cause
        }

        throw new AppError(message, { code, cause })
    }
}

/** Resolve to `fallback` instead of throwing — for optional data like a profile picture. */
export const ignoreFailure = async (operation, fallback = null) => {
    try {
        return await operation()
    } catch {
        return fallback
    }
}
