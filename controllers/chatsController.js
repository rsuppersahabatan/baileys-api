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

    try {
        if (!(await isJidExists(session, receiver, isGroup))) {
            return response(res, 400, false, 'The receiver number is not exists.')
        }

        const invalidMedia = validateMediaUrl(message, MEDIA_MESSAGE_TYPES)

        if (invalidMedia) {
            return response(res, 400, false, invalidMedia)
        }

        await sendMessageWithTyping(session, receiver, message, { typing: req.body.typing }, 0)

        response(res, 200, true, 'The message has been successfully sent.')
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

const sendBulk = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const recipients = req.body

    if (!Array.isArray(recipients) || recipients.length === 0) {
        return response(res, 400, false, 'The message list is empty.')
    }

    const errors = []

    for (const [index, entry] of recipients.entries()) {
        const { message } = entry

        if (!entry.receiver || !message) {
            errors.push({ key: index, message: 'The receiver number is not exists.' })
            continue
        }

        const delay = !entry.delay || Number.isNaN(Number(entry.delay)) ? 1000 : entry.delay
        const receiver = toJid(entry.receiver)

        try {
            if (!(await isJidExists(session, receiver))) {
                errors.push({ key: index, message: 'number not exists on whatsapp' })
                continue
            }

            await sendMessageWithTyping(session, receiver, message, { typing: entry.typing }, delay)
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

    try {
        await sendMessage(session, toJid(receiver, isGroup), { delete: message })

        response(res, 200, true, 'Message has been successfully deleted.')
    } catch {
        response(res, 500, false, 'Failed to delete message .')
    }
}

const forward = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { forward: source, receiver, isGroup } = req.body
    const { id, remoteJid } = source

    try {
        const message = getStoredMessage(session, remoteJid, id)

        if (!message) {
            return response(res, 404, false, 'The message to forward was not found.')
        }

        await sendMessage(session, toJid(receiver, isGroup), { forward: message }, {}, 0)

        response(res, 200, true, 'The message has been successfully forwarded.')
    } catch {
        response(res, 500, false, 'Failed to forward the message.')
    }
}

const read = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { keys } = req.body

    if (!keys?.[0]?.id) {
        return response(res, 400, false, 'Data not found')
    }

    try {
        await readMessages(session, keys)

        response(res, 200, true, 'The message has been successfully marked as read.')
    } catch {
        response(res, 500, false, 'Failed to mark the message as read.')
    }
}

const sendPresence = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { receiver, isGroup, presence } = req.body

    try {
        await sendPresenceUpdate(session, presence, toJid(receiver, isGroup))

        response(res, 200, true, 'Presence has been successfully sent.')
    } catch {
        response(res, 500, false, 'Failed to send presence.')
    }
}

const downloadMedia = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { remoteJid, messageId } = req.body

    try {
        const message = getStoredMessage(session, remoteJid, messageId)

        if (!message) {
            return response(res, 404, false, 'The message was not found.')
        }

        const media = await downloadMessageMedia(session, message)

        response(res, 200, true, 'Message downloaded successfully', media)
    } catch {
        response(
            res,
            500,
            false,
            'Error downloading multimedia message: it may not exist or may not contain multimedia content.',
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

        try {
            const messages = await session.store.loadMessages(toJid(jid, isGroup), {
                limit: Number.parseInt(limit, 10) || 25,
                ...cursor,
            })

            response(res, 200, true, '', messages)
        } catch {
            response(res, 500, false, 'Failed to load messages.')
        }
    }

export { getList, send, sendBulk, deleteChat, read, forward, sendPresence, downloadMedia, getMessages }
