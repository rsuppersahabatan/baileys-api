import { AppError } from '../errors.js'
import response from '../response.js'
import { validateMediaUrl } from '../utils/functions.js'
import {
    blockAndUnblockUser,
    getProfilePictureUrl,
    getSavedContacts,
    sendMessage,
    updateProfileName,
    updateProfilePictureFromUrl,
    updateProfileStatus,
} from '../whatsapp/actions.js'
import { phoneFromJid, toJid, toUserJid } from '../whatsapp/jid.js'
import { getSession } from '../whatsapp/registry.js'

/**
 * Profile, blocklist and story-status endpoints.
 *
 * As elsewhere, a handler throws and `routes.js` answers. `getProfile` is the
 * one exception: a missing picture or status is a normal outcome here, so those
 * two lookups are allowed to fall back to `null` instead of failing the whole
 * response.
 */

/** JID that receives a broadcast story. */
const STATUS_BROADCAST_JID = 'status@broadcast'

const STORY_MEDIA_TYPES = ['image', 'video', 'audio']

const DEFAULT_STORY_BACKGROUND = '#103529'
const DEFAULT_STORY_FONT = 12

/** Every session-scoped handler needs an authenticated socket. */
const authenticatedSession = (res) => {
    const session = getSession(res.locals.sessionId)

    if (!session?.user?.id) {
        throw new AppError('The session is not authenticated yet.', { status: 400, code: 'NOT_AUTHENTICATED' })
    }

    return session
}

const setProfileStatus = async (req, res) => {
    await updateProfileStatus(getSession(res.locals.sessionId), req.body.status)

    response(res, 200, true, 'The status has been updated successfully')
}

const setProfileName = async (req, res) => {
    await updateProfileName(getSession(res.locals.sessionId), req.body.name)

    response(res, 200, true, 'The name has been updated successfully')
}

const setProfilePicture = async (req, res) => {
    const session = authenticatedSession(res)

    await updateProfilePictureFromUrl(session, toUserJid(phoneFromJid(session.user.id)), req.body.url)

    response(res, 200, true, 'Update profile picture successfully.')
}

const getProfile = async (req, res) => {
    const session = authenticatedSession(res)
    const phone = phoneFromJid(session.user.id)

    // A missing picture or status is normal, not an error.
    const [image, status] = await Promise.all([
        getProfilePictureUrl(session, session.user.id).catch(() => null),
        session.fetchStatus(toUserJid(phone)).catch(() => null),
    ])

    response(res, 200, true, 'The information has been obtained successfully.', {
        ...session.user,
        phone,
        image,
        status,
    })
}

const getProfilePictureUser = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = toJid(req.body.jid, req.body.isGroup ?? false)
    const image = await getProfilePictureUrl(session, jid)

    response(res, 200, true, 'The image has been obtained successfully.', image)
}

const blockAndUnblockContact = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { jid, isBlock } = req.body

    await blockAndUnblockUser(session, toUserJid(jid), isBlock === true ? 'block' : 'unblock')

    response(res, 200, true, 'The contact has been blocked or unblocked successfully')
}

/**
 * Build the audience of a story status.
 *
 * The session's own number is always included (that is what makes the story
 * visible to the account itself), then whatever the request asked for.
 */
const resolveStoryReceivers = (session, receiver) => {
    const receivers = [toUserJid(session.user.id)]

    if (receiver === 'all_contacts') {
        const contacts = getSavedContacts(session)

        if (contacts.length === 0) {
            throw new AppError('No contacts found.', { status: 400, code: 'NO_CONTACTS' })
        }

        return [...receivers, ...contacts]
    }

    if (Array.isArray(receiver)) {
        if (receiver.length === 0) {
            throw new AppError('The receiver list is empty.', { status: 400, code: 'EMPTY_RECEIVER_LIST' })
        }

        if (receiver.some((item) => typeof item !== 'string')) {
            throw new AppError('All receivers must be strings.', { status: 400, code: 'RECEIVER_NOT_STRING' })
        }

        return [...receivers, ...receiver.map(toUserJid)]
    }

    if (typeof receiver === 'string' && receiver.length > 0) {
        if (receiver === session.user.id) {
            throw new AppError('You cannot send a message to yourself.', { status: 400, code: 'SELF_RECEIVER' })
        }

        return [...receivers, toUserJid(receiver)]
    }

    throw new AppError('The receiver number does not exist.', { status: 400, code: 'RECEIVER_REQUIRED' })
}

const shareStory = async (req, res) => {
    const { receiver, message, options = {} } = req.body
    const session = authenticatedSession(res)

    const invalidMedia = validateMediaUrl(message, STORY_MEDIA_TYPES)

    if (invalidMedia) {
        throw new AppError(invalidMedia, { status: 400, code: 'INVALID_MEDIA_URL' })
    }

    const { backgroundColor = DEFAULT_STORY_BACKGROUND, font = DEFAULT_STORY_FONT } = options

    await sendMessage(session, STATUS_BROADCAST_JID, message, {
        backgroundColor,
        font,
        broadcast: true,
        statusJidList: resolveStoryReceivers(session, receiver),
    })

    response(res, 200, true, 'The story status has been successfully sent.')
}

export {
    setProfileStatus,
    setProfileName,
    setProfilePicture,
    getProfile,
    getProfilePictureUser,
    blockAndUnblockContact,
    shareStory,
}
