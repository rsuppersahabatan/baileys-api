import { downloadMediaMessage } from '@innovatorssoft/baileys'

/** Message types whose payload carries downloadable media. */
export const MEDIA_MESSAGE_TYPES = ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage']

/**
 * Fields inside a media message that are raw bytes in the protobuf but cannot
 * survive `JSON.stringify` when the webhook payload is serialized.
 */
const BINARY_MEDIA_FIELDS = [
    'fileEncSha256',
    'mediaKey',
    'fileSha256',
    'jpegThumbnail',
    'thumbnailSha256',
    'thumbnailEncSha256',
    'streamingSidecar',
]

/** Name of the single property of a `proto.IMessage` (e.g. `imageMessage`). */
export const messageTypeOf = (message) => Object.keys(message?.message ?? {})[0]

const toBase64 = (bytes) => Buffer.from(new Uint8Array(bytes)).toString('base64')

const isMediaMessage = (message) => MEDIA_MESSAGE_TYPES.includes(messageTypeOf(message))

/**
 * Download the media of a message and describe it.
 *
 * @returns {Promise<{messageType: string, fileName: string, caption: string, size: object, mimetype: string, base64: string}>}
 */
export const downloadMessageMedia = async (socket, message) => {
    const messageType = messageTypeOf(message)
    const media = message.message[messageType]
    const buffer = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: socket.updateMediaMessage })

    return {
        messageType,
        fileName: media.fileName ?? '',
        caption: media.caption ?? '',
        size: {
            fileLength: media.fileLength,
            height: media.height ?? 0,
            width: media.width ?? 0,
        },
        mimetype: media.mimetype,
        base64: buffer.toString('base64'),
    }
}

/**
 * Return a copy of `message` with its binary media fields replaced by base64 and
 * the downloaded payload attached as `fileBase64`, so the whole thing can be
 * posted to the webhook as JSON.
 */
export const attachBase64Media = async (socket, message) => {
    const messageType = messageTypeOf(message)
    const media = { ...message.message[messageType] }

    for (const field of BINARY_MEDIA_FIELDS) {
        if (media[field] !== undefined) {
            media[field] = toBase64(media[field])
        }
    }

    const { base64 } = await downloadMessageMedia(socket, message)

    return {
        ...message,
        message: {
            [messageType]: { ...media, fileBase64: base64 },
        },
    }
}

export { isMediaMessage }
