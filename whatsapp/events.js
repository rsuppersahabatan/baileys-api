import { getAggregateVotesInPollMessage, proto } from '@innovatorssoft/baileys'
import { config } from '../config.js'
import { attachBase64Media, isMediaMessage } from './media.js'
import { notify } from './webhook.js'

/**
 * `@innovatorssoft/baileys` ships as CommonJS and its build does not re-export
 * `WAMessageStatus` as a named export, so it is read off the proto enum — the
 * same object the library uses internally.
 */
const WAMessageStatus = proto.WebMessageInfo.Status

/**
 * Socket events forwarded to the webhook untouched, mapped to the event name
 * published in the payload. Keeping them in a table means adding a new
 * pass-through event is a one-line change instead of another copy-pasted
 * listener.
 */
const PASSTHROUGH_EVENTS = {
    'chats.set': 'CHATS_SET',
    'chats.upsert': 'CHATS_UPSERT',
    'chats.delete': 'CHATS_DELETE',
    'chats.update': 'CHATS_UPDATE',
    'labels.association': 'LABELS_ASSOCIATION',
    'labels.edit': 'LABELS_EDIT',
    'messages.delete': 'MESSAGES_DELETE',
    'messages.reaction': 'MESSAGES_REACTION',
    'messages.media-update': 'MESSAGES_MEDIA_UPDATE',
    'messaging-history.set': 'MESSAGING_HISTORY_SET',
    'groups.upsert': 'GROUPS_UPSERT',
    'groups.update': 'GROUPS_UPDATE',
    'group-participants.update': 'GROUP_PARTICIPANTS_UPDATE',
    'blocklist.set': 'BLOCKLIST_SET',
    'blocklist.update': 'BLOCKLIST_UPDATE',
    'contacts.set': 'CONTACTS_SET',
    'contacts.upsert': 'CONTACTS_UPSERT',
    'contacts.update': 'CONTACTS_UPDATE',
    'presence.update': 'PRESENCE_UPDATE',
}

/**
 * Turn a raw status code into the readable name the API exposes, and inline any
 * media the webhook asked for.
 */
const prepareIncomingMessage = async (socket, message) => {
    try {
        if (message.status) {
            message.status = WAMessageStatus[message.status] ?? 'UNKNOWN'
        }

        if (config.webhook.fileInBase64 && isMediaMessage(message)) {
            return await attachBase64Media(socket, message)
        }

        return message
    } catch (error) {
        console.error(`Could not prepare message ${message?.key?.id} for the webhook: ${error.message}`)

        return {}
    }
}

/**
 * `message-receipt.update` only carries the raw poll votes. When the receipt is
 * about a poll we look the poll up and resolve the tallies; every other receipt
 * is forwarded as-is.
 */
const resolvePollVotes = async (receipts, getMessage) => {
    for (const receipt of receipts) {
        const { key, update } = receipt

        if (!update?.pollUpdates) {
            continue
        }

        const pollCreation = await getMessage(key)

        if (!pollCreation) {
            continue
        }

        update.pollUpdates[0].vote = await getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: update.pollUpdates,
        })

        return [{ ...receipt, update }]
    }

    return receipts
}

/**
 * Wire every socket event to its webhook (and connection) side effect.
 *
 * @param {object} params
 * @param {object} params.socket             live Baileys socket
 * @param {string} params.sessionId          id the socket was created for
 * @param {Function} params.saveCreds        auth state writer
 * @param {Function} params.getMessage       store lookup used for retries and polls
 * @param {Function} params.onConnectionUpdate handler for `connection.update`
 */
export const registerEventHandlers = ({ socket, sessionId, saveCreds, getMessage, onConnectionUpdate }) => {
    socket.ev.on('creds.update', saveCreds)

    for (const [event, eventType] of Object.entries(PASSTHROUGH_EVENTS)) {
        socket.ev.on(event, (payload) => notify(sessionId, eventType, payload))
    }

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const incoming = messages.filter((message) => message.key.fromMe === false)

        if (incoming.length === 0) {
            return
        }

        const prepared = await Promise.all(incoming.map((message) => prepareIncomingMessage(socket, message)))

        await notify(sessionId, 'MESSAGES_UPSERT', prepared)
    })

    socket.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const message = await getMessage(key)

            if (!message) {
                continue
            }

            update.status = WAMessageStatus[update.status]

            await notify(sessionId, 'MESSAGES_UPDATE', [{ key, update, message }])
        }
    })

    socket.ev.on('message-receipt.update', async (receipts) => {
        await notify(sessionId, 'MESSAGES_RECEIPT_UPDATE', await resolvePollVotes(receipts, getMessage))
    })

    socket.ev.on('connection.update', onConnectionUpdate)
}
