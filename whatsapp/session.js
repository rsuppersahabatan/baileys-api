import { mkdirSync, readdirSync, rmSync } from 'fs'
import NodeCache from 'node-cache'
import { toDataURL } from 'qrcode'
import {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeWASocket,
    useMultiFileAuthState,
} from '@innovatorssoft/baileys'
import { authDir, config, ensureSessionsDir, storeFile } from '../config.js'
import { logger } from '../logger.js'
import response from '../response.js'
import makeInMemoryStore from '../store/memory-store.js'
import { getStoredMessageContent } from './actions.js'
import { registerEventHandlers } from './events.js'
import * as registry from './registry.js'
import { forgetSession as forgetScheduledJobs } from './scheduler.js'
import { notify } from './webhook.js'

/** Shared retry counter for failed message decryptions, as required by Baileys. */
const msgRetryCounterCache = new NodeCache()

/** Answer the pending HTTP request, unless it has already been answered. */
const respond = (res, ...args) => {
    if (res) {
        response(res, ...args)
    }
}

const quietly = async (operation) => {
    try {
        await operation()
    } catch {
        // The socket is usually already closed by the time we get here.
    }
}

/**
 * Forget a session's credentials without taking its directory with it.
 *
 * `rm -rf` on the auth directory is what broke session creation in production:
 * `useMultiFileAuthState` mkdirs its folder exactly once, at setup, while
 * `saveCreds` and `keys.set` only `writeFile` into it. Deleting the directory
 * therefore left the still-attached `creds.update` listener writing to a path
 * that no longer existed, and every such write threw the ENOENT this had to fix.
 *
 * Removing the *contents* and recreating the directory keeps both sides happy:
 * an auth directory with no `creds.json` means "not registered" to Baileys, so
 * the credentials really are gone (a later `useMultiFileAuthState` calls
 * `initAuthCreds()` and starts a fresh, unregistered state), and there is always
 * a directory for an in-flight write to land in.
 */
const unlinkAuthDir = (sessionId) => {
    rmSync(authDir(sessionId), { force: true, recursive: true })
    mkdirSync(authDir(sessionId), { recursive: true })
}

const buildStore = (sessionId) => {
    return makeInMemoryStore({
        preserveDataDuringSync: true,
        backupBeforeSync: false,
        incrementalSave: true,
        maxMessagesPerChat: config.store.maxMessagesPerChat,
        autoSaveInterval: config.store.autoSaveInterval,
        storeFile: storeFile(sessionId),
    })
}

const buildSocket = async (sessionId) => {
    const store = buildStore(sessionId)
    const { state, saveCreds } = await useMultiFileAuthState(authDir(sessionId))
    const { version, isLatest } = await fetchLatestBaileysVersion()

    console.log(`Session "${sessionId}" using WA v${version.join('.')} (latest: ${isLatest})`)

    await store.readFromFile(storeFile(sessionId))

    const socket = makeWASocket({
        version,
        printQRInTerminal: false,
        mobile: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: config.linkPreview,
        getMessage: (key) => getStoredMessageContent(store, key),
    })

    // Controllers reach the store through the socket, so keep the two together.
    socket.store = store
    store.bind(socket.ev)

    return { socket, saveCreds }
}

const requestPairingCode = async (socket, res, phoneNumber) => {
    if (socket.authState.creds.account) {
        return respond(res, 409, false, 'Session is already registered.')
    }

    await socket.waitForConnectionUpdate((update) => Boolean(update.qr))

    const code = await socket.requestPairingCode(phoneNumber)

    if (code === undefined) {
        return respond(res, 500, false, 'Unable to create session.')
    }

    respond(res, 200, true, 'Verify on your phone and enter the provided code.', { code })
}

