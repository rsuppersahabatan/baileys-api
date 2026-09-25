import { Router } from 'express'
import { body, query } from 'express-validator'
import * as controller from './../controllers/schedulerController.js'
import requestValidator from './../middlewares/requestValidator.js'
import sessionExistsValidator from './../middlewares/sessionExistsValidator.js'
import sessionValidator from './../middlewares/sessionValidator.js'

const router = Router()

// Queueing a message needs a live connection. A job that cannot be sent only
// burns through its retry budget, and the caller is better off being told
// "not now" than having a message silently rot in the queue.
router.post(
    '/',
    query('id').notEmpty(),
    body('receiver').notEmpty(),
    body('message').notEmpty(),
    body('scheduledAt').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.add,
)

// Everything below only touches the queue, so it keeps working while the
// session is reconnecting — see `sessionExistsValidator`.
router.get('/list', query('id').notEmpty(), requestValidator, sessionExistsValidator, controller.list)

router.get('/find/:jobId', query('id').notEmpty(), requestValidator, sessionExistsValidator, controller.find)

router.put('/update/:jobId', query('id').notEmpty(), requestValidator, sessionExistsValidator, controller.update)

router.delete('/delete/:jobId', query('id').notEmpty(), requestValidator, sessionExistsValidator, controller.del)

export default router
