import 'dotenv/config'
import { join } from 'path'
import __dirname from './dirname.js'

const toInt = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10)

    return Number.isNaN(parsed) ? fallback : parsed
}

const toBool = (value, fallback = false) => {
    if (value === undefined || value === '') {
        return fallback
    }

    return value === 'true'
}

const toList = (value) => {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
}

/**
 * Prefix used for the on-disk auth directories (`sessions/md_<sessionId>`).
 * Kept in one place because both the recovery scan and the auth state writer
 * have to agree on it.
 */
const SESSION_PREFIX = 'md_'

/**
 * Every environment variable the app reads, parsed once at startup so a missing
 * or malformed value degrades to a documented default instead of crashing on
 * first use.
 */
export const config = {
    host: process.env.HOST || undefined,
    port: toInt(process.env.PORT, 8000),
    authToken: process.env.AUTHENTICATION_GLOBAL_AUTH_TOKEN || null,
    maxRetries: toInt(process.env.MAX_RETRIES, -1),
    reconnectInterval: toInt(process.env.RECONNECT_INTERVAL, 5000),
    sessionPrefix: SESSION_PREFIX,
    /**
     * Baileys' `generateHighQualityLinkPreview`. Kept behind a flag because it
     * makes the server fetch every link it sees in an incoming message, and the
     * `link-preview-js` release it ships with has an unfixed SSRF advisory.
     * Turn it off when this API is reachable by untrusted callers.
     */
    linkPreview: toBool(process.env.GENERATE_HIGH_QUALITY_LINK_PREVIEW, true),
    webhook: {
        url: process.env.APP_WEBHOOK_URL || null,
        allowedEvents: toList(process.env.APP_WEBHOOK_ALLOWED_EVENTS),
        fileInBase64: toBool(process.env.APP_WEBHOOK_FILE_IN_BASE64),
    },
    store: {
        maxMessagesPerChat: toInt(process.env.MAX_MESSAGES_PER_CHAT, 150),
        autoSaveInterval: toInt(process.env.STORE_AUTOSAVE_INTERVAL, 10000),
    },
}

export const sessionsDir = (name = '') => join(__dirname, 'sessions', name)

/** Directory holding the multi-file auth state for a session. */
export const authDir = (sessionId) => sessionsDir(`${SESSION_PREFIX}${sessionId}`)

/** Path of the serialized message store for a session. */
export const storeFile = (sessionId) => sessionsDir(`${sessionId}_store.json`)
