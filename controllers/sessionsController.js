import response from '../response.js'
import { getSession, hasSession, listSessions } from '../whatsapp/registry.js'
import { createSession, logoutSession } from '../whatsapp/session.js'

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
        return response(res, 409, false, 'Session already exists, please use another id.')
    }

    if (typeAuth !== undefined && !['qr', 'code'].includes(typeAuth)) {
        return response(res, 400, false, 'typeAuth must be qr or code.')
    }

    const usePairingCode = typeAuth === 'code'

    if (usePairingCode && !phoneNumber) {
        return response(res, 400, false, 'phoneNumber is required.')
    }

    // The QR / pairing code is delivered later, from a socket event, so the
    // request stays open until `createSession` answers it.
    createSession(id, { res, usePairingCode, phoneNumber }).catch((error) => {
        console.error(`Could not create session "${id}": ${error.message}`)
        response(res, 500, false, 'Unable to create session.')
    })
}

const del = async (req, res) => {
    try {
        await logoutSession(req.params.id)
        response(res, 200, true, 'The session has been successfully deleted.')
    } catch (error) {
        console.error(`Could not delete session "${req.params.id}": ${error.message}`)
        response(res, 500, false, 'Failed to delete the session.')
    }
}

const list = (req, res) => {
    response(res, 200, true, 'Session list', listSessions())
}

export { find, status, add, del, list }
