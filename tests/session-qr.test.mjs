/**
 * Checks for the rule that decides what happens to a QR WhatsApp emits.
 *
 * `POST /sessions/add` answers exactly once, so a QR is only deliverable while
 * that request is still open. WhatsApp rotates the QR about once a minute;
 * a rotated code that nobody is waiting for means the login attempt is over and
 * the session is dropped.
 *
 * The pairing-code path is the exception this file guards: no QR is ever shown
 * there, so a rotation must not be read as "nobody scanned in time" — that would
 * delete a healthy session while the user is still typing the code.
 *
 * Run with `npm test`. No test framework needed.
 */
import { canDeliverQr, qrOutcome } from '../whatsapp/session.js'

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const pendingRequest = { headersSent: false }
const answeredRequest = { headersSent: true }

// --- canDeliverQr -----------------------------------------------------------

check('first QR, request still open -> deliverable', canDeliverQr(pendingRequest), true)
check('rotated QR, request already answered -> not deliverable', canDeliverQr(answeredRequest), false)
check('recovered session, nobody asked -> not deliverable', canDeliverQr(null), false)
check('recovered session, undefined -> not deliverable', canDeliverQr(undefined), false)

// A response object is always truthy, so the decision must hinge on headersSent.
check('answered request is not falsy', Boolean(answeredRequest), true)
check('pending request is not falsy', Boolean(pendingRequest), true)

// --- qrOutcome --------------------------------------------------------------

const qr = (expectsQr, res) => qrOutcome({ expectsQr, res })

check('QR session, request open -> deliver', qr(true, pendingRequest), 'deliver')
check('QR session, request answered -> drop', qr(true, answeredRequest), 'drop')
check('QR session, recovered, nobody waiting -> drop', qr(true, null), 'drop')

// The pairing-code fix: rotations are ignored, never dropped.
check('pairing session, request answered -> ignore', qr(false, answeredRequest), 'ignore')
check('pairing session, no request at all -> ignore', qr(false, null), 'ignore')
check('pairing session, request still open -> ignore', qr(false, pendingRequest), 'ignore')

// Only a QR session can ever be dropped, which is what keeps a pairing-code
// login alive while the user enters the code.
check(
    'a pairing session is never dropped',
    [pendingRequest, answeredRequest, null, undefined].some((res) => qr(false, res) === 'drop'),
    false,
)

console.log(failures === 0 ? '\nAll QR checks passed.' : `\n${failures} QR check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
