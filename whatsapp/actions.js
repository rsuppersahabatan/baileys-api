import { delay } from '@innovatorssoft/baileys'
import { AppError, ignoreFailure, runOperation } from '../errors.js'
import { downloadToTempFile, removeFile } from '../utils/download.js'
import { GROUP_SUFFIX, USER_SUFFIX } from './jid.js'
import { resolveTypingDuration } from './typing.js'

/**
 * The only module that talks to Baileys.
 *
 * Every socket call the API exposes goes through a wrapper here so the library
 * can be swapped again (or upgraded) without touching a controller, and so all
 * of them fail with an `AppError` that carries a message worth returning to the
 * client.
 */

/** Send a message, optionally waiting first to stay under WhatsApp's rate limits. */
export const sendMessage = (socket, receiver, message, options = {}, delayMs = 1000) => {
    return runOperation(
        async () => {
            await delay(Number(delayMs))

            return socket.sendMessage(receiver, message, options)
        },
        'Failed to send the message.',
        'SEND_MESSAGE_FAILED',
    )
}

/**
 * Show "typing…" for `duration` ms, then clear it.
 *
 * WhatsApp clears the indicator by itself after a while, but doing it explicitly
 * keeps the pause from bleeding into whatever is sent next.
 */
export const sendTypingIndicator = async (socket, jid, duration) => {
    await sendPresenceUpdate(socket, 'composing', jid)

    try {
        await delay(duration)
    } finally {
        await ignoreFailure(() => sendPresenceUpdate(socket, 'paused', jid))
    }
}

/**
 * Send a message, preceded by a typing indicator when one is asked for.
 *
 * `typing` accepts `true` (derive a duration from the message text), a number of
 * milliseconds, or a `{ duration }` object. Anything falsy sends nothing extra,
 * so this is a drop-in replacement for `sendMessage`.
 */
export const sendMessageWithTyping = async (socket, receiver, message, options = {}, delayMs = 1000) => {
    const { typing = false, ...sendOptions } = options
    const duration = resolveTypingDuration(typing, message)

    if (duration !== null) {
        // The indicator is cosmetic, so a socket that refuses to show it must
        // not cost the caller their message. If the socket really is broken the
        // send below fails anyway and reports the real reason.
        await ignoreFailure(() => sendTypingIndicator(socket, receiver, duration))
    }

    return sendMessage(socket, receiver, message, sendOptions, delayMs)
}

/** Does the phone number / group actually exist on WhatsApp? */
export const isJidExists = async (socket, jid, isGroup = false) => {
    try {
        if (isGroup) {
            const metadata = await socket.groupMetadata(jid)

            return Boolean(metadata?.id)
        }

        const [result] = await socket.onWhatsApp(jid)

        return Boolean(result?.exists)
    } catch {
        return false
    }
}

/* -------------------------------------------------------------------------- */
/* Contact lookups                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How many JIDs go into one USync query. A single query with hundreds of users
 * is rejected by the server, so long lists are split.
 */
const CHECK_CHUNK_SIZE = 50

/**
 * Which of these JIDs exist on WhatsApp.
 *
 * Phone JIDs and LID JIDs can be mixed in one call: `onWhatsApp` splits them
 * into two internal queries and merges the results. A phone lookup also returns
 * the account's LID, which is the only way to learn the mapping.
 *
 * @returns {Promise<Array<{ jid: string, exists: boolean, lid?: string }>>}
 */
export const checkOnWhatsApp = async (socket, jids) => {
    const unique = [...new Set(jids.filter(Boolean))]

    if (unique.length === 0) {
        return []
    }

    const results = []

    for (let index = 0; index < unique.length; index += CHECK_CHUNK_SIZE) {
        const chunk = unique.slice(index, index + CHECK_CHUNK_SIZE)
        const batch = await runOperation(
            () => socket.onWhatsApp(...chunk),
            'Failed to check those contacts on WhatsApp.',
            'CHECK_ON_WHATSAPP_FAILED',
        )

        results.push(...(batch ?? []))
    }

    return results
}

/**
 * Resolve a WhatsApp username to the account behind it.
 *
 * @returns {Promise<{ jid: string, contact: boolean }|null>} `null` when the
 * username does not exist
 */
export const findUserByUsername = (socket, username, pin) => {
    return runOperation(
        () => socket.findUserByUsername(username, pin),
        'Failed to look up that username.',
        'USERNAME_LOOKUP_FAILED',
    )
}

/** The username of each JID, for the accounts that have one. */
export const fetchUsernames = async (socket, jids) => {
    const unique = [...new Set(jids.filter(Boolean))]

    if (unique.length === 0) {
        return []
    }

    return runOperation(
        () => socket.fetchContactUsernames(...unique),
        'Failed to fetch those usernames.',
        'USERNAME_FETCH_FAILED',
    )
}

