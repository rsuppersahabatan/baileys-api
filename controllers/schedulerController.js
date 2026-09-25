import response from '../response.js'
import * as scheduler from '../whatsapp/scheduler.js'

/**
 * Scheduled messages.
 *
 * The session is resolved by the middleware (`res.locals.sessionId`); the job
 * id always comes from the path as `:jobId` so it cannot be confused with the
 * session id, which the session middlewares also read from `req.params.id`.
 */

/** `AppError` messages are written for the client; anything else is not. */
const failure = (error, fallback) => (error?.status ? error.message : fallback)

const add = async (req, res) => {
    const { receiver, message, scheduledAt } = req.body
    const isGroup = req.body.isGroup ?? false

    try {
        const job = await scheduler.schedule(res.locals.sessionId, {
            receiver,
            message,
            scheduledAt,
            isGroup,
        })

        response(res, 201, true, 'The message has been scheduled.', job)
    } catch (error) {
        response(res, error.status ?? 500, false, failure(error, 'Failed to schedule the message.'))
    }
}

const list = (req, res) => {
    const jobs = scheduler.list(res.locals.sessionId)

    response(res, 200, true, 'Scheduled message list', jobs)
}

const find = (req, res) => {
    const job = scheduler.find(res.locals.sessionId, req.params.jobId)

    if (!job) {
        return response(res, 404, false, 'Scheduled message not found.')
    }

    response(res, 200, true, 'Scheduled message found', job)
}

const update = async (req, res) => {
    const { scheduledAt, receiver, message, isGroup } = req.body

    try {
        const job = await scheduler.update(res.locals.sessionId, req.params.jobId, {
            scheduledAt,
            receiver,
            message,
            isGroup,
        })

        if (!job) {
            return response(res, 404, false, 'Scheduled message not found.')
        }

        response(res, 200, true, 'The scheduled message has been updated.', job)
    } catch (error) {
        response(res, error.status ?? 500, false, failure(error, 'Failed to update the scheduled message.'))
    }
}

const del = async (req, res) => {
    try {
        const job = await scheduler.cancel(res.locals.sessionId, req.params.jobId)

        if (!job) {
            return response(res, 404, false, 'Scheduled message not found.')
        }

        response(res, 200, true, 'The scheduled message has been cancelled.', job)
    } catch (error) {
        response(res, error.status ?? 500, false, failure(error, 'Failed to cancel the scheduled message.'))
    }
}

export { add, list, find, update, del }
