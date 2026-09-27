import { AppError } from '../errors.js'
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

/**
 * Group endpoints.
 *
 * Every handler that takes a `:jid` needs the same two things first: normalise
 * it, and confirm the group is real. `resolveGroup` does both and *throws* when
 * the group does not exist, so a handler reads as the one action it performs
 * instead of opening with an error branch. Express 5 turns the throw into the
 * matching response; see the error middleware in `routes.js`.
 */

const getList = (req, res) => {
    return response(res, 200, true, '', getChatList(getSession(res.locals.sessionId), true))
}

const getParticipatingGroupsList = async (req, res) => {
    const groups = await getParticipatingGroups(getSession(res.locals.sessionId))

    response(res, 200, true, '', groups)
}

const getGroupMetaData = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const data = await getGroupMetadata(session, toGroupJid(req.params.jid))

    if (!data?.id) {
        throw new AppError('The group is not exists.', { status: 400, code: 'GROUP_NOT_FOUND' })
    }

    response(res, 200, true, '', data)
}

const create = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { groupName, participants } = req.body
    const members = (Array.isArray(participants) ? participants : []).map(toUserJid)

    const group = await createGroup(session, groupName, members)

    response(res, 200, true, 'The group has been successfully created.', group)
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const receiver = toGroupJid(req.body.receiver)

    if (!(await isJidExists(session, receiver, true))) {
        throw new AppError('The receiver number is not exists.', { status: 400, code: 'GROUP_NOT_FOUND' })
    }

    await sendMessage(session, receiver, req.body.message)

    response(res, 200, true, 'The message has been successfully sent.')
}

/**
 * Normalise the `:jid` route param and make sure the group is real.
 *
 * @returns {Promise<string>} the group JID
 * @throws {AppError} 400 when the group does not exist
 */
const resolveGroup = async (req, session) => {
    const jid = toGroupJid(req.params.jid)

    if (!(await isJidExists(session, jid, true))) {
        throw new AppError('The group is not exists.', { status: 400, code: 'GROUP_NOT_FOUND' })
    }

    return jid
}

const groupParticipantsUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)
    const { action, participants } = req.body
    const members = (Array.isArray(participants) ? participants : []).map(toUserJid)

    await updateGroupParticipants(session, jid, members, action)

    response(res, 200, true, 'Update participants successfully.')
}

const groupUpdateSubject = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    await updateGroupSubject(session, jid, req.body.subject)

    response(res, 200, true, 'Update subject successfully.')
}

const groupUpdateDescription = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    await updateGroupDescription(session, jid, req.body.description)

    response(res, 200, true, 'Update description successfully.')
}

const groupSettingUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    await updateGroupSetting(session, jid, req.body.settings)

    response(res, 200, true, 'Update setting successfully.')
}

const groupLeave = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    await leaveGroup(session, jid)

    response(res, 200, true, 'Leave group successfully.')
}

const groupInviteCode = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    const code = await getGroupInviteCode(session, jid)

    response(res, 200, true, 'Invite code successfully.', code)
}

const groupAcceptInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const group = await acceptGroupInvite(session, req.body.invite)

    response(res, 200, true, 'Accept invite successfully.', group)
}

const groupRevokeInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    const code = await revokeGroupInvite(session, jid)

    response(res, 200, true, 'Revoke code successfully.', code)
}

const updateProfilePicture = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const jid = await resolveGroup(req, session)

    await updateProfilePictureFromUrl(session, jid, req.body.url)

    response(res, 200, true, 'Update profile picture successfully.')
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
