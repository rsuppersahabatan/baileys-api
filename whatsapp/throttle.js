import { delay } from '@innovatorssoft/baileys'
import { config } from '../config.js'

/**
 * Send pacing — the one place that decides how fast a session may talk.
 *
 * Every outgoing message funnels through `actions.sendMessage`, and that call
 * lands here first. Two things happen:
 *
 *  - **Sends are serialised per socket.** Two requests that arrive together
 *    cannot have their messages race each other onto the wire, and a scheduler
 *    tick cannot overlap a request handler.
 *  - **Consecutive sends are separated by a randomised gap.** A machine-perfect
 *    one-second cadence is itself a pattern, and a steady rhythm is one of the
 *    things WhatsApp's abuse heuristics key on — so the gap is drawn from a
 *    range instead of being fixed.
 *
 * Be clear about what this buys: it removes *one* signal (burst rate). It does
 * not make an account unsendable-to-strangers. Whether an account gets flagged
 * depends mostly on things this code cannot see — who the recipients are,
 * whether they report the messages, how old and how warm the number is, and the
 * fact that Baileys is not an official client. Pacing makes automated bulk
 * sending look less like a machine; it does not make it welcome.
 */

/** Gap in milliseconds between two sends on the same socket. */
export const pacingGap = (min, max, random = Math.random) => {
    const lower = Math.max(0, Math.round(min))
    const upper = Math.max(lower, Math.round(max))

    return lower + Math.round(random() * (upper - lower))
}

/** When each socket last put a message on the wire. */
const lastSendAt = new Map()

/** The tail of each socket's send queue, so its sends never interleave. */
const queues = new Map()

const NOOP = () => {}

/**
 * Read a per-call gap override, or `null` when the configured range applies.
 *
 * Only a positive number counts. Callers historically passed `0` to mean "no
 * extra wait", and that has to keep meaning *no override* — reading it as a
 * literal zero-length gap would silently turn pacing off for exactly the sends
 * that need it most.
 */
const overrideOf = (value) => {
    const gap = Number(value)

    return Number.isFinite(gap) && gap > 0 ? gap : null
}

/**
 * Run `task` as the next send on `socket`, waiting out the gap first.
 *
 * The wait is measured from the previous send's *start*, so a slow send does
 * not stack its whole duration on top of the gap — the interval is a rate, not
 * a cool-down. The very first send on a socket is never delayed: there is no
 * preceding message to be too close to.
 *
 * @param {object} socket
 * @param {() => Promise<unknown>} task the actual send
 * @param {object} [options]
 * @param {number|null} [options.minDelay] explicit gap for this send, overriding the configured range
 * @param {() => number} [options.random] injectable so tests can pin the jitter
 */
export const paceSend = (socket, task, { minDelay = null, random } = {}) => {
    const previous = queues.get(socket) ?? Promise.resolve()

    const run = previous.then(async () => {
        const last = lastSendAt.get(socket)
        const override = overrideOf(minDelay)

        if (last !== undefined) {
            const gap = override ?? pacingGap(config.send.minDelay, config.send.maxDelay, random)
            const wait = last + gap - Date.now()

            if (wait > 0) {
                await delay(wait)
            }
        }

        lastSendAt.set(socket, Date.now())

        return task()
    })

    // The queue has to survive a failed send. Storing the raw promise would let
    // one rejection poison every message queued behind it.
    queues.set(socket, run.then(NOOP, NOOP))

    return run
}

/**
 * Drop a socket's pacing state.
 *
 * Called from the session teardown. Without it the two maps would keep a
 * reference to every socket that was ever created, because they are keyed by
 * the socket object itself.
 */
export const forgetPacing = (socket) => {
    lastSendAt.delete(socket)
    queues.delete(socket)
}

/** Forget every socket. Test seam — there is no production caller. */
export const resetPacing = () => {
    lastSendAt.clear()
    queues.clear()
}
