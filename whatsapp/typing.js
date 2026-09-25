/**
 * Typing indicator timing.
 *
 * Sending `composing` and following it with the message a millisecond later is
 * worse than not sending it at all — the recipient sees a flicker that reads as
 * a glitch. The indicator has to stay up long enough to look like someone was
 * actually typing.
 *
 * The arithmetic lives here, away from the socket, so it can be tested without
 * WhatsApp. `actions.js` does the sending.
 */

/** Even a one-word reply reads as a pause, not as instant. */
export const TYPING_DEFAULTS = {
    base: 400,
    perCharacter: 45,
    min: 700,
    max: 6000,
}

/** An explicit `typing: <ms>` is still clamped — nobody wants a 10 minute pause. */
export const MAX_TYPING_MS = 30_000

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

/**
 * Text that carries the "how long would this take to type" signal. Captions
 * count because a long caption is still typed.
 *
 * @param {object} message Baileys message content
 * @returns {string}
 */
export const extractText = (message) => {
    if (!message || typeof message !== 'object') {
        return ''
    }

    const direct = message.conversation ?? message.extendedTextMessage?.text

    if (typeof direct === 'string') {
        return direct
    }

    for (const type of ['imageMessage', 'videoMessage', 'documentMessage']) {
        const caption = message[type]?.caption

        if (typeof caption === 'string') {
            return caption
        }
    }

    return ''
}

/**
 * Roughly how long a person would take to type this message.
 *
 * @param {object} message Baileys message content
 * @param {object} [options] overrides for `TYPING_DEFAULTS`
 */
export const typingDurationFor = (message, options = {}) => {
    const { base, perCharacter, min, max } = { ...TYPING_DEFAULTS, ...options }

    return Math.round(clamp(base + extractText(message).length * perCharacter, min, max))
}

/**
 * Values that mean "send no indicator at all".
 *
 * `0` is in here on purpose: an indicator cleared the instant it appears is the
 * flicker this module exists to avoid, so a caller passing a zeroed-out delay
 * should get no indicator rather than a bad one. The string forms are what a
 * form post or query string produces.
 */
const OFF = new Set([false, 0, '', 'false', '0'])

/**
 * Normalise the `typing` option into a duration in milliseconds.
 *
 * Accepts `true` (derive from the message), a number of milliseconds, a
 * `{ duration }` object, or the string equivalents that a form post produces.
 * Returns `null` when no indicator should be sent at all.
 *
 * @param {unknown} value
 * @param {object} message Baileys message content
 * @param {object} [options] overrides for `TYPING_DEFAULTS`
 * @returns {number|null}
 */
export const resolveTypingDuration = (value, message, options = {}) => {
    if (value === undefined || value === null || OFF.has(value)) {
        return null
    }

    if (value === true || value === 'true') {
        return typingDurationFor(message, options)
    }

    const duration = Number(typeof value === 'object' ? value.duration : value)

    if (!Number.isFinite(duration)) {
        return null
    }

    return Math.round(clamp(duration, 0, MAX_TYPING_MS))
}
