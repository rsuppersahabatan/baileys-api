import { Router } from 'express'
import { AppError } from './errors.js'
import authenticationValidator from './middlewares/authenticationValidator.js'
import response from './response.js'
import chatsRoute from './routes/chatsRoute.js'
import contactsRoute from './routes/contactsRoute.js'
import groupsRoute from './routes/groupsRoute.js'
import miscRoute from './routes/miscRoute.js'
import schedulerRoute from './routes/schedulerRoute.js'
import sessionsRoute from './routes/sessionsRoute.js'

const router = Router()

router.use(authenticationValidator)

router.use('/sessions', sessionsRoute)
router.use('/chats', chatsRoute)
router.use('/contacts', contactsRoute)
router.use('/groups', groupsRoute)
router.use('/misc', miscRoute)
router.use('/scheduler', schedulerRoute)

router.use((req, res) => {
    response(res, 404, false, 'The requested url cannot be found.')
})

/**
 * Last-resort handler, and the only place that decides how much of a failure a
 * client gets to see.
 *
 * An `AppError` is a decision the code already made about the response — its
 * message is written for the caller and its status is deliberate — so both are
 * passed through. Anything else is a bug or a library failure: it is logged
 * with its stack, and answered with a flat 500, because a driver message or an
 * internal path is not something to hand to a client.
 *
 * Controllers rely on this. Express 5 forwards a rejected promise from an
 * `async` handler here without any wrapper, which is what lets them skip the
 * per-call `try/catch` that used to flatten every failure into a generic 500.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
router.use((error, req, res, next) => {
    const known = error instanceof AppError

    if (!known) {
        console.error('Unhandled error:', error)
    }

    response(res, known ? error.status : 500, false, known ? error.message : 'Internal server error.')
})

export default router
