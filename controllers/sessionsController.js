import { AppError } from '../errors.js'
import response from '../response.js'
import { getSession, hasSession, listSessions } from '../whatsapp/registry.js'
import { createSession, logoutSession } from '../whatsapp/session.js'

/**
 * Session lifecycle.
 *
 * `add` is the odd one out: the QR code or pairing code is delivered later, from
 * a socket event, so the request stays open until `createSession` answers it.
 * That is also why it keeps its own `catch` — the failure happens after the
 * handler has returned, so nothing would forward it to the error middleware.
 */

const SOCKET_STATES = ['connecting', 'connected', 'disconnecting', 'disconnected']

const find = (req, res) => {
    response(res, 200, true, 'Session found.')
}

const status = (req, res) => {
    const session = getSession(res.locals.sessionId)
    const state = SOCKET_STATES[session?.ws?.socket?.readyState] ?? 'unknown'

    response(res, 200, true, '', {
        status: state === 'connected' && session.user !== undefined ? 'authenticated' : state,
    })
}

const add = (req, res) => {
    const { id, typeAuth, phoneNumber } = req.body

    if (hasSession(id)) {
        throw new AppError('Session already exists, please use another id.', { status: 409, code: 'SESSION_EXISTS' })
    }

    if (typeAuth !== undefined && !['qr', 'code'].includes(typeAuth)) {
        throw new AppError('typeAuth must be qr or code.', { status: 400, code: 'INVALID_TYPE_AUTH' })
    }

    const usePairingCode = typeAuth === 'code'

    if (usePairingCode && !phoneNumber) {
        throw new AppError('phoneNumber is required.', { status: 400, code: 'PHONE_NUMBER_REQUIRED' })
    }

    createSession(id, { res, usePairingCode, phoneNumber }).catch((error) => {
        console.error(`Could not create session "${id}": ${error.message}`)
        response(res, 500, false, 'Unable to create session.')
    })
}

const del = async (req, res) => {
    await logoutSession(req.params.id)

    response(res, 200, true, 'The session has been successfully deleted.')
}

const list = (req, res) => {
    response(res, 200, true, 'Session list', listSessions())
}

export { find, status, add, del, list }
