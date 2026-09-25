import response from './../response.js'
import { hasSession, isSessionConnected } from '../whatsapp/registry.js'

const validate = (req, res, next) => {
    const sessionId = req.query.id ?? req.params.id

    if (!hasSession(sessionId)) {
        return response(res, 404, false, 'Session not found.')
    }

    // The session routes still make sense while a session is connecting, the
    // rest of the API does not.
    if (req.baseUrl !== '/sessions' && !isSessionConnected(sessionId)) {
        return response(res, 400, false, 'There is no connection with whatsapp at the moment, please try again')
    }

    res.locals.sessionId = sessionId
    next()
}

export default validate
