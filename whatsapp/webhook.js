import axios from 'axios'
import { config } from '../config.js'

const isAllowed = (eventType) => {
    const { allowedEvents } = config.webhook

    return allowedEvents.includes('ALL') || allowedEvents.includes(eventType)
}

/**
 * Push a WhatsApp event to the configured webhook.
 *
 * Silently does nothing when no webhook is configured or the event is not part
 * of `APP_WEBHOOK_ALLOWED_EVENTS`. Delivery failures are logged rather than
 * thrown: a broken webhook endpoint must never take the socket down.
 */
export const notify = async (sessionId, eventType, data) => {
    if (!config.webhook.url || !isAllowed(eventType)) {
        return
    }

    try {
        await axios.post(config.webhook.url, {
            instance: sessionId,
            type: eventType,
            data,
        })
    } catch (error) {
        console.error(`Webhook delivery failed for "${eventType}": ${error.message}`)
    }
}
