export const USER_SUFFIX = '@s.whatsapp.net'
export const GROUP_SUFFIX = '@g.us'

/**
 * LIDs are WhatsApp's per-user identifiers that replace phone numbers as the
 * primary addressing scheme. They are opaque numbers, so nothing about them can
 * be derived from a phone number and vice versa — they only ever arrive from
 * WhatsApp (a lookup, a message, a group participant).
 */
export const LID_SUFFIX = '@lid'

export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith(GROUP_SUFFIX)

export const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith(LID_SUFFIX)

/**
 * Normalise a phone number or an already-formed JID into a user JID.
 * Anything that already looks like a JID is passed through untouched so device
 * suffixes (`628123:5@s.whatsapp.net`) and LIDs survive — a LID is a complete
 * identifier, and stripping it to digits would turn it into a wrong phone
 * number rather than an error.
 */
export const toUserJid = (value) => {
    const input = String(value ?? '')

    if (input.endsWith(USER_SUFFIX) || input.endsWith(LID_SUFFIX)) {
        return input
    }

    return `${input.replace(/\D/g, '')}${USER_SUFFIX}`
}

/**
 * Normalise a group id into a group JID. Hyphens are kept because they are part
 * of a group id (`1234567890-1612345678@g.us`).
 */
export const toGroupJid = (value) => {
    const input = String(value ?? '')

    if (input.endsWith(GROUP_SUFFIX)) {
        return input
    }

    return `${input.replace(/[^\d-]/g, '')}${GROUP_SUFFIX}`
}

/** Normalise an opaque LID number or an already-formed LID JID. */
export const toLidJid = (value) => {
    const input = String(value ?? '')

    if (input.endsWith(LID_SUFFIX)) {
        return input
    }

    return `${input.replace(/\D/g, '')}${LID_SUFFIX}`
}

export const toJid = (value, isGroup = false) => {
    if (isLidJid(value)) {
        return toLidJid(value)
    }

    return isGroup ? toGroupJid(value) : toUserJid(value)
}

/** Bare phone number of a JID, without the device suffix or the server part. */
export const phoneFromJid = (jid) => {
    return String(jid ?? '')
        .split('@')[0]
        .split(':')[0]
}
