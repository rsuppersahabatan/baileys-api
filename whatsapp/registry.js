import { config } from '../config.js'

/** Live sockets, keyed by session id. */
const sessions = new Map()

/** Reconnect attempt counter per session, reset once a connection opens. */
const retries = new Map()

export const hasSession = (sessionId) => sessions.has(sessionId)

export const getSession = (sessionId) => sessions.get(sessionId) ?? null

export const addSession = (sessionId, socket) => {
    sessions.set(sessionId, socket)
}

export const listSessions = () => [...sessions.keys()]

export const listSessionEntries = () => [...sessions.entries()]

export const forgetSession = (sessionId) => {
    sessions.delete(sessionId)
    retries.delete(sessionId)
}

export const isSessionConnected = (sessionId) => {
    return getSession(sessionId)?.ws?.socket?.readyState === 1
}

/**
 * Is the session actually logged in, rather than merely holding an open socket?
 *
 * `isSessionConnected` only checks that the websocket is open, which is also
 * true while a QR code is still waiting to be scanned — baileys opens the socket
 * before the login finishes. Anything that needs a usable account has to ask
 * this instead.
 */
export const isSessionLoggedIn = (sessionId) => {
    return isSessionConnected(sessionId) && getSession(sessionId)?.authState?.creds?.registered === true
}

export const resetRetries = (sessionId) => {
    retries.delete(sessionId)
}

/**
 * Decide whether a dropped connection should be retried.
 *
 * `maxRetries` of `-1` means retry forever, `0` means never. The counter is
 * incremented here so the caller only has to act on the boolean.
 */
export const shouldReconnect = (sessionId) => {
    const { maxRetries } = config

    if (maxRetries === 0) {
        return false
    }

    const attempts = retries.get(sessionId) ?? 0

    if (maxRetries !== -1 && attempts >= maxRetries) {
        return false
    }

    retries.set(sessionId, attempts + 1)
    console.log(`Reconnecting session "${sessionId}" (attempt ${attempts + 1})`)

    return true
}
