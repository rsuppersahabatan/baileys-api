import { Router } from 'express'
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
 * Last-resort handler. Anything a controller did not catch — an async throw in
 * a route that has no `try`, a bug in a middleware — still answers with the
 * usual envelope instead of Express' default HTML error page.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
router.use((error, req, res, next) => {
    console.error('Unhandled error:', error)

    const status = error.status ?? 500

    response(res, status, false, status < 500 ? error.message : 'Internal server error.')
})

export default router
