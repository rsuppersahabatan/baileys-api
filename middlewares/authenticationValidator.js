import response from './../response.js'
import { config } from './../config.js'

const validate = (req, res, next) => {
    if (!config.authToken) {
        return next()
    }

    const apiKey = req.get('apikey') ?? req.query.apikey

    if (apiKey !== config.authToken) {
        return response(res, 401, false, 'Authentication failed.')
    }

    next()
}

export default validate
