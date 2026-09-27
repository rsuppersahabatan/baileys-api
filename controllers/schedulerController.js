import { AppError } from '../errors.js'
import response from '../response.js'
import * as scheduler from '../whatsapp/scheduler.js'

/**
 * Scheduled messages.
 *
 * The session is resolved by the middleware (`res.locals.sessionId`); the job
 * id always comes from the path as `:jobId` so it cannot be confused with the
 * session id, which the session middlewares also read from `req.params.id`.
 *
 * Everything that can go wrong here already throws an `AppError` with a message
 * written for the client, so the handlers just let it through and `routes.js`
 * turns it into the response.
 */

const notFound = () => new AppError('Scheduled message not found.', { status: 404, code: 'JOB_NOT_FOUND' })

const add = async (req, res) => {
    const { receiver, message, scheduledAt, repeat, typing } = req.body
    const isGroup = req.body.isGroup ?? false

    const job = await scheduler.schedule(res.locals.sessionId, {
        receiver,
        message,
        scheduledAt,
        isGroup,
        repeat,
        typing,
    })

    response(res, 201, true, 'The message has been scheduled.', job)
}

const list = (req, res) => {
    response(res, 200, true, 'Scheduled message list', scheduler.list(res.locals.sessionId))
}

const find = (req, res) => {
    const job = scheduler.find(res.locals.sessionId, req.params.jobId)

    if (!job) {
        throw notFound()
    }

    response(res, 200, true, 'Scheduled message found', job)
}

const update = async (req, res) => {
    const { scheduledAt, receiver, message, isGroup, repeat, typing } = req.body

    const job = await scheduler.update(res.locals.sessionId, req.params.jobId, {
        scheduledAt,
        receiver,
        message,
        isGroup,
        repeat,
        typing,
    })

    if (!job) {
        throw notFound()
    }

    response(res, 200, true, 'The scheduled message has been updated.', job)
}

const del = async (req, res) => {
    const job = await scheduler.cancel(res.locals.sessionId, req.params.jobId)

    if (!job) {
        throw notFound()
    }

    response(res, 200, true, 'The scheduled message has been cancelled.', job)
}

export { add, list, find, update, del }
