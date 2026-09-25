export const USER_SUFFIX = '@s.whatsapp.net'
export const GROUP_SUFFIX = '@g.us'

export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith(GROUP_SUFFIX)

/**
 * Normalise a phone number or an already-formed JID into a user JID.
 * Anything that already looks like a JID is passed through untouched so device
 * suffixes (`628123:5@s.whatsapp.net`) survive.
 */
export const toUserJid = (value) => {
    const input = String(value ?? '')

    if (input.endsWith(USER_SUFFIX)) {
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

export const toJid = (value, isGroup = false) => {
    return isGroup ? toGroupJid(value) : toUserJid(value)
}

/** Bare phone number of a JID, without the device suffix or the server part. */
export const phoneFromJid = (jid) => {
    return String(jid ?? '')
        .split('@')[0]
        .split(':')[0]
}
