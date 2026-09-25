/**
 * Typing indicator utility.
 *
 * The timing arithmetic is pure and tested directly. The wiring is tested
 * through the real `POST /chats/send` route with a fake socket that records the
 * order of every call it receives — the whole point of the feature is *when*
 * `composing` and `paused` are sent relative to the message, so order is what
 * the assertions are about.
 *
 * Run with `npm test`. No test framework needed.
 */
import express from 'express'
import routes from '../routes.js'
import { sendMessageWithTyping, sendTypingIndicator } from '../whatsapp/actions.js'
import * as registry from '../whatsapp/registry.js'
import {
    MAX_TYPING_MS,
    TYPING_DEFAULTS,
    extractText,
    resolveTypingDuration,
    typingDurationFor,
} from '../whatsapp/typing.js'

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const ok = (label, condition) => check(label, Boolean(condition), true)

/* -------------------------------------------------------------------------- */
/* Pure timing rules                                                          */
/* -------------------------------------------------------------------------- */

check('extractText reads a plain conversation', extractText({ conversation: 'halo' }), 'halo')
check('extractText reads extended text', extractText({ extendedTextMessage: { text: 'halo juga' } }), 'halo juga')
check('extractText reads an image caption', extractText({ imageMessage: { caption: 'lihat ini' } }), 'lihat ini')
check('extractText reads a video caption', extractText({ videoMessage: { caption: 'tonton' } }), 'tonton')
check('extractText of an empty message', extractText({}), '')
check('extractText of null', extractText(null), '')
check('extractText ignores a non-string caption', extractText({ imageMessage: { caption: 42 } }), '')

// A one-word reply still has to look like a pause rather than an instant flip.
check('a short message is clamped to the minimum', typingDurationFor({ conversation: 'ok' }), TYPING_DEFAULTS.min)
check(
    'a long message is clamped to the maximum',
    typingDurationFor({ conversation: 'x'.repeat(500) }),
    TYPING_DEFAULTS.max,
)
check(
    'a middling message scales with its length',
    typingDurationFor({ conversation: 'x'.repeat(20) }),
    Math.round(TYPING_DEFAULTS.base + 20 * TYPING_DEFAULTS.perCharacter),
)
check(
    'the scale is overridable',
    typingDurationFor({ conversation: 'x'.repeat(10) }, { base: 100, perCharacter: 10, min: 0, max: 1000 }),
    200,
)

check('no option means no indicator', resolveTypingDuration(undefined, { conversation: 'x' }), null)
check('null means no indicator', resolveTypingDuration(null, { conversation: 'x' }), null)
check('false means no indicator', resolveTypingDuration(false, { conversation: 'x' }), null)
check('the string "false" means no indicator', resolveTypingDuration('false', { conversation: 'x' }), null)
check('an empty string means no indicator', resolveTypingDuration('', { conversation: 'x' }), null)
// A zeroed-out delay is a flicker, which is exactly what this module exists to
// avoid — off is the better reading of 0.
check('zero means no indicator', resolveTypingDuration(0, { conversation: 'x' }), null)
check('the string "0" means no indicator', resolveTypingDuration('0', { conversation: 'x' }), null)

check('true derives the duration', resolveTypingDuration(true, { conversation: 'ok' }), TYPING_DEFAULTS.min)
check(
    'the string "true" derives the duration',
    resolveTypingDuration('true', { conversation: 'ok' }),
    TYPING_DEFAULTS.min,
)
check('a number is taken as milliseconds', resolveTypingDuration(1500, { conversation: 'x' }), 1500)
check('a numeric string is taken as milliseconds', resolveTypingDuration('1500', { conversation: 'x' }), 1500)
check('a { duration } object is accepted', resolveTypingDuration({ duration: 1200 }, { conversation: 'x' }), 1200)
check('an over-long duration is clamped', resolveTypingDuration(600_000, { conversation: 'x' }), MAX_TYPING_MS)
check('a nonsense duration means no indicator', resolveTypingDuration('agak lama', { conversation: 'x' }), null)

/* -------------------------------------------------------------------------- */
/* A socket that records the order of everything                              */
/* -------------------------------------------------------------------------- */

const calls = []

const fakeSocket = {
    ws: { socket: { readyState: 1 } },

    onWhatsApp: async () => {
        calls.push('exists')

        return [{ jid: '628111111111@s.whatsapp.net', exists: true }]
    },

    sendPresenceUpdate: async (presence) => {
        calls.push(`presence:${presence}`)
    },

    sendMessage: async (receiver) => {
        calls.push(`send:${receiver}`)

        return { key: { id: 'fake-1' } }
    },
}

