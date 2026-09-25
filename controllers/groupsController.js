import response from '../response.js'
import {
    acceptGroupInvite,
    createGroup,
    getChatList,
    getGroupInviteCode,
    getGroupMetadata,
    getParticipatingGroups,
    isJidExists,
    leaveGroup,
    revokeGroupInvite,
    sendMessage,
    updateGroupDescription,
    updateGroupParticipants,
    updateGroupSetting,
    updateGroupSubject,
    updateProfilePictureFromUrl,
} from '../whatsapp/actions.js'
import { toGroupJid, toUserJid } from '../whatsapp/jid.js'
import { getSession } from '../whatsapp/registry.js'

const getList = (req, res) => {
    return response(res, 200, true, '', getChatList(getSession(res.locals.sessionId), true))
}

const getParticipatingGroupsList = async (req, res) => {
    try {
        const groups = await getParticipatingGroups(getSession(res.locals.sessionId))

        response(res, 200, true, '', groups)
    } catch {
        response(res, 500, false, 'Failed to get group list with participants.')
    }
}

const getGroupMetaData = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { jid } = req.params

    try {
        const data = await getGroupMetadata(session, toGroupJid(jid))

        if (!data?.id) {
            return response(res, 400, false, 'The group is not exists.')
        }

        response(res, 200, true, '', data)
    } catch {
        response(res, 500, false, 'Failed to get group metadata.')
    }
}

const create = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { groupName, participants } = req.body
    const members = (Array.isArray(participants) ? participants : []).map(toUserJid)

    try {
        const group = await createGroup(session, groupName, members)

        response(res, 200, true, 'The group has been successfully created.', group)
    } catch {
        response(res, 500, false, 'Failed to create the group.')
    }
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const receiver = toGroupJid(req.body.receiver)

    try {
        if (!(await isJidExists(session, receiver, true))) {
            return response(res, 400, false, 'The receiver number is not exists.')
        }

        await sendMessage(session, receiver, req.body.message, {}, 0)

        response(res, 200, true, 'The message has been successfully sent.')
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

/**
 * Resolve the `:jid` route param and make sure the group is real.
 *
 * Answers with a 400 and returns `null` when it is not, so every handler below
 * can bail out with a single `if (!jid) return`.
 */
const resolveGroup = async (req, res, session) => {
    const jid = toGroupJid(req.params.jid)

    if (!(await isJidExists(session, jid, true))) {
        response(res, 400, false, 'The group is not exists.')

        return null
    }

    return jid
}

const groupParticipantsUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { action, participants } = req.body

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        const members = (Array.isArray(participants) ? participants : []).map(toUserJid)

        await updateGroupParticipants(session, jid, members, action)

        response(res, 200, true, 'Update participants successfully.')
    } catch {
        response(res, 500, false, 'Failed update participants.')
    }
}

const groupUpdateSubject = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        await updateGroupSubject(session, jid, req.body.subject)

        response(res, 200, true, 'Update subject successfully.')
    } catch {
        response(res, 500, false, 'Failed update subject.')
    }
}

const groupUpdateDescription = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        await updateGroupDescription(session, jid, req.body.description)

        response(res, 200, true, 'Update description successfully.')
    } catch {
        response(res, 500, false, 'Failed description subject.')
    }
}

const groupSettingUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        await updateGroupSetting(session, jid, req.body.settings)

        response(res, 200, true, 'Update setting successfully.')
    } catch {
        response(res, 500, false, 'Failed update setting.')
    }
}

const groupLeave = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        await leaveGroup(session, jid)

        response(res, 200, true, 'Leave group successfully.')
    } catch {
        response(res, 500, false, 'Failed leave group.')
    }
}

const groupInviteCode = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        const code = await getGroupInviteCode(session, jid)

        response(res, 200, true, 'Invite code successfully.', code)
    } catch {
        response(res, 500, false, 'Failed invite code.')
    }
}

const groupAcceptInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const group = await acceptGroupInvite(session, req.body.invite)

        response(res, 200, true, 'Accept invite successfully.', group)
    } catch {
        response(res, 500, false, 'Failed accept invite.')
    }
}

const groupRevokeInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        const code = await revokeGroupInvite(session, jid)

        response(res, 200, true, 'Revoke code successfully.', code)
    } catch {
        response(res, 500, false, 'Failed rovoke code.')
    }
}

const updateProfilePicture = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const jid = await resolveGroup(req, res, session)

        if (!jid) {
            return
        }

        await updateProfilePictureFromUrl(session, jid, req.body.url)

        response(res, 200, true, 'Update profile picture successfully.')
    } catch {
        response(res, 500, false, 'Failed Update profile picture.')
    }
}

export {
    getList,
    getGroupMetaData,
    create,
    send,
    groupParticipantsUpdate,
    groupUpdateSubject,
    groupUpdateDescription,
    groupSettingUpdate,
    groupLeave,
    groupInviteCode,
    groupAcceptInvite,
    groupRevokeInvite,
    getParticipatingGroupsList,
    updateProfilePicture,
}
