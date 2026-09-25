import pino from 'pino'

/**
 * Baileys is extremely chatty on `info`/`debug`, so its logger is silenced by
 * default. Set `LOG_LEVEL=debug` when troubleshooting a connection.
 */
export const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })
