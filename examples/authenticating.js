const BASE_URI = 'http://localhost:8000/'
const SESSION_ID = 'john'

const addSession = async (typeAuth, phoneNumber) => {
    // Here we are using fetch API to send the request
    const response = await fetch(`${BASE_URI}sessions/add`, {
        method: 'POST',
        body: JSON.stringify({
            id: SESSION_ID,
            // 'qr' (default) returns a QR code to scan, 'code' returns an 8 digit
            // pairing code instead and requires `phoneNumber`.
            typeAuth,
            phoneNumber,
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    })

    return response.json()
}

;(async () => {
    const response = await addSession('qr')

    // The QR arrives as a data URL on `data.qrcode`, ready to drop into an <img>.
    if (response.success && response.data.qrcode) {
        console.log(response.data.qrcode)
    } else {
        console.error(response.message)
    }
})()
