import response from '../response.js'
import { checkOnWhatsApp, fetchUsernames, findUserByUsername } from '../whatsapp/actions.js'
import { toJid, toLidJid, toUserJid } from '../whatsapp/jid.js'
import { getSession, isSessionLoggedIn } from '../whatsapp/registry.js'

/**
 * "Does this exist on WhatsApp?" for phone numbers, LIDs and usernames.
 *
 * The three kinds resolve through different mechanisms, so they are reported
 * separately rather than merged into one list — a caller checking a phone number
 * wants its LID back, and a caller checking a username wants the JID behind it.
 */

const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean).map(String) : [])

/**
 * `toUserJid` / `toLidJid` strip everything but digits, so a value with no
 * digits at all collapses to a bare `@s.whatsapp.net` — a JID that can never
 * match anything. Rejecting it here keeps a malformed USync query from being
 * sent to WhatsApp on the caller's behalf.
 */
const hasDigits = (value) => /\d/.test(value)

const malformedMessage = (values) => `These values contain no phone number or LID: ${values.join(', ')}.`

/**
 * These lookups are answered by the account behind the session, and an unlogged
 * socket does not fail fast — the USync query simply waits for its own timeout,
 * which is about a minute. Refusing here turns a minute-long hang into an
 * immediate answer. `sessionValidator` cannot cover this: it only checks that
 * the websocket is open, which is also true while a QR code is unscanned.
 */
const rejectIfNotLoggedIn = (res) => {
    if (isSessionLoggedIn(res.locals.sessionId)) {
        return null
    }

    return response(res, 400, false, 'There is no connection with whatsapp at the moment, please try again')
}

/**
 * `onWhatsApp` reports a phone result keyed by JID and a LID result keyed by
 * LID, and a LID query can come back with no JID at all, so both keys are
 * indexed.
 */
const indexByJid = (entries) => {
    const index = new Map()

    for (const entry of entries) {
        if (entry?.jid) {
            index.set(entry.jid, entry)
        }

        if (entry?.lid) {
            index.set(entry.lid, entry)
        }
    }

    return index
}

const check = async (req, res) => {
    const offline = rejectIfNotLoggedIn(res)

    if (offline) {
        return offline
    }

    const session = getSession(res.locals.sessionId)

    const numbers = asArray(req.body.numbers)
    const lids = asArray(req.body.lids)
    const usernames = asArray(req.body.usernames)

    if (numbers.length + lids.length + usernames.length === 0) {
        return response(res, 400, false, 'Provide at least one of "numbers", "lids" or "usernames".')
    }

    const malformed = [...numbers, ...lids].filter((value) => !hasDigits(value))

    if (malformed.length > 0) {
        return response(res, 400, false, malformedMessage(malformed))
    }

    const numberJids = numbers.map((number) => toUserJid(number))
    const lidJids = lids.map((lid) => toLidJid(lid))

    try {
        const jidResults = await checkOnWhatsApp(session, [...numberJids, ...lidJids])
        const index = indexByJid(jidResults)

        const checkedNumbers = numberJids.map((jid, position) => {
            const entry = index.get(jid)

            return {
                input: numbers[position],
                jid,
                exists: Boolean(entry?.exists),
                lid: entry?.lid ?? null,
            }
        })

        const checkedLids = lidJids.map((jid, position) => {
            const entry = index.get(jid)

            return {
                input: lids[position],
                jid: entry?.jid ?? null,
                lid: entry?.lid ?? jid,
                exists: Boolean(entry?.exists),
            }
        })

        // One USync query per username, run in order rather than in parallel so a
        // long list does not arrive at the server all at once.
        const checkedUsernames = []

        for (const username of usernames) {
            const entry = await findUserByUsername(session, username.replace(/^@/, ''))

            checkedUsernames.push({
                input: username,
                jid: entry?.jid ?? null,
                exists: Boolean(entry?.jid),
                contact: Boolean(entry?.contact),
            })
        }

        const all = [...checkedNumbers, ...checkedLids, ...checkedUsernames]
        const found = all.filter((entry) => entry.exists).length

        response(res, 200, true, `Checked ${all.length} target(s), ${found} exist on WhatsApp.`, {
            numbers: checkedNumbers,
            lids: checkedLids,
            usernames: checkedUsernames,
        })
    } catch (error) {
        response(res, error.status ?? 500, false, error.message ?? 'Failed to check those contacts.')
    }
}

/** The username of a JID, for accounts that have one. */
const username = async (req, res) => {
    const offline = rejectIfNotLoggedIn(res)

    if (offline) {
        return offline
    }

    const session = getSession(res.locals.sessionId)

    if (!hasDigits(req.params.jid)) {
        return response(res, 400, false, malformedMessage([req.params.jid]))
    }

    const jid = toJid(req.params.jid)

    try {
        const [entry] = await fetchUsernames(session, [jid])

        response(res, 200, true, 'The username has been obtained successfully.', {
            jid,
            username: entry?.username ?? null,
        })
    } catch (error) {
        response(res, error.status ?? 500, false, error.message ?? 'Failed to fetch the username.')
    }
}

export { check, username }
