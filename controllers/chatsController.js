import { config } from '../config.js'
import { AppError } from '../errors.js'
import response from '../response.js'
import { validateMediaUrl } from '../utils/functions.js'
import {
    getStoredMessage,
    getChatList,
    isJidExists,
    readMessages,
    sendMessage,
    sendMessageWithTyping,
    sendPresenceUpdate,
} from '../whatsapp/actions.js'
import { toJid } from '../whatsapp/jid.js'
import { downloadMessageMedia } from '../whatsapp/media.js'
import { getSession } from '../whatsapp/registry.js'

/**
 * Chat endpoints.
 *
 * Handlers are deliberately thin: they read the request, call into
 * `whatsapp/actions.js`, and answer. There is no `try/catch` around the socket
 * calls because Express 5 forwards a rejection from an `async` handler to the
 * error middleware in `routes.js` on its own, and that middleware knows how to
 * turn an `AppError` into a response. Wrapping each call here only meant the
 * real reason for a failure was replaced with a generic 500.
 */

/** Message keys the API accepts a `url` for. */
const MEDIA_MESSAGE_TYPES = ['image', 'video', 'audio', 'document', 'sticker']

const getList = (req, res) => {
    return response(res, 200, true, '', getChatList(getSession(res.locals.sessionId)))
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { message } = req.body
    const isGroup = req.body.isGroup ?? false
    const receiver = toJid(req.body.receiver, isGroup)

    if (!(await isJidExists(session, receiver, isGroup))) {
        throw new AppError('The receiver number is not exists.', { status: 400, code: 'RECEIVER_NOT_FOUND' })
    }

    const invalidMedia = validateMediaUrl(message, MEDIA_MESSAGE_TYPES)

    if (invalidMedia) {
        throw new AppError(invalidMedia, { status: 400, code: 'INVALID_MEDIA_URL' })
    }

    await sendMessageWithTyping(session, receiver, message, { typing: req.body.typing })

    response(res, 200, true, 'The message has been successfully sent.')
}

/**
 * Send one message to each entry of the request body.
 *
 * A per-entry failure is collected rather than thrown: a bulk of twenty
 * recipients where one number is dead should still deliver nineteen. Only a
 * malformed request — an empty list, or more recipients than the ceiling allows
 * — is rejected outright, and it is rejected *before* anything is sent so a
 * caller cannot end up with half a broadcast and no way to tell.
 */
const sendBulk = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const recipients = req.body

    if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new AppError('The message list is empty.', { status: 400, code: 'BULK_EMPTY' })
    }

    if (recipients.length > config.send.maxBulkRecipients) {
        throw new AppError(
            `A bulk request carries at most ${config.send.maxBulkRecipients} recipients, got ${recipients.length}.`,
            { status: 400, code: 'BULK_TOO_LARGE' },
        )
    }

    const errors = []

    for (const [index, entry] of recipients.entries()) {
        const { message, typing, delay } = entry ?? {}

        if (!entry?.receiver || !message) {
            errors.push({ key: index, message: 'The receiver number is not exists.' })
            continue
        }

        const isGroup = entry.isGroup ?? false
        const receiver = toJid(entry.receiver, isGroup)

        try {
            if (!(await isJidExists(session, receiver, isGroup))) {
                errors.push({ key: index, message: 'number not exists on whatsapp' })
                continue
            }

            // `delay` is a floor for this one send; the send throttle spaces
            // everything else out on its own.
            await sendMessageWithTyping(session, receiver, message, { typing }, delay)
        } catch (error) {
            errors.push({ key: index, message: error.message })
        }
    }

    if (errors.length === 0) {
        return response(res, 200, true, 'All messages has been successfully sent.')
    }

    const allFailed = errors.length === recipients.length

    response(
        res,
        allFailed ? 500 : 200,
        !allFailed,
        allFailed ? 'Failed to send all messages.' : 'Some messages has been successfully sent.',
        { errors },
    )
}

const deleteChat = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { receiver, isGroup, message } = req.body

    await sendMessage(session, toJid(receiver, isGroup), { delete: message })

    response(res, 200, true, 'Message has been successfully deleted.')
}

const forward = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { forward: source, receiver, isGroup } = req.body
    const { id, remoteJid } = source
    const message = getStoredMessage(session, remoteJid, id)

    if (!message) {
        throw new AppError('The message to forward was not found.', { status: 404, code: 'MESSAGE_NOT_FOUND' })
    }

    await sendMessage(session, toJid(receiver, isGroup), { forward: message })

    response(res, 200, true, 'The message has been successfully forwarded.')
}

const read = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { keys } = req.body

    if (!keys?.[0]?.id) {
        throw new AppError('Data not found', { status: 400, code: 'KEYS_REQUIRED' })
    }

    await readMessages(session, keys)

    response(res, 200, true, 'The message has been successfully marked as read.')
}

const sendPresence = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { receiver, isGroup, presence } = req.body

    await sendPresenceUpdate(session, presence, toJid(receiver, isGroup))

    response(res, 200, true, 'Presence has been successfully sent.')
}

const downloadMedia = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { remoteJid, messageId } = req.body
    const message = getStoredMessage(session, remoteJid, messageId)

    if (!message) {
        throw new AppError('The message was not found.', { status: 404, code: 'MESSAGE_NOT_FOUND' })
    }

    try {
        const media = await downloadMessageMedia(session, message)

        response(res, 200, true, 'Message downloaded successfully', media)
    } catch (cause) {
        // `downloadMediaMessage` rejects with whatever the socket produced, which
        // is rarely something a caller can act on — so it is replaced with an
        // explanation of the two ways this normally fails.
        throw new AppError(
            'Error downloading multimedia message: it may not exist or may not contain multimedia content.',
            { status: 500, code: 'MEDIA_DOWNLOAD_FAILED', cause },
        )
    }
}

/**
 * Conversation history of a chat, newest first.
 *
 * `cursorId` pages backwards from a known message id, which is the only cursor
 * the store can resolve reliably.
 *
 * @param {boolean} defaultIsGroup used by the group routes, where the jid is
 *   always a group even though the query string does not say so.
 */
const getMessages =
    (defaultIsGroup = false) =>
    async (req, res) => {
        const session = getSession(res.locals.sessionId)
        const { jid } = req.params
        const { limit = 25, cursorId = null, cursorFromMe = null } = req.query
        const isGroup = req.query.isGroup === undefined ? defaultIsGroup : req.query.isGroup === 'true'

        const cursor = cursorId ? { before: { id: cursorId, fromMe: cursorFromMe === 'true' } } : {}

        const messages = await session.store.loadMessages(toJid(jid, isGroup), {
            limit: Number.parseInt(limit, 10) || 25,
            ...cursor,
        })

        response(res, 200, true, '', messages)
    }

export { getList, send, sendBulk, deleteChat, read, forward, sendPresence, downloadMedia, getMessages }