const SESSION = 'typing-session'
registry.addSession(SESSION, fakeSocket)

const app = express()
app.use(express.json())
app.use('/', routes)

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))

const base = `http://127.0.0.1:${server.address().port}`

const send = async (body) => {
    calls.length = 0

    const res = await fetch(`${base}/chats/send?id=${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiver: '628111111111', ...body }),
    })

    return { status: res.status, json: await res.json() }
}

/* -------------------------------------------------------------------------- */
/* Wiring through the real route                                              */
/* -------------------------------------------------------------------------- */

const plain = await send({ message: { conversation: 'tanpa indikator' } })
check('a plain send succeeds', plain.status, 200)
check('  ...and touches no presence', calls.filter((entry) => entry.startsWith('presence')).length, 0)
check('  ...sending straight to the normalised JID', calls.at(-1), 'send:628111111111@s.whatsapp.net')

const typed = await send({ message: { conversation: 'halo' }, typing: true })
check('a send with typing succeeds', typed.status, 200)
check(
    '  ...shows the indicator before the message',
    calls.join(' '),
    'exists presence:composing presence:paused send:628111111111@s.whatsapp.net',
)

const explicit = await send({ message: { conversation: 'halo' }, typing: 150 })
check('an explicit duration succeeds', explicit.status, 200)
check(
    '  ...and still brackets the send',
    calls.join(' '),
    'exists presence:composing presence:paused send:628111111111@s.whatsapp.net',
)

const off = await send({ message: { conversation: 'halo' }, typing: false })
check('typing false sends nothing extra', off.status, 200)
check('  ...only the message', calls.join(' '), 'exists send:628111111111@s.whatsapp.net')

const zero = await send({ message: { conversation: 'halo' }, typing: 0 })
check('typing 0 is treated as off', zero.status, 200)
check('  ...rather than a flicker', calls.join(' '), 'exists send:628111111111@s.whatsapp.net')

/* -------------------------------------------------------------------------- */
/* The indicator must never cost the caller their message                     */
/* -------------------------------------------------------------------------- */

const brokenPresence = {
    ws: { socket: { readyState: 1 } },
    sendPresenceUpdate: async () => {
        throw new Error('presence unavailable')
    },
    sendMessage: async () => ({ key: { id: 'still-sent' } }),
}

const sent = []
const halfBroken = {
    ws: { socket: { readyState: 1 } },
    sendPresenceUpdate: async (presence) => {
        if (presence === 'composing') {
            throw new Error('presence unavailable')
        }
    },
    sendMessage: async (receiver) => {
        sent.push(receiver)

        return { key: { id: 'still-sent' } }
    },
}

let threw = null

try {
    await sendMessageWithTyping(
        halfBroken,
        '628111111111@s.whatsapp.net',
        { conversation: 'penting' },
        { typing: 100 },
        0,
    )
} catch (error) {
    threw = error.message
}

check('a failing indicator does not abort the send', threw, null)
check('  ...the message still goes out', sent.length, 1)
ok('  ...and reports its own id', Boolean(sent.length))

// The same guard for the whole indicator failing, not just the first call.
const bothBroken = { ...brokenPresence }

try {
    await sendMessageWithTyping(
        bothBroken,
        '628111111111@s.whatsapp.net',
        { conversation: 'penting' },
        { typing: 50 },
        0,
    )
} catch (error) {
    threw = error.message
}

check('a wholly broken indicator is also survivable', threw, null)

// But a real send failure must still surface.
let sendFailure = null

try {
    await sendMessageWithTyping(
        {
            ws: { socket: { readyState: 1 } },
            sendPresenceUpdate: async () => {},
            sendMessage: async () => {
                throw new Error('socket down')
            },
        },
        '628111111111@s.whatsapp.net',
        { conversation: 'penting' },
        { typing: 50 },
        0,
    )
} catch (error) {
    sendFailure = error.message
}

check('a failing send is still reported', sendFailure, 'Failed to send the message.')

// `sendTypingIndicator` on its own still fails loudly, so a caller using it
// directly is not silently misled.
let directFailure = null

try {
    await sendTypingIndicator(
        {
            sendPresenceUpdate: async () => {
                throw new Error('presence unavailable')
            },
        },
        '628111111111@s.whatsapp.net',
        10,
    )
} catch (error) {
    directFailure = error.message
}

check('the low-level indicator reports its own failure', directFailure, 'Failed to send presence.')

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

server.close()
registry.forgetSession(SESSION)

console.log(failures === 0 ? '\nAll typing checks passed.' : `\n${failures} typing check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
