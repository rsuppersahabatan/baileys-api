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
    try {
        await updateProfileStatus(getSession(res.locals.sessionId), req.body.status)

        response(res, 200, true, 'The status has been updated successfully')
    } catch {
        response(res, 500, false, 'Failed to update status')
    }
}

const setProfileName = async (req, res) => {
    try {
        await updateProfileName(getSession(res.locals.sessionId), req.body.name)

        response(res, 200, true, 'The name has been updated successfully')
    } catch {
        response(res, 500, false, 'Failed to update name')
    }
}

const setProfilePicture = async (req, res) => {
    try {
        const session = authenticatedSession(res)

        await updateProfilePictureFromUrl(session, toUserJid(phoneFromJid(session.user.id)), req.body.url)

        response(res, 200, true, 'Update profile picture successfully.')
    } catch (error) {
        response(res, error.status ?? 500, false, 'Failed Update profile picture.')
    }
}

const getProfile = async (req, res) => {
    try {
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
    } catch (error) {
        response(res, error.status ?? 500, false, 'Could not get the information')
    }
}

const getProfilePictureUser = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        const jid = toJid(req.body.jid, req.body.isGroup ?? false)
        const image = await getProfilePictureUrl(session, jid)

        response(res, 200, true, 'The image has been obtained successfully.', image)
    } catch (error) {
        if (error instanceof AppError && error.code === 'PROFILE_PICTURE_NOT_FOUND') {
            return response(res, 404, false, 'the user or group not have image')
        }

        response(res, 500, false, 'Could not get the information')
    }
}

const blockAndUnblockContact = async (req, res) => {
    try {
        const session = getSession(res.locals.sessionId)
        const { jid, isBlock } = req.body

        await blockAndUnblockUser(session, toUserJid(jid), isBlock === true ? 'block' : 'unblock')

        response(res, 200, true, 'The contact has been blocked or unblocked successfully')
    } catch {
        response(res, 500, false, 'Failed to block or unblock contact')
    }
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
            throw new AppError('No contacts found.', { status: 400 })
        }

        return [...receivers, ...contacts]
    }

    if (Array.isArray(receiver)) {
        if (receiver.length === 0) {
            throw new AppError('The receiver list is empty.', { status: 400 })
        }

        if (receiver.some((item) => typeof item !== 'string')) {
            throw new AppError('All receivers must be strings.', { status: 400 })
        }

        return [...receivers, ...receiver.map(toUserJid)]
    }

    if (typeof receiver === 'string' && receiver.length > 0) {
        if (receiver === session.user.id) {
            throw new AppError('You cannot send a message to yourself.', { status: 400 })
        }

        return [...receivers, toUserJid(receiver)]
    }

    throw new AppError('The receiver number does not exist.', { status: 400 })
}

const shareStory = async (req, res) => {
    const { receiver, message, options = {} } = req.body

    try {
        const session = authenticatedSession(res)

        const invalidMedia = validateMediaUrl(message, STORY_MEDIA_TYPES)

        if (invalidMedia) {
            return response(res, 400, false, invalidMedia)
        }

        const { backgroundColor = DEFAULT_STORY_BACKGROUND, font = DEFAULT_STORY_FONT } = options

        await sendMessage(
            session,
            STATUS_BROADCAST_JID,
            message,
            {
                backgroundColor,
                font,
                broadcast: true,
                statusJidList: resolveStoryReceivers(session, receiver),
            },
            0,
        )

        response(res, 200, true, 'The story status has been successfully sent.')
    } catch (error) {
        if (error instanceof AppError) {
            return response(res, error.status, false, error.message)
        }

        response(res, 500, false, 'Failed to send the story status.')
    }
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
