import { existsSync, readdirSync, rmSync } from 'fs'
import NodeCache from 'node-cache'
import { toDataURL } from 'qrcode'
import {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeWASocket,
    useMultiFileAuthState,
} from '@innovatorssoft/baileys'
import { authDir, config, sessionsDir, storeFile } from '../config.js'
import { logger } from '../logger.js'
import response from '../response.js'
import makeInMemoryStore from '../store/memory-store.js'
import { getStoredMessageContent } from './actions.js'
import { registerEventHandlers } from './events.js'
import * as registry from './registry.js'
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
        generateHighQualityLinkPreview: true,
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

const handleQr = async ({ socket, sessionId, res, update }) => {
    await notify(sessionId, 'QRCODE_UPDATED', update)

    if (res && !res.headersSent) {
        try {
            const qrcode = await toDataURL(update.qr)

            respond(res, 200, true, 'QR code received, please scan the QR code.', { qrcode })

            return
        } catch {
            respond(res, 500, false, 'Unable to create QR code.')
        }
    }

    // Nobody is waiting for this QR: the request that asked for it has already
    // been answered (the code was shown but never scanned) or the session was
    // recovered at boot. Either way this login attempt is dead, so drop it.
    await quietly(() => socket.logout())
    await deleteSession(sessionId)
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
        createSession(sessionId, { res }).catch((error) => {
            console.error(`Could not reconnect session "${sessionId}": ${error.message}`)
        })
    }, wait)
}

const handleConnectionUpdate = async ({ socket, sessionId, res, update }) => {
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
        return handleQr({ socket, sessionId, res, update })
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

    registerEventHandlers({
        socket,
        sessionId,
        saveCreds,
        getMessage: (key) => getStoredMessageContent(socket.store, key),
        onConnectionUpdate: (update) => handleConnectionUpdate({ socket, sessionId, res, update }),
    })
}

/** Tear the session down and delete every file it left behind. */
export const deleteSession = async (sessionId) => {
    const socket = registry.getSession(sessionId)

    if (socket) {
        // Without this the store keeps auto-saving and would recreate the very
        // file we are about to remove.
        socket.store?.dispose()

        await quietly(() => socket.end?.())
        await quietly(() => socket.ws?.close())
    }

    const paths = [authDir(sessionId), storeFile(sessionId), `${storeFile(sessionId)}.backup`]

    for (const path of paths) {
        rmSync(path, { force: true, recursive: true })
    }

    registry.forgetSession(sessionId)
}

/** Log the session out of WhatsApp, then remove every trace of it. */
export const logoutSession = async (sessionId) => {
    const socket = registry.getSession(sessionId)

    if (socket) {
        await quietly(() => socket.logout())
    }

    await deleteSession(sessionId)
}

/** Bring back every session that still has credentials on disk. */
export const restoreSessions = () => {
    const root = sessionsDir()

    if (!existsSync(root)) {
        return
    }

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
