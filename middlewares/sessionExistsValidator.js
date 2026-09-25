import response from './../response.js'
import { hasSession } from '../whatsapp/registry.js'

/**
 * Like `sessionValidator`, but without the connection requirement.
 *
 * The scheduler routes need this. A session that is reconnecting still has
 * queued messages that must be listed, rescheduled or cancelled, and refusing to
 * serve them exactly while WhatsApp is down would make the feature unusable in
 * the one situation where you most want to reach it. Sending still needs a live
 * connection — that check belongs to the job runner, not to the request.
 */
const validate = (req, res, next) => {
    const sessionId = req.query.id ?? req.params.id

    if (!hasSession(sessionId)) {
        return response(res, 404, false, 'Session not found.')
    }

    res.locals.sessionId = sessionId
    next()
}

export default validate
