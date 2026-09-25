import { Router } from 'express'
import { query } from 'express-validator'
import * as controller from './../controllers/contactsController.js'
import requestValidator from './../middlewares/requestValidator.js'
import sessionValidator from './../middlewares/sessionValidator.js'

const router = Router()

// The body is validated in the controller instead of here: the rule is "at
// least one of numbers / lids / usernames", which express-validator expresses
// far less clearly than a single check.
router.post('/check', query('id').notEmpty(), requestValidator, sessionValidator, controller.check)

// `:jid` and not `:id` — the session middlewares read `req.params.id` as a
// session id, so naming this one `id` would shadow it.
router.get('/username/:jid', query('id').notEmpty(), requestValidator, sessionValidator, controller.username)

export default router
