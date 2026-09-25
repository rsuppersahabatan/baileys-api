/**
 * Contact lookups: phone numbers, LIDs and usernames.
 *
 * `onWhatsApp` is the interesting one, because it behaves differently per input
 * kind: phone JIDs are queried with the contact protocol and come back keyed by
 * phone with the LID attached, while LID JIDs are queried with the LID protocol
 * and come back keyed by *phone*. The fake socket below reproduces that split
 * exactly, so the controller's index has to be right for the tests to pass —
 * a stub that returned one flat shape would prove nothing.
 *
 * The real routes, middlewares and controllers run over real HTTP. No WhatsApp
 * account is involved.
 *
 * Run with `npm test`. No test framework needed.
 */
import express from 'express'
import routes from '../routes.js'
import * as registry from '../whatsapp/registry.js'
import { USER_SUFFIX } from '../whatsapp/jid.js'

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const ok = (label, condition) => check(label, Boolean(condition), true)

/* -------------------------------------------------------------------------- */
/* A directory that behaves like WhatsApp                                     */
/* -------------------------------------------------------------------------- */

const LID_SUFFIX = '@lid'

/** Phones that exist, with the LID they publish (`null` = none published). */
const PHONES = new Map([
    ['628111111111', '111111111111111'],
    ['628222222222', '222222222222222'],
    ['628333333333', null],
])

/** The reverse mapping the server hands back for a LID query. */
const LIDS = new Map([...PHONES].filter(([, lid]) => lid).map(([phone, lid]) => [lid, phone]))

/** Usernames resolvable to an account. */
const USERNAMES = new Map([
    ['budi', { jid: `628111111111${USER_SUFFIX}`, contact: true }],
    ['siti', { jid: `628222222222${USER_SUFFIX}`, contact: false }],
])

/** Usernames owned by a JID, for the reverse lookup. */
const OWNED = new Map([
    [`628111111111${USER_SUFFIX}`, 'budi'],
    [`628222222222${USER_SUFFIX}`, 'siti'],
])

const calls = { onWhatsApp: 0, findUserByUsername: 0, fetchContactUsernames: 0 }

const fakeSocket = {
    ws: { socket: { readyState: 1 } },
    authState: { creds: { registered: true } },

    /**
     * Mirrors `socket.onWhatsApp`: LID inputs are answered with the phone JID in
     * `jid`, phone inputs with the phone JID in `jid` and the LID in `lid`, and
     * unknown inputs are omitted entirely rather than returned as `exists: false`.
     */
    onWhatsApp: async (...jids) => {
        calls.onWhatsApp += 1

        const output = []

        for (const jid of jids) {
            if (jid.endsWith(LID_SUFFIX)) {
                const phone = LIDS.get(jid.split('@')[0])

                if (phone) {
                    output.push({ jid: `${phone}${USER_SUFFIX}`, exists: true, lid: jid })
                }

                continue
            }

            const phone = jid.split('@')[0].split(':')[0]

            if (PHONES.has(phone)) {
                const lid = PHONES.get(phone)

                output.push({
                    jid: `${phone}${USER_SUFFIX}`,
                    exists: true,
                    lid: lid ? `${lid}${LID_SUFFIX}` : undefined,
                })
            }
        }

        return output
    },

    findUserByUsername: async (username) => {
        calls.findUserByUsername += 1

        return USERNAMES.get(username) ?? null
    },

    fetchContactUsernames: async (...jids) => {
        calls.fetchContactUsernames += 1

        return jids.filter((jid) => OWNED.has(jid)).map((jid) => ({ id: jid, username: OWNED.get(jid) }))
    },
}

const SESSION = 'contacts-session'
registry.addSession(SESSION, fakeSocket)

/**
 * A socket that is open but not logged in — the state a session sits in while
 * its QR code is still unscanned. Real USync queries are never answered here,
 * they just wait out the query timeout, so every method hangs forever. That is
 * exactly what the route must not do.
 */
const UNLOGGED = 'contacts-unlogged'
const hanging = () => new Promise(() => {})

registry.addSession(UNLOGGED, {
    ws: { socket: { readyState: 1 } },
    authState: { creds: { registered: false } },
    onWhatsApp: hanging,
    findUserByUsername: hanging,
    fetchContactUsernames: hanging,
})

const app = express()
app.use(express.json())
app.use('/', routes)

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))

