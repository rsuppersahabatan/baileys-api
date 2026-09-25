import cors from 'cors'
import express from 'express'
import nodeCleanup from 'node-cleanup'
import { config } from './config.js'
import routes from './routes.js'
import { cleanup, restoreSessions } from './whatsapp/session.js'

const app = express()

app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use('/', routes)

app.listen(config.port, config.host, () => {
    // Recover the sessions that still have credentials on disk before serving
    // traffic, otherwise their stored chats would never be reloaded.
    restoreSessions()

    console.log(`Server is listening on http://${config.host ?? 'localhost'}:${config.port}`)
})

// `nodeCleanup` keeps the process alive while the stores are flushed to disk.
nodeCleanup((exitCode, signal) => {
    cleanup()
        .catch((error) => console.error(`Cleanup failed: ${error.message}`))
        .finally(() => {
            nodeCleanup.uninstall()
            process.kill(process.pid, signal)
        })

    return false
})

export default app
