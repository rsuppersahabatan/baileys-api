const BASE_URI = 'http://localhost:8000/'
const SESSION_ID = 'john'

const sendRequest = async (endpoint, data) => {
    // Here we are using fetch API to send the request
    const response = await fetch(`${BASE_URI}${endpoint}?id=${SESSION_ID}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json',
        },
    })

    return response.json()
}

;(async () => {
    // Send Text Message to Someone
    await sendRequest('chats/send', {
        receiver: '628231xxxxx',
        message: {
            text: 'Hello there!',
        },
    })

    // Send Bulk Text Message to Multiple Person
    await sendRequest('chats/send-bulk', [
        {
            receiver: '628231xxxxx',
            message: {
                text: 'Hello! How are you?',
            },
        },
        {
            receiver: '628951xxxxx',
            message: {
                text: "I'm fine, thank you.",
            },
        },
    ])

    // Send Text Message to a Group. The group id goes in the path, not only in
    // the body — the route is `groups/send/:jid`.
    await sendRequest('groups/send/628950xxxxx-1631xxxxx', {
        receiver: '628950xxxxx-1631xxxxx',
        message: {
            text: 'Hello guys!',
        },
    })
})()
