import fs from 'fs'

const isUrlValid = (url) => {
    return Boolean(
        /^(?:(?:(?:https?|ftp):)\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(
            url,
        ),
    )
}

const fileExists = (path) => {
    return typeof path === 'string' && fs.existsSync(path)
}

/**
 * Check the `url` of a media message before it is handed to WhatsApp, which
 * accepts either a public URL or a path to a local file.
 *
 * @param {object} message    the `message` body sent to the API
 * @param {string[]} mediaTypes message keys that carry media (`image`, `video`, …)
 * @returns {string|null} the reason it is invalid, or `null` when it is fine
 */
const validateMediaUrl = (message, mediaTypes) => {
    const mediaType = Object.keys(message ?? {}).find((key) => mediaTypes.includes(key))

    if (!mediaType) {
        return null
    }

    const { url } = message[mediaType] ?? {}

    if (typeof url !== 'string' || url.length === 0) {
        return 'The URL is invalid or empty.'
    }

    if (!isUrlValid(url) && !fileExists(url)) {
        return 'The file or url does not exist.'
    }

    return null
}

export { isUrlValid, fileExists, validateMediaUrl }