/**
 * Can this QR still be handed to whoever asked for a session?
 *
 * `POST /sessions/add` answers exactly once, so the only chance to deliver a QR
 * is while that request is still open. Once it has been answered there is no
 * channel left: WhatsApp rotates the QR about once a minute, and a rotated
 * code can only be shown to a client that is still waiting for one.
 *
 * `false` therefore means the login attempt is dead — either the first QR was
 * shown and never scanned before it rotated, or the session was recovered at
 * boot and nobody ever asked for a QR.
 */
export const canDeliverQr = (res) => Boolean(res) && !res.headersSent

/**
 * Decide what to do with a QR that WhatsApp just emitted.
 *
 * - `ignore` — a pairing-code session is not waiting for a QR at all, so a
 *   rotation says nothing about whether the login is still alive.
 * - `deliver` — a request is still open, so hand this QR to it.
 * - `drop` — nobody can receive this QR any more, so the login attempt is dead.
 */
export const qrOutcome = ({ expectsQr, res }) => {
    if (!expectsQr) {
        return 'ignore'
    }

    return canDeliverQr(res) ? 'deliver' : 'drop'
}

/**
 * Drop a session whose QR nobody could receive any more.
 *
 * Leaving it registered would be worse than deleting it: the client keeps
 * showing a QR that WhatsApp has already invalidated, and `/sessions/status`
 * would keep reporting a session that can never finish logging in.
 */
const abandonUnscannedSession = async ({ socket, sessionId }) => {
    console.log(`Session "${sessionId}" was not scanned before its QR rotated, dropping it.`)

    await quietly(() => socket.logout())
    await deleteSession(sessionId)
}

const handleQr = async ({ socket, sessionId, res, expectsQr, update }) => {
    const outcome = qrOutcome({ expectsQr, res })

    if (outcome === 'ignore') {
        return
    }

    if (outcome === 'drop') {
        return abandonUnscannedSession({ socket, sessionId })
    }

    await notify(sessionId, 'QRCODE_UPDATED', update)

    try {
        const qrcode = await toDataURL(update.qr)

        respond(res, 200, true, 'QR code received, please scan the QR code.', { qrcode })
    } catch {
        // Encoding failed, so this QR is unusable too — the caller must not be
        // left waiting, and the session has nothing left to show.
        respond(res, 500, false, 'Unable to create QR code.')

        await abandonUnscannedSession({ socket, sessionId })
    }
}

const handleDisconnect = async ({ sessionId, res, statusCode }) => {
    const loggedOut = statusCode === DisconnectReason.loggedOut
    const willRetry = !loggedOut && registry.shouldReconnect(sessionId)

    if (!willRetry) {
        respond(res, 500, false, 'Unable to create session.')

        return deleteSession(sessionId)
    }

    // `restartRequired` means the stream has to be rebuilt straight away.
    const wait = statusCode === DisconnectReason.restartRequired ? 0 : config.reconnectInterval

    setTimeout(() => {
        // The previous session may have been deleted during the wait, and
        // `rmSync` on the auth directory is recursive — recreate the root so the
        // reconnect is not the thing that discovers the directory is gone.
        ensureSessionsDir()

        createSession(sessionId, { res }).catch((error) => {
            console.error(`Could not reconnect session "${sessionId}": ${error.message}`)
        })
    }, wait)
}

const handleConnectionUpdate = async ({ socket, sessionId, res, expectsQr, update }) => {
    const { connection, lastDisconnect, qr } = update

    await notify(sessionId, 'CONNECTION_UPDATE', update)

    if (connection === 'open') {
        registry.resetRetries(sessionId)

        return
    }

    if (connection === 'close') {
        return handleDisconnect({
            sessionId,
            res,
            statusCode: lastDisconnect?.error?.output?.statusCode,
        })
    }

    if (qr) {
        return handleQr({ socket, sessionId, res, expectsQr, update })
    }
}

