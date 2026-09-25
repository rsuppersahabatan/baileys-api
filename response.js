/**
 * Write the single response envelope the whole API uses.
 *
 * Guarded against `headersSent` because several flows (QR handshake, reconnect,
 * session creation) can race to answer the same request; the first answer wins
 * instead of crashing with `ERR_HTTP_HEADERS_SENT`.
 */
const response = (res, statusCode = 200, success = false, message = '', data = {}) => {
    if (res.headersSent) {
        return
    }

    res.status(statusCode).json({
        success,
        message,
        data,
    })
}

export default response