export const getProfilePictureUrl = async (socket, jid, type = 'image') => {
    try {
        return await socket.profilePictureUrl(jid, type)
    } catch (cause) {
        throw new AppError('The user or group does not have a profile picture.', {
            status: 404,
            code: 'PROFILE_PICTURE_NOT_FOUND',
            cause,
        })
    }
}

export const updateProfileStatus = (socket, status) => {
    return runOperation(() => socket.updateProfileStatus(status), 'Failed to update the profile status.')
}

export const updateProfileName = (socket, name) => {
    return runOperation(() => socket.updateProfileName(name), 'Failed to update the profile name.')
}

/** Download `url` to a temporary file, use it as the new picture, then clean up. */
export const updateProfilePictureFromUrl = async (socket, jid, url) => {
    const filePath = await downloadToTempFile(url)

    try {
        return await runOperation(
            () => socket.updateProfilePicture(jid, { url: filePath }),
            'Failed to update the profile picture.',
        )
    } finally {
        await removeFile(filePath)
    }
}

export const blockAndUnblockUser = (socket, jid, block) => {
    return runOperation(() => socket.updateBlockStatus(jid, block), 'Failed to block or unblock the contact.')
}

export const readMessages = (socket, keys) => {
    return runOperation(() => socket.readMessages(keys), 'Failed to mark the message as read.')
}

export const sendPresenceUpdate = (socket, presence, jid) => {
    return runOperation(() => socket.sendPresenceUpdate(presence, jid), 'Failed to send presence.')
}

export const getGroupMetadata = (socket, jid) => {
    return runOperation(() => socket.groupMetadata(jid), 'Failed to get the group metadata.')
}

/** All groups the session participates in, metadata and participants included. */
export const getParticipatingGroups = (socket) => {
    return runOperation(() => socket.groupFetchAllParticipating(), 'Failed to get the group list.')
}

export const createGroup = (socket, subject, participants) => {
    return runOperation(() => socket.groupCreate(subject, participants), 'Failed to create the group.')
}

export const updateGroupParticipants = (socket, jid, participants, action) => {
    return runOperation(
        () => socket.groupParticipantsUpdate(jid, participants, action),
        'Failed to update the group participants.',
    )
}

export const updateGroupSubject = (socket, jid, subject) => {
    return runOperation(() => socket.groupUpdateSubject(jid, subject), 'Failed to update the group subject.')
}

export const updateGroupDescription = (socket, jid, description) => {
    return runOperation(
        () => socket.groupUpdateDescription(jid, description),
        'Failed to update the group description.',
    )
}

export const updateGroupSetting = (socket, jid, settings) => {
    return runOperation(() => socket.groupSettingUpdate(jid, settings), 'Failed to update the group settings.')
}

export const leaveGroup = (socket, jid) => {
    return runOperation(() => socket.groupLeave(jid), 'Failed to leave the group.')
}

export const getGroupInviteCode = (socket, jid) => {
    return runOperation(() => socket.groupInviteCode(jid), 'Failed to get the group invite code.')
}

export const revokeGroupInvite = (socket, jid) => {
    return runOperation(() => socket.groupRevokeInvite(jid), 'Failed to revoke the group invite code.')
}

export const acceptGroupInvite = (socket, invite) => {
    return runOperation(() => socket.groupAcceptInvite(invite), 'Failed to accept the group invite.')
}

/* -------------------------------------------------------------------------- */
/* Store reads — the message store lives on the socket as `socket.store`.      */
/* -------------------------------------------------------------------------- */

/**
 * Chats cached by the store, filtered down to private or group conversations.
 *
 * @param {object} socket
 * @param {boolean} isGroup
 */
export const getChatList = (socket, isGroup = false) => {
    const suffix = isGroup ? GROUP_SUFFIX : USER_SUFFIX
    const chats = socket.store?.chats ?? new Map()

    return [...chats.values()].filter((chat) => chat.id?.endsWith(suffix))
}

/** Full stored message (key, message, timestamp…) or `null`. */
export const getStoredMessage = (socket, jid, messageId) => {
    return socket.store?.getMessage(jid, messageId) ?? null
}

/** Message content only — the shape Baileys expects from its `getMessage` option. */
export const getStoredMessageContent = (store, key) => {
    return store?.getMessage(key.remoteJid, key.id)?.message ?? undefined
}

/** Contacts the user saved with a name, used for `all_contacts` broadcasts. */
export const getSavedContacts = (socket) => {
    return socket.store?.getContactList('saved') ?? []
}