const base = `http://127.0.0.1:${server.address().port}`

const call = async (method, path, body) => {
    const res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        // So a regression fails the test instead of hanging it forever.
        signal: AbortSignal.timeout(5000),
    })

    return { status: res.status, json: await res.json() }
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

const noId = await call('POST', '/contacts/check', { numbers: ['628111111111'] })
check('POST /contacts/check without ?id is rejected', noId.status, 400)

const ghost = await call('POST', '/contacts/check?id=ghost', { numbers: ['628111111111'] })
check('POST /contacts/check with an unknown session', ghost.status, 404)
check('  ...and says so', ghost.json.message, 'Session not found.')

const empty = await call('POST', `/contacts/check?id=${SESSION}`, {})
check('POST /contacts/check with nothing to check', empty.status, 400)
check(
    '  ...and lists the accepted fields',
    empty.json.message,
    'Provide at least one of "numbers", "lids" or "usernames".',
)

/* -------------------------------------------------------------------------- */
/* An open socket that is not logged in                                       */
/* -------------------------------------------------------------------------- */

// The middlewares let this through, because the websocket is genuinely open.
// Without the controller's own guard the request would hang until baileys gave
// up on the USync query — about a minute of nothing.
const unloggedAt = Date.now()
const unlogged = await call('POST', `/contacts/check?id=${UNLOGGED}`, { numbers: ['628111111111'] })
check('an unlogged session is refused', unlogged.status, 400)
check(
    '  ...with the standard message',
    unlogged.json.message,
    'There is no connection with whatsapp at the moment, please try again',
)
ok('  ...and answers immediately rather than hanging', Date.now() - unloggedAt < 1000)

const unloggedUsername = await call('GET', `/contacts/username/628111111111?id=${UNLOGGED}`)
check('the username route refuses an unlogged session too', unloggedUsername.status, 400)
check(
    '  ...with the same message',
    unloggedUsername.json.message,
    'There is no connection with whatsapp at the moment, please try again',
)

/* -------------------------------------------------------------------------- */
/* Phone numbers                                                              */
/* -------------------------------------------------------------------------- */

const numbers = await call('POST', `/contacts/check?id=${SESSION}`, {
    numbers: ['628111111111', '628333333333', '628999999999'],
})
check('POST /contacts/check accepts numbers', numbers.status, 200)
check('  ...and echoes the inputs back', numbers.json.data.numbers.length, 3)
check('  ...normalising each to a JID', numbers.json.data.numbers[0].jid, `628111111111${USER_SUFFIX}`)
check('  ...reporting the LID when there is one', numbers.json.data.numbers[0].lid, `111111111111111${LID_SUFFIX}`)
ok('  ...and the original input', numbers.json.data.numbers[0].input === '628111111111')

check('a number with no published LID still exists', numbers.json.data.numbers[1].exists, true)
check('  ...with a null LID', numbers.json.data.numbers[1].lid, null)
check('a number that is not on WhatsApp does not exist', numbers.json.data.numbers[2].exists, false)

// `toUserJid` strips everything but digits, so a formatted number still lands.
const messy = await call('POST', `/contacts/check?id=${SESSION}`, { numbers: ['+62 811 111 1111'] })
check('a formatted number is normalised', messy.json.data.numbers[0].jid, `628111111111${USER_SUFFIX}`)
check('  ...and is found', messy.json.data.numbers[0].exists, true)

// Without digits there is nothing to look up, and the normalisers would
// silently produce `@s.whatsapp.net` — a JID that can never match.
const junkNumber = await call('POST', `/contacts/check?id=${SESSION}`, { numbers: ['bukan nomor'] })
check('a value with no digits is rejected', junkNumber.status, 400)
check('  ...naming the offender', junkNumber.json.message, 'These values contain no phone number or LID: bukan nomor.')

const junkLid = await call('POST', `/contacts/check?id=${SESSION}`, { lids: ['@lid'] })
check('a LID with no digits is rejected', junkLid.status, 400)

/* -------------------------------------------------------------------------- */
/* LIDs                                                                       */
/* -------------------------------------------------------------------------- */

