import { mkdir, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

/**
 * Downloads land in the OS temp directory rather than the project directory:
 * they only exist to be handed to Baileys, and the previous `./uploads/profile`
 * path was never created, so every profile picture update failed silently.
 */
const UPLOAD_DIR = join(tmpdir(), 'baileys-api-uploads')

/** Download `url` into a temporary file and return its path. */
const downloadToTempFile = async (url, extension = 'jpg') => {
    await mkdir(UPLOAD_DIR, { recursive: true })

    const filePath = join(UPLOAD_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`)
    const { data } = await axios.get(url, { responseType: 'arraybuffer' })

    await writeFile(filePath, Buffer.from(data))

    return filePath
}

/** Best-effort removal — a leftover temp file is not worth failing a request over. */
const removeFile = async (filePath) => {
    try {
        await unlink(filePath)
    } catch {
        // Already gone.
    }
}

export { downloadToTempFile, removeFile }