/**
 * Create a socket for `sessionId` and register everything it needs.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @param {import('express').Response|null} [options.res] pending request, answered with the QR or pairing code
 * @param {boolean} [options.usePairingCode] authenticate with an 8 digit code instead of a QR
 * @param {string} [options.phoneNumber] required when `usePairingCode` is set
 */
export const createSession = async (sessionId, { res = null, usePairingCode = false, phoneNumber = '' } = {}) => {
    const { socket, saveCreds } = await buildSocket(sessionId)

    registry.addSession(sessionId, socket)

    // Has to happen before the event handlers are attached, otherwise the first
    // QR would be answered instead of the pairing code the caller asked for.
    if (usePairingCode && !socket.authState.creds.registered) {
        await requestPairingCode(socket, res, phoneNumber)
    }

    // A pairing-code session is never shown a QR, so its QR rotations must not
    // be mistaken for an unscanned login. A reconnect keeps the QR rules, which
    // is deliberate: a dropped pairing connection leaves the issued code stale,
    // so the session is better off being cleaned up.
    const expectsQr = !usePairingCode

    registerEventHandlers({
        socket,
        sessionId,
        saveCreds,
        getMessage: (key) => getStoredMessageContent(socket.store, key),
        onConnectionUpdate: (update) => handleConnectionUpdate({ socket, sessionId, res, expectsQr, update }),
    })
}

/** Tear the session down and delete every file it left behind. */
export const deleteSession = async (sessionId) => {
    const socket = registry.getSession(sessionId)

    if (socket) {
        // Without this the store keeps auto-saving and would recreate the very
        // file we are about to remove.
        socket.store?.dispose()

        // Detach every listener *before* the files go. `creds.update` is wired
        // straight to `saveCreds`, so a socket that is still winding down would
        // otherwise keep writing an auth directory that no longer exists —
        // exactly the ENOENT this teardown used to produce.
        socket.ev?.removeAllListeners()

        await quietly(() => socket.end?.())
        await quietly(() => socket.ws?.close())
    }

    // Nothing can write to the session after this point, so it is safe to
    // unregister it — and the background helpers that look sessions up by id
    // (the scheduler's timer, above all) must stop finding it before the files
    // disappear rather than after.
    registry.forgetSession(sessionId)

    // Queued messages belong to the session that queued them, so they go with
    // it — otherwise they would sit in the list forever, unsendable.
    await forgetScheduledJobs(sessionId)

    for (const path of [storeFile(sessionId), `${storeFile(sessionId)}.backup`]) {
        rmSync(path, { force: true, recursive: true })
    }

    unlinkAuthDir(sessionId)
}

/** Log the session out of WhatsApp, then remove every trace of it. */
export const logoutSession = async (sessionId) => {
    const socket = registry.getSession(sessionId)

    if (socket) {
        // `logout()` emits `creds.update`, so the destination has to exist
        // before it runs and must outlive the call. `deleteSession` is what
        // removes it, and only afterwards.
        ensureSessionsDir()

        await quietly(() => socket.logout())
    }

    await deleteSession(sessionId)
}

/** Bring back every session that still has credentials on disk. */
export const restoreSessions = () => {
    const root = ensureSessionsDir()
    const { sessionPrefix } = config

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(sessionPrefix)) {
            continue
        }

        const sessionId = entry.name.slice(sessionPrefix.length)

        console.log(`Recovering session "${sessionId}"`)

        createSession(sessionId).catch((error) => {
            console.error(`Could not recover session "${sessionId}": ${error.message}`)
        })
    }
}

/** Flush every message store to disk so a restart does not lose cached chats. */
export const cleanup = async () => {
    console.log('Running cleanup before exit.')

    const writes = registry.listSessionEntries().map(async ([sessionId, socket]) => {
        try {
            await socket.store?.writeToFile(storeFile(sessionId))
        } catch (error) {
            console.error(`Could not persist the store of "${sessionId}": ${error.message}`)
        } finally {
            socket.store?.dispose()
        }
    })

    await Promise.allSettled(writes)
}
