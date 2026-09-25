import { Router } from 'express'
import { body, query } from 'express-validator'
import * as controller from './../controllers/schedulerController.js'
import requestValidator from './../middlewares/requestValidator.js'
import sessionExistsValidator from './../middlewares/sessionExistsValidator.js'
import sessionValidator from './../middlewares/sessionValidator.js'

const router = Router()

// Queueing a message needs a live connection, because the receiver is checked
// against WhatsApp before the job is accepted.
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