const lids = await call('POST', `/contacts/check?id=${SESSION}`, {
    lids: ['111111111111111', '999999999999999'],
})
check('POST /contacts/check accepts LIDs', lids.status, 200)
check('  ...and reports the phone behind the LID', lids.json.data.lids[0].jid, `628111111111${USER_SUFFIX}`)
check('  ...keeping the LID itself', lids.json.data.lids[0].lid, `111111111111111${LID_SUFFIX}`)
check('  ...and finding it', lids.json.data.lids[0].exists, true)
check('an unknown LID does not exist', lids.json.data.lids[1].exists, false)

const bareLid = await call('POST', `/contacts/check?id=${SESSION}`, { lids: [`111111111111111${LID_SUFFIX}`] })
check('a LID with its suffix is accepted', bareLid.json.data.lids[0].exists, true)

/* -------------------------------------------------------------------------- */
/* Usernames                                                                  */
/* -------------------------------------------------------------------------- */

const usernames = await call('POST', `/contacts/check?id=${SESSION}`, {
    usernames: ['budi', '@siti', 'tidak-ada'],
})
check('POST /contacts/check accepts usernames', usernames.status, 200)
check('  ...resolving the JID', usernames.json.data.usernames[0].jid, `628111111111${USER_SUFFIX}`)
check('  ...flagging a saved contact', usernames.json.data.usernames[0].contact, true)
check('  ...and an unsaved one', usernames.json.data.usernames[1].contact, false)
check('a leading @ is tolerated', usernames.json.data.usernames[1].exists, true)
check('an unknown username does not exist', usernames.json.data.usernames[2].exists, false)
check('  ...and has no JID', usernames.json.data.usernames[2].jid, null)

/* -------------------------------------------------------------------------- */
/* All three at once                                                          */
/* -------------------------------------------------------------------------- */

const mixed = await call('POST', `/contacts/check?id=${SESSION}`, {
    numbers: ['628111111111'],
    lids: ['222222222222222'],
    usernames: ['budi'],
})
check('POST /contacts/check handles all three kinds', mixed.status, 200)
check(
    '  ...reporting each kind separately',
    mixed.json.data.numbers.length + mixed.json.data.lids.length + mixed.json.data.usernames.length,
    3,
)
ok('  ...and counts the matches in the message', mixed.json.message.startsWith('Checked 3 target(s), 3 exist'))

/* -------------------------------------------------------------------------- */
/* Batching                                                                   */
/* -------------------------------------------------------------------------- */

const before = calls.onWhatsApp
const many = Array.from({ length: 51 }, (_, index) => `6281111${String(index).padStart(5, '0')}`)
const batched = await call('POST', `/contacts/check?id=${SESSION}`, { numbers: many })
check('a long list is accepted', batched.status, 200)
check('  ...and every input is reported back', batched.json.data.numbers.length, 51)
check('  ...split into one query per 50', calls.onWhatsApp - before, 2)

/* -------------------------------------------------------------------------- */
/* Reverse lookup: JID -> username                                            */
/* -------------------------------------------------------------------------- */

const jid = encodeURIComponent(`628111111111${USER_SUFFIX}`)
const username = await call('GET', `/contacts/username/${jid}?id=${SESSION}`)
check('GET /contacts/username returns the username', username.status, 200)
check('  ...for the requested JID', username.json.data.username, 'budi')
check('  ...echoing the normalised JID', username.json.data.jid, `628111111111${USER_SUFFIX}`)

const noUsername = await call(
    'GET',
    `/contacts/username/${encodeURIComponent(`628333333333${USER_SUFFIX}`)}?id=${SESSION}`,
)
check('a JID with no username', noUsername.status, 200)
check('  ...reports null rather than failing', noUsername.json.data.username, null)

// `:jid` and not `:id`: if the path param were named `id` it would shadow the
// session id the middlewares read, and this call would resolve to the wrong
// session (or none).
const shadow = await call('GET', `/contacts/username/628777777777?id=${SESSION}`)
check('the path param does not shadow the session id', shadow.status, 200)
check('  ...the session still resolves', shadow.json.data.jid, `628777777777${USER_SUFFIX}`)

const junkJid = await call('GET', `/contacts/username/ghost?id=${SESSION}`)
check('GET /contacts/username rejects a value with no digits', junkJid.status, 400)
check('  ...naming the offender', junkJid.json.message, 'These values contain no phone number or LID: ghost.')

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

server.close()
registry.forgetSession(SESSION)
registry.forgetSession(UNLOGGED)

console.log(failures === 0 ? '\nAll contacts checks passed.' : `\n${failures} contacts check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
